import type { Action } from "./actions.js";
import type { Blocker } from "./verify.js";

/** WebSocket messages, browser UI -> server. */
export type ClientMessage =
  | { type: "command"; text: string; via: "voice" | "text" }
  | { type: "confirm_reply"; ok: boolean }
  | { type: "pick"; elementId: string }
  /** Click on the live view; fx/fy are fractions (0–1) of the image so resizes stay accurate. */
  | { type: "click_at"; fx: number; fy: number }
  /** The pixel size the UI has available for the live view; the server sizes the viewport to match. */
  | { type: "viewport"; width: number; height: number }
  | { type: "screenshot_request" };

export interface DecisionSummary {
  command: string;
  intent: string;
  intentConfidence: number;
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
  | { type: "hello"; jev: { enabled: boolean; model: string | null }; viewport: { width: number; height: number } }
  | { type: "screenshot"; jpegBase64: string; url: string; title: string }
  | { type: "viewport"; width: number; height: number }
  | { type: "status"; text: string; level: "info" | "busy" | "ok" | "warn" | "error" }
  | { type: "decision"; decision: DecisionSummary }
  | { type: "confirm"; actionLabel: string; reason: string }
  | { type: "clarify"; question: string; options: Array<{ elementId: string; label: string; probability: number }> }
  /** One per step; `step` is present only when the utterance was split into several. */
  | { type: "transcript_ack"; text: string; step?: StepInfo }
  /** Announces how an utterance was split, before the first step's ack. */
  | { type: "steps"; original: string; commands: string[] }
  /** Outcome check for the step whose command is `command` (the most recent entry with that text). */
  | { type: "verify"; command: string; verify: VerifySummary };

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
