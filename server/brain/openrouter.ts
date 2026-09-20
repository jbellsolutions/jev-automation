/** A model behind Jev, reached directly through OpenRouter's chat-completions API — the "brain"
 *  lane for anything that is not an obvious browser/Mac action (core/brain.ts). Text-only, by
 *  design: it answers, reasons and drafts, but never itself clicks, types or opens anything —
 *  Jev's own fast lane does that. Conversation history is session-scoped and in-memory only:
 *  it forgets everything on relaunch, not just on an explicit "new conversation" — an explicit
 *  scope cut from Hermes' durable, cross-restart memory. Each call is one stateless HTTP
 *  request, so there is no server-side run to steer the way Hermes's durable agent has: steer()
 *  aborts the in-flight request, appends the new message, and starts another one that continues
 *  the same run id/event stream the caller is already iterating. */
import { randomUUID } from "node:crypto";
import type { ApprovalChoice, Brain, BrainEvent, BrainRun } from "../../core/brain.js";

export const DEFAULT_MODEL = "z-ai/glm-5.3-flash";
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export const BRAIN_INSTRUCTIONS = `You are Jev, the reasoning half of a Mac productivity assistant. Justin talks or types to Jev's panel; Jev's own fast lane already handles every actual click, keystroke, or app launch — you never do those yourself.
- You have no tools and take no actions. If the request needs something done on screen, say plainly what you'd want done; don't claim to have done it.
- Answer directly and concisely. Markdown, lists, links and code fences are fine — this is a text panel, nothing is read aloud.
- Ask one short clarifying question if genuinely ambiguous; otherwise just answer.`;

type Role = "system" | "user" | "assistant";
interface Message {
  role: Role;
  content: string;
}

export interface OpenRouterOptions {
  apiKey: string;
  /** An OpenRouter model slug, e.g. "z-ai/glm-5.3-flash"; unset = DEFAULT_MODEL. */
  model?: string;
  /** Standing system prompt sent with every request; null sends none. */
  instructions?: string | null;
  fetch?: typeof fetch;
}

/** Split buffered SSE text into complete frames' parsed `data:` payloads (OpenAI/OpenRouter
 *  chat-completions framing: a JSON object per event, its `data:` lines joined per the SSE spec,
 *  terminated by a literal `data: [DONE]`). */
export function parseSseFrames(buffer: string): { events: unknown[]; rest: string; done: boolean } {
  const events: unknown[] = [];
  let done = false;
  const frames = buffer.split(/\r?\n\r?\n/);
  const rest = frames.pop() ?? "";
  for (const frame of frames) {
    const data = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    try {
      events.push(JSON.parse(data));
    } catch {
      /* not JSON: ignore (e.g. a stray comment line) */
    }
  }
  return { events, rest, done };
}

/** One streamed chat-completion chunk -> the text delta it carries, or "" for a chunk with none
 *  (e.g. the first chunk, which only sets `role`). */
export function chunkDelta(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const choices = (raw as { choices?: unknown }).choices;
  const first = Array.isArray(choices) ? choices[0] : null;
  const delta = first && typeof first === "object" ? (first as { delta?: unknown }).delta : null;
  const content = delta && typeof delta === "object" ? (delta as { content?: unknown }).content : null;
  return typeof content === "string" ? content : "";
}

function errorMessage(status: number, body: unknown): string {
  const d = body as { error?: { message?: string; code?: number | string } | string } | null;
  const msg = typeof d?.error === "string" ? d.error : d?.error?.message;
  return msg ? `HTTP ${status}: ${msg}` : `HTTP ${status}`;
}

interface RunState {
  controller: AbortController;
  queue: BrainEvent[];
  wake: (() => void) | null;
  ended: boolean;
}

export class OpenRouterBrain implements Brain {
  readonly name = "Jev";
  private readonly fetchImpl: typeof fetch;
  private history: Message[] = [];
  private readonly runs = new Map<string, RunState>();

  constructor(private readonly opts: OpenRouterOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Leave the conversation behind; the next send() starts from a clean thread. */
  async reset(): Promise<void> {
    this.history = [];
  }

  /** Text-only: nothing is ever pending, so there is nothing to approve or deny. */
  async approve(_runId: string, _choice: ApprovalChoice, _requestId?: string | null): Promise<void> {}

  async send(text: string, opts: { signal?: AbortSignal; fresh?: boolean } = {}): Promise<BrainRun> {
    if (opts.fresh) this.history = [];
    this.history.push({ role: "user", content: text });
    const id = randomUUID();
    const controller = new AbortController();
    opts.signal?.addEventListener("abort", () => controller.abort());
    const state: RunState = { controller, queue: [], wake: null, ended: false };
    this.runs.set(id, state);
    void this.execute(id, state, controller);
    return { id, events: this.stream(state) };
  }

  async steer(runId: string, text: string): Promise<void> {
    const state = this.runs.get(runId);
    if (!state) return;
    state.controller.abort();
    this.history.push({ role: "user", content: text });
    const controller = new AbortController();
    state.controller = controller;
    this.pushEvent(state, { kind: "steered" });
    void this.execute(runId, state, controller);
  }

  async stop(runId: string): Promise<void> {
    this.runs.get(runId)?.controller.abort();
  }

  private async *stream(state: RunState): AsyncGenerator<BrainEvent> {
    for (;;) {
      if (state.queue.length === 0 && !state.ended) await new Promise<void>((r) => (state.wake = r));
      state.wake = null;
      while (state.queue.length > 0) yield state.queue.shift()!;
      if (state.ended) return;
    }
  }

  private pushEvent(state: RunState, e: BrainEvent): void {
    state.queue.push(e);
    state.wake?.();
  }

  private endRun(state: RunState): void {
    state.ended = true;
    state.wake?.();
  }

  /** Runs one HTTP request for `id`. `controller` is captured at call time so a superseding
   *  steer() (which swaps `state.controller` for a fresh one) can be told apart from this call's
   *  own controller: once they differ, this call has been superseded and must not touch the
   *  queue, end the stream, or delete the run — the newer execute() call owns all of that now. */
  private async execute(id: string, state: RunState, controller: AbortController): Promise<void> {
    const mine = () => state.controller === controller;
    const instructions = this.opts.instructions === undefined ? BRAIN_INSTRUCTIONS : this.opts.instructions;
    const messages: Message[] = instructions ? [{ role: "system", content: instructions }, ...this.history] : [...this.history];

    let res: Response;
    try {
      res = await this.fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: this.opts.model ?? DEFAULT_MODEL, messages, stream: true }),
        signal: controller.signal,
      });
    } catch (err) {
      if (!mine()) return;
      return this.settleError(id, state, controller, err instanceof Error ? err.message : String(err), false);
    }
    if (!mine()) return;
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => null);
      return this.settleError(id, state, controller, errorMessage(res.status, body), res.status >= 400 && res.status < 500);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let output = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (!mine()) return;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest, done: sawDone } = parseSseFrames(buffer);
        buffer = rest;
        for (const raw of events) {
          const delta = chunkDelta(raw);
          if (!delta) continue;
          output += delta;
          this.pushEvent(state, { kind: "delta", text: delta });
        }
        if (sawDone) break;
      }
    } catch (err) {
      if (!mine()) return;
      return this.settleError(id, state, controller, err instanceof Error ? err.message : String(err), false);
    }
    if (!mine()) return;
    this.history.push({ role: "assistant", content: output });
    this.pushEvent(state, { kind: "completed", output });
    this.endRun(state);
    this.runs.delete(id);
  }

  private settleError(id: string, state: RunState, controller: AbortController, error: string, modelError: boolean): void {
    if (controller.signal.aborted) this.pushEvent(state, { kind: "cancelled" });
    else this.pushEvent(state, { kind: "failed", error: `OpenRouter: ${error}`, modelError });
    this.endRun(state);
    this.runs.delete(id);
  }

  /** GET /api/v1/key with the key, so a bad or missing key shows up at startup, not mid-command. */
  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await this.fetchImpl("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${this.opts.apiKey}` } });
      if (res.ok) {
        // OpenRouter's default label for an unnamed key is a truncated fragment of the key
        // itself, so it is deliberately never surfaced here — this detail string gets logged.
        return { ok: true, detail: `openrouter, ${this.opts.model ?? DEFAULT_MODEL}` };
      }
      const body = await res.json().catch(() => null);
      return { ok: false, detail: errorMessage(res.status, body) };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** The brain from the environment. JEV_BRAIN_MODEL picks the reasoning model (an OpenRouter
 *  slug); unset = DEFAULT_MODEL. */
export function createBrain(env: NodeJS.ProcessEnv = process.env): OpenRouterBrain | null {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return null;
  return new OpenRouterBrain({ apiKey, model: env.JEV_BRAIN_MODEL?.trim() || undefined });
}
