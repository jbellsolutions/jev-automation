/** Shapes returned to programmatic callers (HTTP, MCP) and reported in status endpoints.
 *  The WebSocket UIs get the same information incrementally as ServerMessages. */
import type { Alternative } from "./decide.js";
import type { ExecutorCapabilities, ExecutorKind } from "./executor.js";
import type { DecisionSummary, ServerMessage } from "./protocol.js";

export type StatusLevel = Extract<ServerMessage, { type: "status" }>["level"];

export interface StepResult {
  command: string;
  decision: DecisionSummary | null;
  /** The outcome line shown in the UI, or null when the step ended in a question. */
  result: { text: string; level: StatusLevel } | null;
}

export type PendingSummary =
  | { kind: "confirm"; actionLabel: string; reason: string }
  | { kind: "clarify"; question: string; options: Alternative[] }
  | null;

export interface CommandResult {
  ok: boolean;
  steps: StepResult[];
  page: { url: string; title: string };
  /** A question the session is now waiting on; answer with reply()/pick(). */
  pending: PendingSummary;
  /** Index of the step that stopped a sequence early, when not all steps ran. */
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
