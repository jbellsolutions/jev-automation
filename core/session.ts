/** One conversation with one surface: the command → decide → gate → execute loop, plus the
 *  confirm/clarify questions it may leave open. Pure orchestration: no transport, no timers.
 *  Every observable event is emitted as a ServerMessage; hosts (WebSocket hub, HTTP, MCP)
 *  subscribe and forward. Work is serialized per session so replies can't overtake commands. */
import { type Action, describeAction } from "./actions.js";
import { type ApprovalChoice, type Brain, type BrainRun, approvalChoice } from "./brain.js";
import { parseOrdinal, splitSteps } from "./commands.js";
import { isResetCommand, isStopWord } from "./route.js";
import type { Decider, Decision } from "./decide.js";
import type { PageSnapshot } from "./elements.js";
import type { Executor } from "./executor.js";
import { MAX_SPOKEN, type Speaker, clipSpoken, spokenPart, spokenSummary } from "./speak.js";
import type { DecisionSummary, ServerMessage, StepInfo, VerifySummary } from "./protocol.js";
import type { CommandResult, PendingSummary, SessionStatus, StatusLevel, StepResult } from "./results.js";
import { type VerifyResult, describeVerify } from "./verify.js";

/** A question the browser lane left open. Set and cleared inside the command queue. */
export type Pending =
  | { kind: "confirm"; action: Action; label: string; reason: string; before: PageSnapshot; command: string }
  | { kind: "clarify"; decision: Decision; before: PageSnapshot; command: string }
  | null;

/** The brain asked before doing something; its run waits until a human answers. Lives in its
 *  own slot because it arrives outside the queue and must never clobber (or be clobbered by)
 *  a browser question. A spoken yes/no answers the browser question first; the approval is
 *  spoken once nothing else is waiting. */
export interface ApprovalPending {
  runId: string;
  requestId: string | null;
  summary: string;
  choices: ApprovalChoice[];
}

/** The brain run in progress, if any. Runs outside the command queue so browser commands and
 *  spoken approvals keep flowing while the agent works. */
interface BrainState {
  id: string;
  stepId: number;
  voice: boolean;
  /** What was sent, for a retry. */
  text: string;
  /** 1 = first run for this utterance; a model error re-sends up to MAX_ATTEMPTS times. */
  attempt: number;
  /** Tools the run has started, in order: once one has, a failed run is not re-sent. */
  tools: string[];
  done: Promise<BrainOutcome>;
  resolve: (o: BrainOutcome) => void;
}

/** A run that fails with a model-provider error before any tool ran is re-sent: once on the
 *  same conversation (the provider's errors are mostly transient), then once on a fresh one. */
const MAX_ATTEMPTS = 3;
/** Model failures in a row before the conversation is rotated (its history is then suspect). */
const ROTATE_AFTER_MODEL_FAILURES = 2;
const RETRY_DELAY_MS = 1500;

export interface BrainOutcome {
  ok: boolean;
  output: string;
}

/** The Mac lane before the accessibility executor exists: just launching applications. */
export interface Computer {
  openApp(app: string): Promise<string>;
}

/** The rest of a multi-step utterance, parked while a confirm/clarify question is open. */
interface Continuation {
  original: string;
  commands: string[];
  /** Index of the step that raised the question; resume from index + 1. */
  index: number;
}

export interface SessionDeps {
  executor: Executor;
  decider: Decider;
  /** Called after every action that may have changed the surface (a host pushes a frame). */
  afterAction?: () => void | Promise<void>;
  /** "off": never check outcomes. Sequences always check (blocking); single commands check
   *  in the background so they stay as fast as before. */
  verify?: "on" | "off";
  /** Spoken replies for commands that arrive by voice. */
  speaker?: Speaker | null;
  /** The agent behind the `hermes` route. Without one, such commands fall back to the browser
   *  action Jev also decided, or to a warning. */
  brain?: Brain | null;
  computer?: Computer | null;
  /** Pause before re-sending a failed brain run (tests shorten it). */
  retryDelayMs?: number;
}

export function summarize(d: Decision): DecisionSummary {
  return {
    command: d.command,
    intent: d.intent,
    intentConfidence: d.intentConfidence,
    route: d.route,
    routeConfidence: d.routeConfidence,
    action: d.action,
    actionLabel: d.clarify ? d.clarify.question : describeAction(d.action),
    source: d.source,
    model: d.meta.model,
    latencyMs: d.meta.latencyMs,
    inputTokens: d.meta.inputTokens,
    targetConfidence: d.targetConfidence ?? undefined,
    alternatives: d.alternatives.length ? d.alternatives : undefined,
    risky: d.riskProbability,
  };
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class Session {
  pending: Pending = null;
  approval: ApprovalPending | null = null;
  private continuation: Continuation | null = null;
  private brain: BrainState | null = null;
  /** Consecutive brain runs that ended in a model error; reset by any other outcome. */
  private modelFailures = 0;
  private nextStepId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private inFlight: AbortController | null = null;
  private busy = false;
  private readonly listeners = new Set<(msg: ServerMessage) => void>();

  constructor(
    readonly id: string,
    private readonly deps: SessionDeps,
  ) {}

  get executor(): Executor {
    return this.deps.executor;
  }

  get decider(): Decider {
    return this.deps.decider;
  }

  subscribe(fn: (msg: ServerMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(msg: ServerMessage): void {
    for (const fn of this.listeners) fn(msg);
  }

  /** Announce a step and hand back its result skeleton. */
  private ack(command: string, info?: StepInfo): StepResult {
    const stepId = this.nextStepId++;
    this.emit(info ? { type: "transcript_ack", text: command, stepId, step: info } : { type: "transcript_ack", text: command, stepId });
    return { stepId, command, decision: null, result: null };
  }

  private report(text: string, level: StatusLevel = "info"): { text: string; level: StatusLevel } {
    this.emit({ type: "status", text, level });
    return { text, level };
  }

  /** Serialize work per session. The queue itself never rejects; callers that await the
   *  returned promise still see the task's own rejection. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      this.busy = true;
      try {
        return await task();
      } finally {
        this.busy = false;
      }
    });
    this.queue = run.catch((err) => this.report(errMsg(err), "error"));
    return run;
  }

  /** The browser question, else the brain's approval request. */
  pendingSummary(): PendingSummary {
    return this.localPendingSummary() ?? this.approvalSummary();
  }

  private localPendingSummary(): PendingSummary {
    const p = this.pending;
    if (!p) return null;
    if (p.kind === "confirm") return { kind: "confirm", actionLabel: p.label, reason: p.reason };
    const c = p.decision.clarify;
    return c ? { kind: "clarify", question: c.question, options: c.options } : null;
  }

  private approvalSummary(): PendingSummary {
    const a = this.approval;
    return a ? { kind: "approval", question: Session.approvalQuestion(a.summary), choices: a.choices } : null;
  }

  async page(): Promise<{ url: string; title: string }> {
    return { url: this.executor.url, title: await this.executor.title() };
  }

  async status(): Promise<SessionStatus> {
    const page = await this.page();
    return { id: this.id, kind: this.executor.kind, ...page, busy: this.busy, pending: this.pendingSummary(), capabilities: this.executor.capabilities, ready: this.executor.ready !== false };
  }

  /** A spoken or typed command. Resolves when the command has been acted on or has left a
   *  question open; never rejects. With `speak`, the outcome is also read aloud. With `local`,
   *  the brain is never consulted — for callers that are the brain (its jev_browse tool), so a
   *  request can't bounce back into a second run. */
  command(text: string, opts: { speak?: boolean; local?: boolean } = {}): Promise<CommandResult> {
    return this.voiced(
      this.enqueue(() => this.withAwaitedVerify(!!opts.speak, () => this.withLocalOnly(!!opts.local, () => this.handleCommand(text)))),
      opts.speak,
    );
  }

  private localOnly = false;
  private async withLocalOnly<T>(on: boolean, task: () => Promise<T>): Promise<T> {
    const prev = this.localOnly;
    this.localOnly = on;
    try {
      return await task();
    } finally {
      this.localOnly = prev;
    }
  }

  /** The brain, unless this command must stay local. */
  private get brainFor(): Brain | null {
    return this.localOnly ? null : (this.deps.brain ?? null);
  }

  /** A command whose answer the caller wants in full: when it reaches the brain, resolves with
   *  the run's final output instead of the "on it" acknowledgement. */
  async ask(text: string, opts: { speak?: boolean } = {}): Promise<CommandResult & { output: string }> {
    const r = await this.command(text, opts);
    const run = this.brain;
    const started = r.steps.find((s) => run && s.stepId === run.stepId);
    if (!run || !started) return { ...r, output: spokenSummary(r, this.maxSpoken) };
    const outcome = await run.done;
    return { ...r, ok: r.ok && outcome.ok, output: outcome.output };
  }

  /** Set while a task runs whose caller needs the outcome check in the result (a voice user
   *  is waiting to hear it), so single commands verify before resolving instead of in the background.
   *  Doubles as "this command came by voice": the brain lane then speaks its acknowledgement and answer. */
  private awaitVerify = false;
  private async withAwaitedVerify<T>(on: boolean, task: () => Promise<T>): Promise<T> {
    const prev = this.awaitVerify;
    this.awaitVerify = on;
    try {
      return await task();
    } finally {
      this.awaitVerify = prev;
    }
  }

  private voiced(result: Promise<CommandResult>, speak: boolean | undefined): Promise<CommandResult> {
    if (!speak || !this.deps.speaker) return result;
    return result.then((r) => {
      this.say(spokenSummary(r, this.maxSpoken));
      return r;
    });
  }

  /** How much of an answer is read aloud: the voice decides (a robotic voice earns a shorter cut). */
  private get maxSpoken(): number {
    return this.deps.speaker?.maxChars ?? MAX_SPOKEN;
  }

  private speakingRun = 0;
  /** Read `text` aloud, interrupting anything still being said. UIs get `speaking` so they can
   *  mute the microphone while the assistant talks. */
  say(text: string): void {
    const speaker = this.deps.speaker;
    if (!speaker || !text) return;
    const run = ++this.speakingRun;
    this.emit({ type: "speaking", active: true });
    speaker
      .speak(text)
      .catch(() => {})
      .finally(() => {
        if (run === this.speakingRun) this.emit({ type: "speaking", active: false });
      });
  }

  /** Answer to a pending confirmation from a UI control (as opposed to a spoken reply). */
  reply(ok: boolean, opts: { speak?: boolean } = {}): Promise<CommandResult> {
    return this.voiced(this.replyInner(ok, !!opts.speak), opts.speak);
  }

  private replyInner(ok: boolean, awaitVerify: boolean): Promise<CommandResult> {
    return this.enqueue(() => this.withAwaitedVerify(awaitVerify, async () => {
      const pending = this.pending?.kind === "confirm" ? this.pending : null;
      const rest = this.takeContinuation();
      this.pending = null;
      const step = this.ack(ok ? "yes" : "no");
      if (!pending) return this.finish([step]);
      if (!ok) {
        step.result = this.report(`Cancelled: ${pending.label}`, "warn");
        return this.finish([step]);
      }
      await this.runHeld(step, pending.action, pending.before, rest !== null);
      return this.resume([step], rest);
    }));
  }

  /** Answer to a brain approval request from a UI control. */
  approve(choice: ApprovalChoice): Promise<CommandResult> {
    return this.enqueue(async () => {
      const pending = this.approval;
      const step = this.ack(choice === "deny" ? "no" : `yes (${choice})`);
      if (!pending || !this.deps.brain) return this.finish([step]);
      await this.resolveApproval(step, pending, choice);
      return this.finish([step]);
    });
  }

  private async resolveApproval(step: StepResult, pending: ApprovalPending, choice: ApprovalChoice): Promise<void> {
    if (this.approval === pending) this.approval = null;
    try {
      await this.deps.brain!.approve(pending.runId, choice, pending.requestId);
      step.result = choice === "deny" ? this.report(`Denied: ${pending.summary}`, "warn") : this.report(`Allowed: ${pending.summary}`, "ok");
    } catch (err) {
      step.result = this.report(`Couldn't answer Hermes: ${errMsg(err)}`, "error");
    }
  }

  /** A clarification option chosen from a UI control. */
  pick(elementId: string, opts: { speak?: boolean } = {}): Promise<CommandResult> {
    return this.voiced(this.pickInner(elementId, !!opts.speak), opts.speak);
  }

  private pickInner(elementId: string, awaitVerify: boolean): Promise<CommandResult> {
    return this.enqueue(() => this.withAwaitedVerify(awaitVerify, async () => {
      const pending = this.pending?.kind === "clarify" ? this.pending : null;
      const opt = pending?.decision.clarify?.options.find((o) => o.elementId === elementId);
      const rest = this.takeContinuation();
      this.pending = null;
      const step = this.ack(`pick ${elementId}`);
      if (!pending || !opt) return this.finish([step]);
      await this.runHeld(step, { kind: "click", elementId: opt.elementId, label: opt.label }, pending.before, rest !== null);
      return this.resume([step], rest);
    }));
  }

  /** Click on the live view; fx/fy are fractions of the frame. */
  clickAt(fx: number, fy: number): Promise<void> {
    return this.enqueue(async () => {
      if (!Number.isFinite(fx) || !Number.isFinite(fy) || !this.executor.capabilities.clickAt) return;
      const { width, height } = this.executor.viewport;
      const x = Math.round(Math.min(1, Math.max(0, fx)) * width);
      const y = Math.round(Math.min(1, Math.max(0, fy)) * height);
      await this.runAction({ kind: "click_at", x, y });
    });
  }

  setViewport(width: number, height: number): Promise<boolean> {
    return this.enqueue(async () => {
      if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
      if (!(await this.executor.setViewport(width, height))) return false;
      this.emit({ type: "viewport", ...this.executor.viewport });
      await this.deps.afterAction?.();
      return true;
    });
  }

  /** Stop talking, now; the microphone reopens at once. Nothing else is touched. */
  interrupt(): void {
    if (!this.deps.speaker) return;
    this.speakingRun++; // the cut-off utterance's own "finished" is then ignored
    this.deps.speaker.stop();
    this.emit({ type: "speaking", active: false });
  }

  /** Drop whatever is in flight or pending. Bypasses the queue on purpose. */
  cancel(): void {
    this.deps.speaker?.stop();
    this.inFlight?.abort();
    this.pending = null;
    this.continuation = null;
    this.stopBrain();
    this.report("Stopped", "ok");
  }

  private stopping = new Set<string>();
  /** Ask the brain to stop its run (once per run); the run's own cancelled event clears state. */
  private stopBrain(): void {
    const run = this.brain;
    if (!run || !this.deps.brain || this.stopping.has(run.id)) return;
    this.stopping.add(run.id);
    this.approval = null;
    this.deps.brain.stop(run.id).catch((err) => this.report(`Couldn't stop ${this.deps.brain?.name ?? "the brain"}: ${errMsg(err)}`, "warn"));
  }

  private async finish(steps: StepResult[], stoppedAt?: number): Promise<CommandResult> {
    const local = this.localPendingSummary();
    // a parked brain approval does not make this command incomplete, but it is the question
    // the caller should hear next
    const ok = local === null && steps.length > 0 && stoppedAt === undefined && steps.every((s) => s.result?.level === "ok" && !s.verify?.stuck);
    const result: CommandResult = { ok, steps, page: await this.page(), pending: local ?? this.approvalSummary() };
    if (stoppedAt !== undefined) result.stoppedAt = stoppedAt;
    return result;
  }

  private async runAction(action: Action): Promise<{ text: string; level: StatusLevel; error: string | null }> {
    this.report(describeAction(action) + "…", "busy");
    let outcome: { text: string; level: StatusLevel; error: string | null };
    try {
      outcome = { ...this.report(await this.executor.execute(action), "ok"), error: null };
    } catch (err) {
      outcome = { ...this.report(errMsg(err), "error"), error: errMsg(err) };
    }
    await this.deps.afterAction?.();
    return outcome;
  }

  private static summarizeVerify(v: VerifyResult): VerifySummary {
    return { done: v.done, stuck: v.stuck, doneProbability: v.doneProbability, blocker: v.blocker, source: v.source, latencyMs: v.meta.latencyMs, text: describeVerify(v) };
  }

  /** Check a step's outcome against a fresh snapshot; never throws. */
  private async verifyStep(step: StepResult, action: Action, before: PageSnapshot, error: string | null): Promise<VerifySummary | null> {
    if (this.deps.verify === "off") return null;
    try {
      const after = await this.executor.snapshot();
      const v = await this.decider.verify({ command: step.command, expectation: null, action, before, after, error });
      const summary = Session.summarizeVerify(v);
      step.verify = summary;
      this.emit({ type: "verify", stepId: step.stepId, command: step.command, verify: summary });
      if (v.meta.fallbackReason) this.report(`Jev unavailable for verification (${v.meta.fallbackReason}); used heuristics`, "warn");
      return summary;
    } catch (err) {
      this.report(`Verification failed: ${errMsg(err)}`, "warn");
      return null;
    }
  }

  private takeContinuation(): Continuation | null {
    const c = this.continuation;
    this.continuation = null;
    return c;
  }

  /** After a held action ran, carry on with the steps parked behind the question. */
  private async resume(steps: StepResult[], rest: Continuation | null): Promise<CommandResult> {
    const last = steps[steps.length - 1];
    const failed = last?.result?.level === "error" || !!last?.verify?.stuck;
    if (failed || !rest) return this.finish(steps, failed && rest ? steps.length - 1 : undefined);
    return this.runSteps(rest.original, rest.commands, rest.index + 1, steps);
  }

  /** Run an action that was waiting on a question, then check it like any other step. */
  private async runHeld(step: StepResult, action: Action, before: PageSnapshot, inSequence: boolean): Promise<void> {
    const blocking = inSequence || this.awaitVerify;
    const outcome = await this.runAction(action);
    step.result = { text: outcome.text, level: outcome.level };
    if (blocking) await this.verifyStep(step, action, before, outcome.error);
    else this.verifySoon(step, action, before, outcome.error);
  }

  /** Verify after the current task, still inside the queue: a snapshot re-tags element ids,
   *  so it must never interleave with another command's snapshot → execute. */
  private verifySoon(step: StepResult, action: Action, before: PageSnapshot, error: string | null): void {
    this.enqueue(() => this.verifyStep(step, action, before, error)).catch(() => {});
  }

  private async handleCommand(text: string): Promise<CommandResult> {
    const trimmed = text.trim();
    if (!trimmed) return this.finish([]);

    // "stop" always wins: it halts the brain run outright rather than answering a question
    if (isStopWord(trimmed)) this.stopBrain();

    if (this.brainFor && isResetCommand(trimmed)) return this.finish([await this.resetBrain(trimmed)]);

    if (this.approval && !this.pending && this.brainFor && !isStopWord(trimmed)) {
      // a yes/no answers the agent; anything else is a new command and the request stays open
      const pending = this.approval;
      const reply = await this.decider.classifyReply(trimmed, pending.summary);
      if (reply === "confirm" || reply === "cancel") {
        const step = this.ack(trimmed);
        await this.resolveApproval(step, pending, approvalChoice(reply, trimmed, pending.choices));
        return this.finish([step]);
      }
    }
    if (this.pending?.kind === "confirm") {
      const pending = this.pending;
      const reply = await this.decider.classifyReply(trimmed, pending.label);
      if (reply === "confirm" || reply === "cancel") {
        const rest = this.takeContinuation();
        this.pending = null;
        const step = this.ack(trimmed);
        if (reply === "cancel") {
          step.result = this.report(`Cancelled: ${pending.label}`, "warn");
          return this.finish([step]);
        }
        await this.runHeld(step, pending.action, pending.before, rest !== null);
        return this.resume([step], rest);
      }
      this.pending = null; // a new command supersedes the question and whatever was queued behind it
      this.continuation = null;
    }
    if (this.pending?.kind === "clarify") {
      const pending = this.pending;
      const opts = pending.decision.clarify?.options ?? [];
      const idx = parseOrdinal(trimmed);
      const picked = idx !== null ? opts[idx] : undefined;
      const rest = this.takeContinuation();
      this.pending = null;
      if (picked) {
        const step = this.ack(trimmed);
        await this.runHeld(step, { kind: "click", elementId: picked.elementId, label: picked.label }, pending.before, rest !== null);
        return this.resume([step], rest);
      }
    }

    const commands = splitSteps(trimmed);
    if (commands.length === 0) return this.finish([]);
    if (commands.length > 1) {
      // route the whole utterance first: "find 20 dentists and put them in a sheet" is one
      // task for the brain, not two browser steps
      const decision = await this.decide(trimmed, null);
      if (decision && !this.fastLane(decision)) {
        const step = this.ack(trimmed);
        this.announce(step, decision);
        return this.finish([await this.runStep(step, this.awaitVerify ? "blocking" : "async", decision, trimmed)]);
      }
      this.emit({ type: "steps", original: trimmed, commands });
    }
    return this.runSteps(trimmed, commands, 0, []);
  }

  /** Browser steps run one at a time on the fast lane; everything else is handled whole. */
  private fastLane(d: Decision): boolean {
    if (d.route === "stop" || d.route === "computer") return false;
    if (d.route === "hermes" || d.route === "unclear") return !this.brainFor;
    return true;
  }

  /** Run commands[from..] in order. A question parks the remainder; an error or a
   *  non-command stops the sequence. */
  private async runSteps(original: string, commands: string[], from: number, steps: StepResult[]): Promise<CommandResult> {
    const total = commands.length;
    for (let i = from; i < total; i++) {
      const command = commands[i]!;
      const info: StepInfo | undefined = total > 1 ? { index: i, total, original } : undefined;
      const step = await this.runStep(this.ack(command, info), total > 1 || this.awaitVerify ? "blocking" : "async", undefined, total === 1 ? original : undefined, total > 1);
      steps.push(step);
      if (step.verify?.stuck) {
        if (i + 1 < total) this.report(`Stopped after step ${i + 1} of ${total}: ${step.verify.text}`, "warn");
        return this.finish(steps, steps.length - 1);
      }
      if (this.pending) {
        this.continuation = i + 1 < total ? { original, commands, index: i } : null;
        return this.finish(steps, i + 1 < total ? steps.length - 1 : undefined);
      }
      if (step.decision?.action.kind === "stop") return this.finish(steps, steps.length - 1);
      const failed = !step.result || step.result.level === "error" || step.result.level === "warn";
      if (failed) {
        if (i + 1 < total) this.report(`Stopped after step ${i + 1} of ${total}: ${step.result?.text ?? "no result"}`, "warn");
        return this.finish(steps, steps.length - 1);
      }
    }
    return this.finish(steps);
  }

  /** Snapshot taken for the most recent decision; the step that acts on it runs right after. */
  private lastSnapshot: PageSnapshot | null = null;

  /** Decide a command against a fresh snapshot. Returns null on failure, which is reported on
   *  `step` when there is one. */
  private async decide(command: string, step: StepResult | null, pinBrowser = false): Promise<Decision | null> {
    if (step) this.report("Thinking…", "busy");
    this.inFlight?.abort();
    const controller = (this.inFlight = new AbortController());
    const snapshot = (this.lastSnapshot = await this.executor.snapshot());
    let decision: Decision;
    try {
      decision = await this.decider.decide(command, snapshot, controller.signal);
    } catch (err) {
      const outcome = controller.signal.aborted ? this.report("Cancelled", "warn") : this.report(errMsg(err), "error");
      if (step) step.result = outcome;
      return null;
    }
    // a step of an utterance already routed to the browser stays there: "search for cats" on
    // its own may read as a question, but here it is the second half of a page sequence
    if (pinBrowser && (decision.route === "hermes" || decision.route === "unclear") && decision.action.kind !== "none") decision.route = "browser_now";
    if (step) this.announce(step, decision);
    return decision;
  }

  private announce(step: StepResult, decision: Decision): void {
    step.decision = summarize(decision);
    if (decision.route === "hermes" && this.brainFor) step.decision.actionLabel = `Ask ${this.brainFor.name}`;
    this.emit({ type: "decision", decision: step.decision });
    if (decision.meta.fallbackReason) this.report(`Jev unavailable (${decision.meta.fallbackReason}); used heuristics`, "warn");
  }

  /** One command: decide (unless already decided), gate, execute, check. May leave `pending` set. */
  private async runStep(step: StepResult, verifyMode: "blocking" | "async", decided?: Decision, raw?: string, pinBrowser = false): Promise<StepResult> {
    const command = step.command;
    const decision = decided ?? (await this.decide(command, step, pinBrowser));
    if (!decision) return step;
    const snapshot = this.lastSnapshot!;
    // the brain gets what was actually said (case, names), not the normalised browser form
    const said = raw ?? command;

    if (decision.route === "stop" || decision.action.kind === "stop") {
      this.pending = null;
      this.continuation = null;
      this.stopBrain();
      step.result = this.report("Stopped", "ok");
      return step;
    }
    // with a brain there are no dead ends: half-heard fragments go to it too, it can ask back —
    // unless it is busy: then a fragment is more likely room noise than a steer, and is dropped
    if (decision.route === "unclear" && this.brainFor && this.brain) {
      step.result = this.report("Didn't catch that; Hermes is still working", "warn");
      return step;
    }
    if ((decision.route === "hermes" || decision.route === "unclear") && this.brainFor) return this.runBrain(step, said);
    if (decision.action.kind === "open_app") {
      if (!this.deps.computer) {
        if (this.brainFor) return this.runBrain(step, said);
        step.result = this.report(`I can't open apps from here yet (${decision.action.app})`, "warn");
        return step;
      }
      const outcome = await this.runComputer(decision.action.app);
      step.result = { text: outcome.text, level: outcome.level };
      return step;
    }
    if (decision.clarify) {
      this.pending = { kind: "clarify", decision, before: snapshot, command };
      this.emit({ type: "clarify", question: decision.clarify.question, options: decision.clarify.options });
      return step;
    }
    if (decision.action.kind === "none") {
      step.result = this.report(decision.route === "hermes" && this.localOnly ? "That needs the assistant, not the browser: ask the user directly" : decision.action.reason, "warn");
      return step;
    }
    if (decision.needsConfirmation) {
      const label = describeAction(decision.action);
      const reason = `This looks hard to undo (risk ${Math.round(decision.riskProbability * 100)}%). Say "yes" or "no".`;
      this.pending = { kind: "confirm", action: decision.action, label, reason, before: snapshot, command };
      this.emit({ type: "confirm", actionLabel: label, reason });
      return step;
    }
    const outcome = await this.runAction(decision.action);
    step.result = { text: outcome.text, level: outcome.level };
    if (verifyMode === "blocking") await this.verifyStep(step, decision.action, snapshot, outcome.error);
    else this.verifySoon(step, decision.action, snapshot, outcome.error);
    return step;
  }

  private async runComputer(app: string): Promise<{ text: string; level: StatusLevel }> {
    this.report(`Opening ${app}…`, "busy");
    try {
      return this.report(await this.deps.computer!.openApp(app), "ok");
    } catch (err) {
      return this.report(errMsg(err), "error");
    }
  }

  static approvalQuestion(summary: string): string {
    return `Hermes wants to ${summary}. Allow it?`;
  }

  /** "new conversation": stop what the brain is doing and give it a clean thread. */
  private async resetBrain(text: string): Promise<StepResult> {
    const brain = this.deps.brain!;
    const step = this.ack(text);
    this.stopBrain();
    this.modelFailures = 0;
    try {
      await brain.reset();
      step.lane = "brain";
      step.result = this.report(`${brain.name}: fresh conversation`, "ok");
      if (this.awaitVerify) this.say("Okay, fresh start.");
    } catch (err) {
      step.result = this.report(`Couldn't reset ${brain.name}: ${errMsg(err)}`, "error");
    }
    return step;
  }

  /** Hand the utterance to the brain. The step resolves as soon as the run is admitted (or
   *  steered into the run already in progress); events stream in afterwards, outside the queue. */
  private async runBrain(step: StepResult, text: string): Promise<StepResult> {
    const brain = this.deps.brain!;
    const voice = this.awaitVerify;
    if (this.brain) {
      try {
        await brain.steer(this.brain.id, text);
        if (voice) this.say("Okay.");
        step.lane = "brain";
        step.result = this.report(`Told ${brain.name}: ${text}`, "ok");
      } catch (err) {
        step.result = this.report(`Couldn't reach ${brain.name}: ${errMsg(err)}`, "error");
      }
      return step;
    }
    this.report(`Asking ${brain.name}…`, "busy");
    if (voice) this.say("On it.");
    let run: BrainRun;
    try {
      run = await brain.send(text);
    } catch (err) {
      step.result = this.report(`${brain.name} unreachable: ${errMsg(err)}`, "error");
      return step;
    }
    let resolve!: (o: BrainOutcome) => void;
    const done = new Promise<BrainOutcome>((r) => (resolve = r));
    const state: BrainState = { id: run.id, stepId: step.stepId, voice, text, attempt: 1, tools: [], done, resolve };
    this.brain = state;
    void this.consumeBrain(run, state);
    step.lane = "brain";
    step.result = this.report(`${brain.name} is on it`, "ok");
    return step;
  }

  /** A model-provider error on a run that had not started any tool: send the same utterance
   *  again — same conversation first, a fresh one after that — with the outcome still owed to
   *  the original step. Returns false when the run is to be given up on. */
  private async retryBrain(state: BrainState, error: string): Promise<boolean> {
    const brain = this.deps.brain;
    if (!brain || state.tools.length || state.attempt >= MAX_ATTEMPTS || this.stopping.has(state.id)) return false;
    const fresh = state.attempt >= 2 || this.modelFailures >= ROTATE_AFTER_MODEL_FAILURES;
    this.report(`${brain.name}'s model errored (${error}); trying again${fresh ? " in a fresh conversation" : ""}`, "warn");
    await new Promise((r) => setTimeout(r, this.deps.retryDelayMs ?? RETRY_DELAY_MS));
    if (this.stopping.has(state.id) || this.brain !== state) return false;
    let run: BrainRun;
    try {
      run = await brain.send(state.text, { fresh });
    } catch (err) {
      this.report(`${brain.name} unreachable: ${errMsg(err)}`, "error");
      return false;
    }
    if (fresh) this.modelFailures = 0;
    const next: BrainState = { ...state, id: run.id, attempt: state.attempt + 1, tools: [] };
    this.brain = next;
    this.emit({ type: "brain_event", stepId: state.stepId, runId: run.id, event: { kind: "retrying", attempt: next.attempt, fresh } });
    void this.consumeBrain(run, next);
    return true;
  }

  /** What to say when a run's model gave up for good. */
  private modelFailureLine(name: string, state: BrainState, rotated: boolean): string {
    if (state.attempt > 1) return `${name}'s model keeps erroring, even in a fresh conversation. Give it a moment and say it again.`;
    const after = state.tools.length ? ` after ${state.tools[state.tools.length - 1]!.replace(/_/g, " ")}` : "";
    const tail = rotated ? " I've started a fresh conversation; say it again and I'll retry." : " Say it again and I'll retry.";
    return `${name} hit an error from its model${after}.${tail}`;
  }

  /** Forward every run event to the UIs; questions and the answer are also spoken when the
   *  command came by voice. Statuses stay "busy" so they never claim a later step's outcome. */
  private async consumeBrain(run: BrainRun, state: BrainState): Promise<void> {
    const name = this.deps.brain?.name ?? "the brain";
    let settled = false;
    const settle = (o: BrainOutcome) => {
      settled = true;
      state.resolve(o);
    };
    let handedOver = false;
    try {
      for await (const event of run.events) {
        this.emit({ type: "brain_event", stepId: state.stepId, runId: run.id, event });
        switch (event.kind) {
          case "tool_start":
            state.tools.push(event.tool);
            this.report(`${name}: ${event.tool}…`, "busy");
            break;
          case "approval":
            this.approval = { runId: run.id, requestId: event.requestId, summary: event.summary, choices: event.choices };
            // spoken now unless the browser is mid-question; then it is read out with that answer's outcome
            if (state.voice && !this.pending) this.say(clipSpoken(Session.approvalQuestion(event.summary)));
            break;
          case "approved":
            if (this.approval?.runId === run.id) this.approval = null;
            break;
          case "completed":
            this.modelFailures = 0;
            settle({ ok: true, output: event.output });
            if (state.voice) this.say(spokenPart(event.output, this.maxSpoken));
            break;
          case "failed": {
            if (!event.modelError) {
              this.modelFailures = 0;
              settle({ ok: false, output: event.error });
              if (state.voice) this.say(clipSpoken(`${name} couldn't finish: ${event.error}`, this.maxSpoken));
              break;
            }
            this.modelFailures++;
            if (await this.retryBrain(state, event.error)) {
              handedOver = true;
              break;
            }
            // giving up on this utterance; a conversation that keeps failing is left behind
            const rotate = this.modelFailures >= ROTATE_AFTER_MODEL_FAILURES && !!this.deps.brain;
            if (rotate) {
              this.modelFailures = 0;
              await this.deps.brain!.reset().catch(() => {});
            }
            const line = this.modelFailureLine(name, state, rotate);
            this.report(line, "error");
            settle({ ok: false, output: line });
            if (state.voice) this.say(clipSpoken(line, this.maxSpoken));
            break;
          }
          case "cancelled":
            settle({ ok: false, output: "Cancelled" });
            break;
        }
      }
    } catch (err) {
      this.emit({ type: "brain_event", stepId: state.stepId, runId: run.id, event: { kind: "failed", error: errMsg(err) } });
      settle({ ok: false, output: errMsg(err) });
      if (state.voice) this.say(clipSpoken(`${name} dropped out: ${errMsg(err)}`, this.maxSpoken));
    } finally {
      if (!handedOver) {
        if (!settled) settle({ ok: false, output: "The run ended without an answer" });
        if (this.brain === state) this.brain = null;
      }
      if (this.approval?.runId === run.id) this.approval = null;
      this.stopping.delete(run.id);
    }
  }
}
