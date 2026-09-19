/** Shapes returned to programmatic callers (HTTP, MCP) and reported in status endpoints.
 *  The WebSocket UIs get the same information incrementally as ServerMessages. */
import type { ApprovalChoice } from "./brain.js";
import type { Alternative } from "./decide.js";
import type { ExecutorCapabilities, ExecutorKind } from "./executor.js";
import type { DecisionSummary, ServerMessage, VerifySummary } from "./protocol.js";

export type StatusLevel = Extract<ServerMessage, { type: "status" }>["level"];

export interface StepResult {
  /** Matches the transcript_ack / verify messages for this step. */
  stepId: number;
  command: string;
  decision: DecisionSummary | null;
  /** The outcome line shown in the UI, or null when the step ended in a question. */
  result: { text: string; level: StatusLevel } | null;
  /** Present when the outcome was checked (always in sequences, best-effort otherwise). */
  verify?: VerifySummary;
}

export type PendingSummary =
  | { kind: "confirm"; actionLabel: string; reason: string }
  | { kind: "clarify"; question: string; options: Alternative[] }
  /** The brain wants a human to allow something; answer with approve(). */
  | { kind: "approval"; question: string; choices: ApprovalChoice[] }
  | null;

export interface CommandResult {
  /** True only when every requested step ran and succeeded and nothing is pending. */
  ok: boolean;
  steps: StepResult[];
  page: { url: string; title: string };
  /** A question the session is now waiting on; answer with reply()/pick(). */
  pending: PendingSummary;
  /** Index into `steps` of the step at which the sequence stopped — because it failed, was
   *  stuck, or asked a question — when later steps of the utterance did not run. */
  stoppedAt?: number;
}

export interface SessionStatus {
  id: string;
  kind: ExecutorKind;
  url: string;
  title: string;
  busy: boolean;
  pending: PendingSummary;
  capabilities: ExecutorCapabilities;
}
