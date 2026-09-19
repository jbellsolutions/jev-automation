/** One conversation with one surface: the command → decide → gate → execute loop, plus the
 *  confirm/clarify questions it may leave open. Pure orchestration: no transport, no timers.
 *  Every observable event is emitted as a ServerMessage; hosts (WebSocket hub, HTTP, MCP)
 *  subscribe and forward. Work is serialized per session so replies can't overtake commands. */
import { type Action, describeAction } from "./actions.js";
import { type ApprovalChoice, type Brain, type BrainRun, approvalChoice } from "./brain.js";
import { parseOrdinal, splitSteps } from "./commands.js";
import type { Decider, Decision } from "./decide.js";
import type { PageSnapshot } from "./elements.js";
import type { Executor } from "./executor.js";
import { type Speaker, clipSpoken, spokenSummary } from "./speak.js";
import type { DecisionSummary, ServerMessage, StepInfo, VerifySummary } from "./protocol.js";
import type { CommandResult, PendingSummary, SessionStatus, StatusLevel, StepResult } from "./results.js";
import { type VerifyResult, describeVerify } from "./verify.js";

export type Pending =
  | { kind: "confirm"; action: Action; label: string; reason: string; before: PageSnapshot; command: string }
  | { kind: "clarify"; decision: Decision; before: PageSnapshot; command: string }
  /** The brain asked before doing something; the run waits until a human answers. */
  | { kind: "approval"; runId: string; requestId: string | null; summary: string; choices: ApprovalChoice[] }
  | null;

/** The brain run in progress, if any. Runs outside the command queue so browser commands and
 *  spoken approvals keep flowing while the agent works. */
interface BrainState {
  id: string;
  stepId: number;
  voice: boolean;
  done: Promise<BrainOutcome>;
  resolve: (o: BrainOutcome) => void;
}

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
  private continuation: Continuation | null = null;
  private brain: BrainState | null = null;
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

  pendingSummary(): PendingSummary {
    const p = this.pending;
    if (!p) return null;
    if (p.kind === "confirm") return { kind: "confirm", actionLabel: p.label, reason: p.reason };
    if (p.kind === "approval") return { kind: "approval", question: Session.approvalQuestion(p.summary), choices: p.choices };
    const c = p.decision.clarify;
    return c ? { kind: "clarify", question: c.question, options: c.options } : null;
  }

  async page(): Promise<{ url: string; title: string }> {
    return { url: this.executor.url, title: await this.executor.title() };
  }

  async status(): Promise<SessionStatus> {
    const page = await this.page();
    return { id: this.id, kind: this.executor.kind, ...page, busy: this.busy, pending: this.pendingSummary(), capabilities: this.executor.capabilities };
  }

  /** A spoken or typed command. Resolves when the command has been acted on or has left a
   *  question open; never rejects. With `speak`, the outcome is also read aloud. */
  command(text: string, opts: { speak?: boolean } = {}): Promise<CommandResult> {
    return this.voiced(this.enqueue(() => this.withAwaitedVerify(!!opts.speak, () => this.handleCommand(text))), opts.speak);
  }

  /** A command whose answer the caller wants in full: when it reaches the brain, resolves with
   *  the run's final output instead of the "on it" acknowledgement. */
  async ask(text: string, opts: { speak?: boolean } = {}): Promise<CommandResult & { output: string }> {
    const r = await this.command(text, opts);
    const run = this.brain;
    const started = r.steps.find((s) => run && s.stepId === run.stepId);
    if (!run || !started) return { ...r, output: spokenSummary(r) };
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
      this.say(spokenSummary(r));
      return r;
    });
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
      const pending = this.pending?.kind === "approval" ? this.pending : null;
      const step = this.ack(choice === "deny" ? "no" : `yes (${choice})`);
      if (!pending || !this.deps.brain) return this.finish([step]);
      await this.resolveApproval(step, pending, choice);
      return this.finish([step]);
    });
  }

  private async resolveApproval(step: StepResult, pending: Extract<NonNullable<Pending>, { kind: "approval" }>, choice: ApprovalChoice): Promise<void> {
    this.pending = null;
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

  /** Drop whatever is in flight or pending. Bypasses the queue on purpose. */
  cancel(): void {
    this.deps.speaker?.stop();
    this.inFlight?.abort();
    this.pending = null;
    this.continuation = null;
    this.stopBrain();
    this.report("Stopped", "ok");
  }

  private stopBrain(): void {
    const run = this.brain;
    if (!run || !this.deps.brain) return;
    this.deps.brain.stop(run.id).catch((err) => this.report(`Couldn't stop Hermes: ${errMsg(err)}`, "warn"));
  }

  private async finish(steps: StepResult[], stoppedAt?: number): Promise<CommandResult> {
    const pending = this.pendingSummary();
    const ok = pending === null && steps.length > 0 && stoppedAt === undefined && steps.every((s) => s.result?.level === "ok" && !s.verify?.stuck);
    const result: CommandResult = { ok, steps, page: await this.page(), pending };
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

    if (this.pending?.kind === "approval" && this.deps.brain) {
      // a yes/no answers the agent; anything else is a new command and the request stays open
      const pending = this.pending;
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
        return this.finish([await this.runStep(step, this.awaitVerify ? "blocking" : "async", decision)]);
      }
      this.emit({ type: "steps", original: trimmed, commands });
    }
    return this.runSteps(trimmed, commands, 0, []);
  }

  /** Browser steps run one at a time on the fast lane; everything else is handled whole. */
  private fastLane(d: Decision): boolean {
    if (d.route === "stop" || d.route === "computer") return false;
    if (d.route === "hermes") return !this.deps.brain;
    return true;
  }

  /** Run commands[from..] in order. A question parks the remainder; an error or a
   *  non-command stops the sequence. */
  private async runSteps(original: string, commands: string[], from: number, steps: StepResult[]): Promise<CommandResult> {
    const total = commands.length;
    for (let i = from; i < total; i++) {
      const command = commands[i]!;
      const info: StepInfo | undefined = total > 1 ? { index: i, total, original } : undefined;
      const step = await this.runStep(this.ack(command, info), total > 1 || this.awaitVerify ? "blocking" : "async");
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
  private async decide(command: string, step: StepResult | null): Promise<Decision | null> {
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
    if (step) this.announce(step, decision);
    return decision;
  }

  private announce(step: StepResult, decision: Decision): void {
    step.decision = summarize(decision);
    this.emit({ type: "decision", decision: step.decision });
    if (decision.meta.fallbackReason) this.report(`Jev unavailable (${decision.meta.fallbackReason}); used heuristics`, "warn");
  }

  /** One command: decide (unless already decided), gate, execute, check. May leave `pending` set. */
  private async runStep(step: StepResult, verifyMode: "blocking" | "async", decided?: Decision): Promise<StepResult> {
    const command = step.command;
    const decision = decided ?? (await this.decide(command, step));
    if (!decision) return step;
    const snapshot = this.lastSnapshot!;

    if (decision.route === "stop" || decision.action.kind === "stop") {
      this.pending = null;
      this.continuation = null;
      this.stopBrain();
      step.result = this.report("Stopped", "ok");
      return step;
    }
    if (decision.route === "hermes" && this.deps.brain) return this.runBrain(step, command);
    if (decision.action.kind === "open_app") {
      if (!this.deps.computer) {
        if (this.deps.brain) return this.runBrain(step, command);
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
      step.result = this.report(decision.action.reason, "warn");
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

  /** Hand the utterance to the brain. The step resolves as soon as the run is admitted (or
   *  steered into the run already in progress); events stream in afterwards, outside the queue. */
  private async runBrain(step: StepResult, text: string): Promise<StepResult> {
    const brain = this.deps.brain!;
    const voice = this.awaitVerify;
    if (this.brain) {
      try {
        await brain.steer(this.brain.id, text);
        if (voice) this.say("Okay.");
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
    const state: BrainState = { id: run.id, stepId: step.stepId, voice, done, resolve };
    this.brain = state;
    void this.consumeBrain(run, state);
    step.result = this.report(`${brain.name} is on it`, "ok");
    return step;
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
    try {
      for await (const event of run.events) {
        this.emit({ type: "brain_event", stepId: state.stepId, runId: run.id, event });
        switch (event.kind) {
          case "tool_start":
            this.report(`${name}: ${event.tool}…`, "busy");
            break;
          case "approval":
            this.pending = { kind: "approval", runId: run.id, requestId: event.requestId, summary: event.summary, choices: event.choices };
            if (state.voice) this.say(clipSpoken(Session.approvalQuestion(event.summary)));
            break;
          case "approved":
            if (this.pending?.kind === "approval" && this.pending.runId === run.id) this.pending = null;
            break;
          case "completed":
            settle({ ok: true, output: event.output });
            if (state.voice) this.say(clipSpoken(event.output));
            break;
          case "failed":
            settle({ ok: false, output: event.error });
            if (state.voice) this.say(clipSpoken(`${name} couldn't finish: ${event.error}`));
            break;
          case "cancelled":
            settle({ ok: false, output: "Cancelled" });
            break;
        }
      }
    } catch (err) {
      this.emit({ type: "brain_event", stepId: state.stepId, runId: run.id, event: { kind: "failed", error: errMsg(err) } });
    } finally {
      if (!settled) settle({ ok: false, output: "The run ended without an answer" });
      if (this.pending?.kind === "approval" && this.pending.runId === run.id) this.pending = null;
      if (this.brain === state) this.brain = null;
    }
  }
}
