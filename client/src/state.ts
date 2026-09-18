/** All UI state in one place, derived purely from server messages + local events. */
import type { DecisionSummary, ServerMessage } from "../../server/protocol.ts";

export type StatusLevel = Extract<ServerMessage, { type: "status" }>["level"];

export interface LogEntry {
  id: number;
  said: string;
  decision: DecisionSummary | null;
  result: { text: string; level: StatusLevel } | null;
}

export type Pending =
  | { kind: "confirm"; actionLabel: string; reason: string }
  | { kind: "clarify"; question: string; options: Array<{ elementId: string; label: string; probability: number }> }
  | null;

export interface State {
  connected: boolean;
  jev: { enabled: boolean; model: string | null } | null;
  viewport: { width: number; height: number };
  page: { url: string; title: string; frame: string | null };
  status: { text: string; level: StatusLevel };
  entries: LogEntry[];
  pending: Pending;
}

export type Event = ServerMessage | { type: "socket"; connected: boolean } | { type: "clear_log" } | { type: "dismiss_pending" };

export const initialState: State = {
  connected: false,
  jev: null,
  viewport: { width: 1280, height: 800 },
  page: { url: "about:blank", title: "", frame: null },
  status: { text: "Connecting…", level: "info" },
  entries: [],
  pending: null,
};

const MAX_ENTRIES = 40;
let nextId = 1;

function updateLatest(entries: LogEntry[], patch: (e: LogEntry) => LogEntry): LogEntry[] {
  const [latest, ...rest] = entries;
  return latest ? [patch(latest), ...rest] : entries;
}

export function reducer(state: State, ev: Event): State {
  switch (ev.type) {
    case "socket":
      return { ...state, connected: ev.connected, status: ev.connected ? { text: "Connected", level: "ok" } : { text: "Disconnected — retrying…", level: "warn" } };
    case "hello":
      return { ...state, jev: ev.jev, viewport: ev.viewport };
    case "viewport":
      return { ...state, viewport: { width: ev.width, height: ev.height } };
    case "screenshot":
      return { ...state, page: { url: ev.url, title: ev.title, frame: `data:image/jpeg;base64,${ev.jpegBase64}` } };
    case "status": {
      const status = { text: ev.text, level: ev.level };
      if (ev.level === "busy") return { ...state, status };
      // a non-busy status is the outcome of the latest command; it also ends any confirmation
      const entries = updateLatest(state.entries, (e) => (e.result ? e : { ...e, result: status }));
      return { ...state, status, entries, pending: state.pending?.kind === "confirm" ? null : state.pending };
    }
    case "transcript_ack": {
      const entry: LogEntry = { id: nextId++, said: ev.text, decision: null, result: null };
      return { ...state, entries: [entry, ...state.entries].slice(0, MAX_ENTRIES), pending: state.pending?.kind === "clarify" ? null : state.pending };
    }
    case "decision":
      return { ...state, entries: updateLatest(state.entries, (e) => ({ ...e, decision: ev.decision })) };
    case "confirm":
      return { ...state, pending: { kind: "confirm", actionLabel: ev.actionLabel, reason: ev.reason }, status: { text: "Waiting for confirmation…", level: "warn" } };
    case "clarify":
      return { ...state, pending: { kind: "clarify", question: ev.question, options: ev.options }, status: { text: 'Say "the first one" or click an option', level: "warn" } };
    case "dismiss_pending":
      return { ...state, pending: null };
    case "clear_log":
      return { ...state, entries: [] };
    default:
      return state;
  }
}
