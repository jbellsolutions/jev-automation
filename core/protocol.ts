import type { Action } from "./actions.js";
import type { ApprovalChoice, BrainEvent } from "./brain.js";
import type { Route } from "./route.js";
import type { Blocker } from "./verify.js";

/** WebSocket messages, browser UI -> server. */
export type ClientMessage =
  | { type: "command"; text: string; via: "voice" | "text" }
  | { type: "confirm_reply"; ok: boolean }
  | { type: "pick"; elementId: string }
  /** Answer to a brain approval request (the agent asked before doing something). */
  | { type: "approval_reply"; choice: ApprovalChoice }
  /** Stop talking (the user cut in); whatever is being done carries on. */
  | { type: "interrupt" }
  /** Switch the assistant off (stops everything, refuses commands until resumed) or back on. */
  | { type: "pause"; paused: boolean }
  /** Click on the live view; fx/fy are fractions (0–1) of the image so resizes stay accurate. */
  | { type: "click_at"; fx: number; fy: number }
  /** The pixel size the UI has available for the live view; the server sizes the viewport to match. */
  | { type: "viewport"; width: number; height: number }
  | { type: "screenshot_request" };

export interface DecisionSummary {
  command: string;
  intent: string;
  intentConfidence: number;
  route?: Route;
  routeConfidence?: number;
  action: Action;
  actionLabel: string;
  source: "jev" | "heuristic";
  model?: string;
  latencyMs: number;
  inputTokens?: number;
  targetConfidence?: number;
  alternatives?: Array<{ elementId: string; label: string; probability: number }>;
  risky?: number;
}

/** WebSocket messages, server -> browser UI. */
export type ServerMessage =
  | { type: "hello"; jev: { enabled: boolean; model: string | null }; viewport: { width: number; height: number }; stt: { provider: string | null }; paused?: boolean }
  /** The assistant is talking (or stopped); UIs mute the microphone meanwhile so it does not hear itself. */
  | { type: "speaking"; active: boolean }
  /** Jev is switched off (or back on): nothing is heard, said or done while paused — every UI
   *  and every API caller sees the same switch. */
  | { type: "paused"; paused: boolean }
  | { type: "screenshot"; jpegBase64: string; url: string; title: string }
  | { type: "viewport"; width: number; height: number }
  | { type: "status"; text: string; level: "info" | "busy" | "ok" | "warn" | "error" }
  | { type: "decision"; decision: DecisionSummary }
  | { type: "confirm"; actionLabel: string; reason: string }
  /** Progress of the brain run started by the step acknowledged with `stepId`; an `approval`
   *  event leaves the session waiting for approval_reply (or a spoken yes/no). */
  | { type: "brain_event"; stepId: number; runId: string; event: BrainEvent }
  | { type: "clarify"; question: string; options: Array<{ elementId: string; label: string; probability: number }> }
  /** One per step; `stepId` identifies it for later messages (verify). `step` is present only
   *  when the utterance was split into several. */
  | { type: "transcript_ack"; text: string; stepId: number; step?: StepInfo }
  /** Announces how an utterance was split, before the first step's ack. */
  | { type: "steps"; original: string; commands: string[] }
  /** Outcome check for the step acknowledged with `stepId`. */
  | { type: "verify"; stepId: number; command: string; verify: VerifySummary };

/** Messages on the /ws/stt socket, UI -> server. Audio travels as binary frames between
 *  `start` and `stop`: little-endian 16-bit PCM at `sampleRate`, mono. */
export type SttClientMessage =
  | { type: "start"; sampleRate: number; encoding: "pcm_s16le"; channels: 1; lang?: string; keywords?: string[] }
  | { type: "stop" };

/** Messages on the /ws/stt socket, server -> UI. */
export type SttServerMessage =
  | { type: "ready"; provider: string }
  /** Live text for display; never acted on. */
  | { type: "transcript"; text: string; final: false }
  /** A complete utterance: the UI sends it as a command. */
  | { type: "utterance"; text: string }
  | { type: "error"; message: string }
  | { type: "closed" };

export interface VerifySummary {
  done: boolean;
  stuck: boolean;
  doneProbability: number;
  blocker: Blocker;
  source: "code" | "jev" | "heuristic";
  latencyMs: number;
  /** Human-readable, e.g. "done 84%", "stuck: login wall". */
  text: string;
}

export interface StepInfo {
  index: number;
  total: number;
  original: string;
}
