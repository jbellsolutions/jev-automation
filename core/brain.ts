/** The brain lane: anything that is not a direct browser or Mac action goes to a model behind
 *  Jev that can answer, reason and draft — it never itself clicks, types or opens anything;
 *  Jev's own fast lane does that. This file is the pure seam; a concrete implementation (e.g.
 *  server/brain/openrouter.ts) lives outside core so core/ stays host-free. */

/** What the assistant may answer an approval request with. Which ones a given request accepts
 *  arrives with the request (`choices`); anything not offered degrades to "once". */
export type ApprovalChoice = "once" | "session" | "always" | "deny";

export type BrainEvent =
  /** A chunk of the assistant's reply, streamed as it is written. */
  | { kind: "delta"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_start"; tool: string; preview: string }
  | { kind: "tool_end"; tool: string; durationMs: number; error: boolean }
  /** The agent wants a human to allow something; the run waits until approve() is called. */
  | { kind: "approval"; requestId: string | null; summary: string; choices: ApprovalChoice[] }
  | { kind: "approved"; choice: string }
  | { kind: "steered" }
  | { kind: "completed"; output: string }
  /** `modelError`: the agent's model provider rejected the request (4xx), not the task itself —
   *  worth one retry, and a fresh conversation if it keeps happening. */
  | { kind: "failed"; error: string; modelError?: boolean }
  /** Emitted by the session, not the agent: the utterance was re-sent after a model error. */
  | { kind: "retrying"; attempt: number; fresh: boolean }
  | { kind: "cancelled" };

export type BrainTerminal = Extract<BrainEvent, { kind: "completed" | "failed" | "cancelled" }>;

export interface BrainRun {
  id: string;
  /** Ends with exactly one terminal event (completed / failed / cancelled), even when the
   *  underlying stream dropped: the client then polls the run's status until it settles. */
  events: AsyncIterable<BrainEvent>;
}

export interface Brain {
  readonly name: string;
  /** Start a run for one utterance in the assistant's persistent conversation. `fresh` starts
   *  a new conversation first (the old one is left behind, not deleted). */
  send(text: string, opts?: { signal?: AbortSignal; fresh?: boolean }): Promise<BrainRun>;
  /** Begin a new conversation; the next send() starts from a clean thread. */
  reset(): Promise<void>;
  approve(runId: string, choice: ApprovalChoice, requestId?: string | null): Promise<void>;
  /** Add to a run already in progress ("also check the second result"). */
  steer(runId: string, text: string): Promise<void>;
  stop(runId: string): Promise<void>;
}

/** Map a typed reply to a pending approval onto what the request allows. */
export function approvalChoice(reply: "confirm" | "cancel", raw: string, offered: ApprovalChoice[]): ApprovalChoice {
  if (reply === "cancel") return "deny";
  const t = raw.toLowerCase();
  if (/\balways\b|\bpermanently\b|\bfrom now on\b|\bevery time\b/.test(t) && offered.includes("always")) return "always";
  if (/\bsession\b|\bfor now\b|\bthis time around\b|\buntil i say\b/.test(t) && offered.includes("session")) return "session";
  return "once";
}
