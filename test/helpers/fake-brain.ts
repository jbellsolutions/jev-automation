import type { ApprovalChoice, Brain, BrainEvent, BrainRun } from "../../core/brain.js";

/** A brain whose runs are fed by the test: push events, await what the session did. */
export class FakeBrain implements Brain {
  readonly name = "Hermes";
  sent: string[] = [];
  /** `fresh` flags per send, parallel to `sent`. */
  freshFlags: boolean[] = [];
  resets = 0;
  approvals: Array<{ runId: string; choice: ApprovalChoice; requestId: string | null | undefined }> = [];
  steers: Array<{ runId: string; text: string }> = [];
  stops: string[] = [];
  failSend: string | null = null;
  private runs = 0;
  private feeds = new Map<string, { push: (e: BrainEvent | null) => void; fail?: (err: Error) => void }>();

  async reset(): Promise<void> {
    this.resets++;
  }

  async send(text: string, opts: { signal?: AbortSignal; fresh?: boolean } = {}): Promise<BrainRun> {
    if (this.failSend) throw new Error(this.failSend);
    if (opts.fresh) await this.reset();
    this.sent.push(text);
    this.freshFlags.push(!!opts.fresh);
    const id = `run_${++this.runs}`;
    const queue: Array<BrainEvent | null> = [];
    let wake: (() => void) | null = null;
    let failure: Error | null = null;
    const push = (e: BrainEvent | null) => {
      queue.push(e);
      wake?.();
    };
    const fail = (err: Error) => {
      failure = err;
      wake?.();
    };
    this.feeds.set(id, { push, fail });
    const events = (async function* () {
      for (;;) {
        if (queue.length === 0 && !failure) await new Promise<void>((r) => (wake = r));
        wake = null;
        if (failure) throw failure;
        const e = queue.shift()!;
        if (e === null) return;
        yield e;
      }
    })();
    return { id, events };
  }

  /** Make a run's event stream throw (a dropped socket the client could not recover from). */
  throwOn(runId: string, err: Error): void {
    const feed = this.feeds.get(runId);
    if (!feed) throw new Error(`no run ${runId}`);
    feed.push({ kind: "delta", text: "" }); // wake the consumer…
    feed.fail?.(err);
  }

  /** Feed events into a run; null ends the stream. */
  emit(runId: string, ...events: Array<BrainEvent | null>): void {
    const feed = this.feeds.get(runId);
    if (!feed) throw new Error(`no run ${runId}`);
    for (const e of events) feed.push(e);
  }

  async approve(runId: string, choice: ApprovalChoice, requestId?: string | null): Promise<void> {
    this.approvals.push({ runId, choice, requestId });
    this.emit(runId, { kind: "approved", choice });
  }
  async steer(runId: string, text: string): Promise<void> {
    this.steers.push({ runId, text });
    this.emit(runId, { kind: "steered" });
  }
  async stop(runId: string): Promise<void> {
    this.stops.push(runId);
    this.emit(runId, { kind: "cancelled" }, null);
  }
}

/** Let queued microtasks / background consumers run. */
export const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Poll until `cond` holds (HTTP round trips under a loaded test runner take a few ticks). */
export async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
