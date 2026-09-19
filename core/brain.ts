/** The brain lane: anything that is not a direct browser or Mac action goes to a long-lived
 *  agent (Hermes) that owns tools, skills and memory. This file is the pure seam; the HTTP/SSE
 *  client lives in server/hermes.ts so core/ stays host-free. */

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
  | { kind: "failed"; error: string }
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
  /** Start a run for one utterance in the assistant's persistent conversation. */
  send(text: string, opts?: { signal?: AbortSignal }): Promise<BrainRun>;
  approve(runId: string, choice: ApprovalChoice, requestId?: string | null): Promise<void>;
  /** Add to a run already in progress ("also check the second result"). */
  steer(runId: string, text: string): Promise<void>;
  stop(runId: string): Promise<void>;
}

/** Map a spoken reply to a pending approval onto what the request allows. */
export function approvalChoice(reply: "confirm" | "cancel", raw: string, offered: ApprovalChoice[]): ApprovalChoice {
  if (reply === "cancel") return "deny";
  const t = raw.toLowerCase();
  if (/\balways\b|\bpermanently\b|\bfrom now on\b|\bevery time\b/.test(t) && offered.includes("always")) return "always";
  if (/\bsession\b|\bfor now\b|\bthis time around\b|\buntil i say\b/.test(t) && offered.includes("session")) return "session";
  return "once";
}
