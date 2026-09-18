import type { Action } from "./actions.js";

/** WebSocket messages, browser UI -> server. */
export type ClientMessage =
  | { type: "command"; text: string; via: "voice" | "text" }
  | { type: "confirm_reply"; ok: boolean }
  | { type: "pick"; elementId: string }
  | { type: "click_at"; x: number; y: number }
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
  | { type: "status"; text: string; level: "info" | "busy" | "ok" | "warn" | "error" }
  | { type: "decision"; decision: DecisionSummary }
  | { type: "confirm"; actionLabel: string; reason: string }
  | { type: "clarify"; question: string; options: Array<{ elementId: string; label: string; probability: number }> }
  | { type: "transcript_ack"; text: string };
