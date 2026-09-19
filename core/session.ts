/** One conversation with one surface: the command → decide → gate → execute loop, plus the
 *  confirm/clarify questions it may leave open. Pure orchestration: no transport, no timers.
 *  Every observable event is emitted as a ServerMessage; hosts (WebSocket hub, HTTP, MCP)
 *  subscribe and forward. Work is serialized per session so replies can't overtake commands. */
import { type Action, describeAction } from "./actions.js";
import { parseOrdinal, splitSteps } from "./commands.js";
import type { Decider, Decision } from "./decide.js";
import type { Executor } from "./executor.js";
import type { DecisionSummary, ServerMessage, StepInfo } from "./protocol.js";
import type { CommandResult, PendingSummary, SessionStatus, StatusLevel, StepResult } from "./results.js";

export type Pending =
  | { kind: "confirm"; action: Action; label: string; reason: string }
  | { kind: "clarify"; decision: Decision }
  | null;

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
}

export function summarize(d: Decision): DecisionSummary {
  return {
    command: d.command,
    intent: d.intent,
    intentConfidence: d.intentConfidence,
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
   *  question open; never rejects. */
  command(text: string): Promise<CommandResult> {
    return this.enqueue(() => this.handleCommand(text));
  }

  /** Answer to a pending confirmation from a UI control (as opposed to a spoken reply). */
  reply(ok: boolean): Promise<CommandResult> {
    return this.enqueue(async () => {
      const pending = this.pending?.kind === "confirm" ? this.pending : null;
      const rest = this.takeContinuation();
      this.pending = null;
      const step: StepResult = { command: ok ? "yes" : "no", decision: null, result: null };
      if (!pending) return this.finish([step], false);
      if (!ok) {
        step.result = this.report(`Cancelled: ${pending.label}`, "warn");
        return this.finish([step], true);
      }
      step.result = await this.runAction(pending.action);
      return this.resume([step], rest);
    });
  }

  /** A clarification option chosen from a UI control. */
  pick(elementId: string): Promise<CommandResult> {
    return this.enqueue(async () => {
      const opt = this.pending?.kind === "clarify" ? this.pending.decision.clarify?.options.find((o) => o.elementId === elementId) : undefined;
      const rest = this.takeContinuation();
      this.pending = null;
      const step: StepResult = { command: `pick ${elementId}`, decision: null, result: null };
      if (!opt) return this.finish([step], false);
      step.result = await this.runAction({ kind: "click", elementId: opt.elementId, label: opt.label });
      return this.resume([step], rest);
    });
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
    this.inFlight?.abort();
    this.pending = null;
    this.continuation = null;
    this.report("Stopped", "ok");
  }

  private async finish(steps: StepResult[], ok: boolean, stoppedAt?: number): Promise<CommandResult> {
    const result: CommandResult = { ok, steps, page: await this.page(), pending: this.pendingSummary() };
    if (stoppedAt !== undefined) result.stoppedAt = stoppedAt;
    return result;
  }

  private async runAction(action: Action): Promise<{ text: string; level: StatusLevel }> {
    this.report(describeAction(action) + "…", "busy");
    let outcome: { text: string; level: StatusLevel };
    try {
      outcome = this.report(await this.executor.execute(action), "ok");
    } catch (err) {
      outcome = this.report(errMsg(err), "error");
    }
    await this.deps.afterAction?.();
    return outcome;
  }

  private takeContinuation(): Continuation | null {
    const c = this.continuation;
    this.continuation = null;
    return c;
  }

  /** After a held action ran, carry on with the steps parked behind the question. */
  private async resume(steps: StepResult[], rest: Continuation | null): Promise<CommandResult> {
    const last = steps[steps.length - 1];
    if (last?.result?.level === "error" || !rest) return this.finish(steps, last?.result?.level !== "error");
    return this.runSteps(rest.original, rest.commands, rest.index + 1, steps);
  }

  private async handleCommand(text: string): Promise<CommandResult> {
    const trimmed = text.trim();
    if (!trimmed) return this.finish([], false);

    if (this.pending?.kind === "confirm") {
      const pending = this.pending;
      const reply = await this.decider.classifyReply(trimmed, pending.label);
      if (reply === "confirm" || reply === "cancel") {
        this.emit({ type: "transcript_ack", text: trimmed });
        const rest = this.takeContinuation();
        this.pending = null;
        const step: StepResult = { command: trimmed, decision: null, result: null };
        if (reply === "cancel") {
          step.result = this.report(`Cancelled: ${pending.label}`, "warn");
          return this.finish([step], true);
        }
        step.result = await this.runAction(pending.action);
        return this.resume([step], rest);
      }
      this.pending = null; // a new command supersedes the question and whatever was queued behind it
      this.continuation = null;
    }
    if (this.pending?.kind === "clarify") {
      const opts = this.pending.decision.clarify?.options ?? [];
      const idx = parseOrdinal(trimmed);
      const picked = idx !== null ? opts[idx] : undefined;
      const rest = this.takeContinuation();
      this.pending = null;
      if (picked) {
        this.emit({ type: "transcript_ack", text: trimmed });
        const step: StepResult = { command: trimmed, decision: null, result: null };
        step.result = await this.runAction({ kind: "click", elementId: picked.elementId, label: picked.label });
        return this.resume([step], rest);
      }
    }

    const commands = splitSteps(trimmed);
    if (commands.length === 0) return this.finish([], false);
    if (commands.length > 1) this.emit({ type: "steps", original: trimmed, commands });
    return this.runSteps(trimmed, commands, 0, []);
  }

  /** Run commands[from..] in order. A question parks the remainder; an error or a
   *  non-command stops the sequence. */
  private async runSteps(original: string, commands: string[], from: number, steps: StepResult[]): Promise<CommandResult> {
    const total = commands.length;
    for (let i = from; i < total; i++) {
      const command = commands[i]!;
      const info: StepInfo | undefined = total > 1 ? { index: i, total, original } : undefined;
      this.emit(info ? { type: "transcript_ack", text: command, step: info } : { type: "transcript_ack", text: command });
      const step = await this.runStep(command);
      steps.push(step);
      if (this.pending) {
        this.continuation = i + 1 < total ? { original, commands, index: i } : null;
        return this.finish(steps, true, i + 1 < total ? i : undefined);
      }
      if (step.decision?.action.kind === "stop") return this.finish(steps, true, i);
      const failed = !step.result || step.result.level === "error" || step.result.level === "warn";
      if (failed) {
        if (i + 1 < total) this.report(`Stopped after step ${i + 1} of ${total}: ${step.result?.text ?? "no result"}`, "warn");
        return this.finish(steps, false, i);
      }
    }
    return this.finish(steps, true);
  }

  /** One command against a fresh snapshot: decide, gate, execute. May leave `pending` set. */
  private async runStep(command: string): Promise<StepResult> {
    const step: StepResult = { command, decision: null, result: null };
    this.report("Thinking…", "busy");
    this.inFlight?.abort();
    const controller = (this.inFlight = new AbortController());
    const snapshot = await this.executor.snapshot();
    let decision: Decision;
    try {
      decision = await this.decider.decide(command, snapshot, controller.signal);
    } catch (err) {
      step.result = controller.signal.aborted ? this.report("Cancelled", "warn") : this.report(errMsg(err), "error");
      return step;
    }
    step.decision = summarize(decision);
    this.emit({ type: "decision", decision: step.decision });
    if (decision.meta.fallbackReason) this.report(`Jev unavailable (${decision.meta.fallbackReason}); used heuristics`, "warn");

    if (decision.clarify) {
      this.pending = { kind: "clarify", decision };
      this.emit({ type: "clarify", question: decision.clarify.question, options: decision.clarify.options });
      return step;
    }
    if (decision.action.kind === "none") {
      step.result = this.report(decision.action.reason, "warn");
      return step;
    }
    if (decision.action.kind === "stop") {
      this.pending = null;
      this.continuation = null;
      step.result = this.report("Stopped", "ok");
      return step;
    }
    if (decision.needsConfirmation) {
      const label = describeAction(decision.action);
      const reason = `This looks hard to undo (risk ${Math.round(decision.riskProbability * 100)}%). Say "yes" or "no".`;
      this.pending = { kind: "confirm", action: decision.action, label, reason };
      this.emit({ type: "confirm", actionLabel: label, reason });
      return step;
    }
    step.result = await this.runAction(decision.action);
    return step;
  }
}
