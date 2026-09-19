/** One conversation with one surface: the command → decide → gate → execute loop, plus the
 *  confirm/clarify questions it may leave open. Pure orchestration: no transport, no timers.
 *  Every observable event is emitted as a ServerMessage; hosts (WebSocket hub, HTTP, MCP)
 *  subscribe and forward. Work is serialized per session so replies can't overtake commands. */
import { type Action, describeAction } from "./actions.js";
import { parseOrdinal } from "./commands.js";
import type { Decider, Decision } from "./decide.js";
import type { Executor } from "./executor.js";
import type { DecisionSummary, ServerMessage } from "./protocol.js";
import type { CommandResult, PendingSummary, SessionStatus, StatusLevel, StepResult } from "./results.js";

export type Pending =
  | { kind: "confirm"; action: Action; label: string; reason: string }
  | { kind: "clarify"; decision: Decision }
  | null;

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
      this.pending = null;
      const step: StepResult = { command: ok ? "yes" : "no", decision: null, result: null };
      if (!pending) return this.finish([step], false);
      step.result = ok ? await this.runAction(pending.action) : this.report(`Cancelled: ${pending.label}`, "warn");
      return this.finish([step], step.result.level !== "error");
    });
  }

  /** A clarification option chosen from a UI control. */
  pick(elementId: string): Promise<CommandResult> {
    return this.enqueue(async () => {
      const opt = this.pending?.kind === "clarify" ? this.pending.decision.clarify?.options.find((o) => o.elementId === elementId) : undefined;
      this.pending = null;
      const step: StepResult = { command: `pick ${elementId}`, decision: null, result: null };
      if (!opt) return this.finish([step], false);
      step.result = await this.runAction({ kind: "click", elementId: opt.elementId, label: opt.label });
      return this.finish([step], step.result.level !== "error");
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

  private async handleCommand(text: string): Promise<CommandResult> {
    const trimmed = text.trim();
    if (!trimmed) return this.finish([], false);
    this.emit({ type: "transcript_ack", text: trimmed });
    const step: StepResult = { command: trimmed, decision: null, result: null };
    const steps = [step];

    if (this.pending?.kind === "confirm") {
      const pending = this.pending;
      const reply = await this.decider.classifyReply(trimmed, pending.label);
      if (reply === "confirm") {
        this.pending = null;
        step.result = await this.runAction(pending.action);
        return this.finish(steps, step.result.level !== "error");
      }
      if (reply === "cancel") {
        this.pending = null;
        step.result = this.report(`Cancelled: ${pending.label}`, "warn");
        return this.finish(steps, true);
      }
      this.pending = null; // a new command supersedes the question
    }
    if (this.pending?.kind === "clarify") {
      const opts = this.pending.decision.clarify?.options ?? [];
      const idx = parseOrdinal(trimmed);
      const picked = idx !== null ? opts[idx] : undefined;
      this.pending = null;
      if (picked) {
        step.result = await this.runAction({ kind: "click", elementId: picked.elementId, label: picked.label });
        return this.finish(steps, step.result.level !== "error");
      }
    }

    this.report("Thinking…", "busy");
    this.inFlight?.abort();
    const controller = (this.inFlight = new AbortController());
    const snapshot = await this.executor.snapshot();
    let decision: Decision;
    try {
      decision = await this.decider.decide(trimmed, snapshot, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) return this.finish(steps, false);
      step.result = this.report(errMsg(err), "error");
      return this.finish(steps, false);
    }
    step.decision = summarize(decision);
    this.emit({ type: "decision", decision: step.decision });
    if (decision.meta.fallbackReason) this.report(`Jev unavailable (${decision.meta.fallbackReason}); used heuristics`, "warn");

    if (decision.clarify) {
      this.pending = { kind: "clarify", decision };
      this.emit({ type: "clarify", question: decision.clarify.question, options: decision.clarify.options });
      return this.finish(steps, true);
    }
    if (decision.action.kind === "none") {
      step.result = this.report(decision.action.reason, "warn");
      return this.finish(steps, false);
    }
    if (decision.action.kind === "stop") {
      this.pending = null;
      step.result = this.report("Stopped", "ok");
      return this.finish(steps, true);
    }
    if (decision.needsConfirmation) {
      const label = describeAction(decision.action);
      const reason = `This looks hard to undo (risk ${Math.round(decision.riskProbability * 100)}%). Say "yes" or "no".`;
      this.pending = { kind: "confirm", action: decision.action, label, reason };
      this.emit({ type: "confirm", actionLabel: label, reason });
      return this.finish(steps, true);
    }
    step.result = await this.runAction(decision.action);
    return this.finish(steps, step.result.level !== "error");
  }
}
