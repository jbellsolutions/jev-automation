/** All UI state in one place, derived purely from server messages + local events. */
import type { ApprovalChoice, BrainEvent } from "../../core/brain.ts";
import type { DecisionSummary, ServerMessage, VerifySummary } from "../../core/protocol.ts";

export type StatusLevel = Extract<ServerMessage, { type: "status" }>["level"];

export interface LogEntry {
  id: number;
  /** Server-side step id; verify messages refer to it. */
  stepId?: number;
  said: string;
  /** Set when this entry is one step of a longer utterance. */
  step?: { index: number; total: number; original: string };
  decision: DecisionSummary | null;
  result: { text: string; level: StatusLevel } | null;
  verify?: VerifySummary;
  /** Set once the step went to the brain: what it has said and done so far. */
  brain?: BrainProgress;
}

export interface BrainProgress {
  runId: string;
  /** The assistant's reply, streamed. */
  text: string;
  tools: Array<{ tool: string; preview: string; durationMs?: number; error?: boolean }>;
  state: "running" | "waiting" | "completed" | "failed" | "cancelled";
  /** Times the utterance was re-sent after a model error, and whether that moved to a fresh conversation. */
  retries?: number;
  fresh?: boolean;
}

export type Pending =
  | { kind: "confirm"; actionLabel: string; reason: string }
  | { kind: "clarify"; question: string; options: Array<{ elementId: string; label: string; probability: number }> }
  | null;

/** The brain's open approval request; independent of the browser question so neither hides the other. */
export type Approval = { runId: string; question: string; choices: ApprovalChoice[] } | null;

export interface State {
  connected: boolean;
  jev: { enabled: boolean; model: string | null } | null;
  /** Switched off: nothing is heard, said or done until resumed. */
  paused: boolean;
  viewport: { width: number; height: number };
  page: { url: string; title: string; frame: string | null };
  status: { text: string; level: StatusLevel };
  entries: LogEntry[];
  pending: Pending;
  approval: Approval;
}

export type Event = ServerMessage | { type: "socket"; connected: boolean } | { type: "clear_log" } | { type: "dismiss_pending" } | { type: "dismiss_approval" };

export const initialState: State = {
  connected: false,
  jev: null,
  paused: false,
  viewport: { width: 1280, height: 800 },
  page: { url: "about:blank", title: "", frame: null },
  status: { text: "Connecting…", level: "info" },
  entries: [],
  pending: null,
  approval: null,
};

const MAX_ENTRIES = 40;
let nextId = 1;

function updateLatest(entries: LogEntry[], patch: (e: LogEntry) => LogEntry): LogEntry[] {
  const [latest, ...rest] = entries;
  return latest ? [patch(latest), ...rest] : entries;
}

const MAX_BRAIN_TEXT = 4000;

function progress(entry: LogEntry, runId: string, event: BrainEvent): BrainProgress {
  const p: BrainProgress = entry.brain ?? { runId, text: "", tools: [], state: "running" };
  switch (event.kind) {
    case "delta":
      return { ...p, text: (p.text + event.text).slice(-MAX_BRAIN_TEXT), state: "running" };
    case "tool_start":
      return { ...p, tools: [...p.tools, { tool: event.tool, preview: event.preview }], state: "running" };
    case "tool_end": {
      const tools = p.tools.slice();
      for (let i = tools.length - 1; i >= 0; i--) {
        if (tools[i]!.tool === event.tool && tools[i]!.durationMs === undefined) {
          tools[i] = { ...tools[i]!, durationMs: event.durationMs, error: event.error };
          break;
        }
      }
      return { ...p, tools };
    }
    case "approval":
      return { ...p, state: "waiting" };
    case "approved":
    case "steered":
      return { ...p, state: "running" };
    case "completed":
      return { ...p, text: event.output || p.text, state: "completed" };
    case "failed":
      return { ...p, text: p.text ? `${p.text}\n\n${event.error}` : event.error, state: "failed" };
    case "retrying":
      // the same step, a new run: start its text over, keep the tool history for the record
      return { ...p, runId, text: "", state: "running", retries: (p.retries ?? 0) + 1, fresh: event.fresh || !!p.fresh };
    case "cancelled":
      return { ...p, state: "cancelled" };
    default:
      return p;
  }
}

/** Brain events attach to their step's entry by id (they land while later commands run) and
 *  drive the approval card; the final answer becomes the entry's outcome. */
function applyBrainEvent(state: State, stepId: number, runId: string, event: BrainEvent): State {
  const idx = state.entries.findIndex((e) => e.stepId === stepId);
  let entries = state.entries;
  if (idx !== -1) {
    entries = entries.slice();
    const entry = entries[idx]!;
    const brain = progress(entry, runId, event);
    const result =
      event.kind === "completed"
        ? { text: firstLine(event.output) || "Done", level: "ok" as const }
        : event.kind === "failed"
          ? { text: event.error, level: "error" as const }
          : event.kind === "cancelled"
            ? { text: "Cancelled", level: "warn" as const }
            : event.kind === "retrying"
              ? { text: event.fresh ? "Retrying in a fresh conversation…" : "Retrying…", level: "warn" as const }
              : entry.result;
    entries[idx] = { ...entry, brain, result };
  }
  let approval = state.approval;
  let status = state.status;
  if (event.kind === "approval") {
    approval = { runId, question: `Brain wants to ${event.summary}. Allow it?`, choices: event.choices };
    status = { text: "Brain is waiting for your approval", level: "warn" };
  } else if (approval?.runId === runId && (event.kind === "approved" || event.kind === "completed" || event.kind === "failed" || event.kind === "cancelled")) {
    approval = null;
  }
  if (event.kind === "completed") status = { text: "Brain: done", level: "ok" };
  else if (event.kind === "failed") status = { text: `Brain: ${event.error}`, level: "error" };
  else if (event.kind === "retrying") status = { text: event.fresh ? "Brain: retrying in a fresh conversation…" : "Brain: retrying…", level: "warn" };
  else if (event.kind === "cancelled") status = { text: "Brain: stopped", level: "warn" };
  return { ...state, entries, approval, status };
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/).find((l) => l.trim()) ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

export function reducer(state: State, ev: Event): State {
  switch (ev.type) {
    case "socket":
      return { ...state, connected: ev.connected, status: ev.connected ? { text: "Connected", level: "ok" } : { text: "Disconnected — retrying…", level: "warn" } };
    case "hello":
      return { ...state, jev: ev.jev, viewport: ev.viewport, paused: !!ev.paused };
    case "paused":
      return { ...state, paused: ev.paused, status: ev.paused ? { text: "Paused — hearing, saying and doing nothing", level: "warn" } : { text: "Resumed", level: "ok" } };
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
      const entry: LogEntry = { id: nextId++, stepId: ev.stepId, said: ev.text, decision: null, result: null, ...(ev.step ? { step: ev.step } : {}) };
      return { ...state, entries: [entry, ...state.entries].slice(0, MAX_ENTRIES), pending: state.pending?.kind === "clarify" ? null : state.pending };
    }
    case "decision":
      return { ...state, entries: updateLatest(state.entries, (e) => ({ ...e, decision: ev.decision })) };
    case "verify": {
      // background checks can land after later commands, so match on the step id
      const idx = state.entries.findIndex((e) => e.stepId === ev.stepId);
      if (idx === -1) return state;
      const entries = state.entries.slice();
      entries[idx] = { ...entries[idx]!, verify: ev.verify };
      return { ...state, entries };
    }
    case "confirm":
      return { ...state, pending: { kind: "confirm", actionLabel: ev.actionLabel, reason: ev.reason }, status: { text: "Waiting for confirmation…", level: "warn" } };
    case "clarify":
      return { ...state, pending: { kind: "clarify", question: ev.question, options: ev.options }, status: { text: 'Say "the first one" or click an option', level: "warn" } };
    case "brain_event":
      return applyBrainEvent(state, ev.stepId, ev.runId, ev.event);
    case "dismiss_pending":
      return { ...state, pending: null };
    case "dismiss_approval":
      return { ...state, approval: null };
    case "clear_log":
      return { ...state, entries: [] };
    default:
      return state;
  }
}
