/** Hermes Agent as the brain, through its local OpenAI-compatible API server (the gateway
 *  on 127.0.0.1:8642). Runs are durable: POST /v1/runs admits one, GET …/events streams its
 *  lifecycle, and GET /v1/runs/{id} keeps a pollable status with the final output — the
 *  stream has no replay, so when it drops the client polls the status until the run settles.
 *
 *  Enable it in ~/.hermes/.env: API_SERVER_ENABLED=true, API_SERVER_KEY=<16+ chars>. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { type ApprovalChoice, type Brain, type BrainEvent, type BrainRun, type BrainTerminal, isModelError } from "../core/brain.js";
import { readState, writeState } from "./state.js";

export interface HermesOptions {
  baseUrl: string;
  apiKey: string;
  /** Hermes session the assistant's turns accumulate in. Without one, the last one from
   *  `state` is reused, else a new `jev-voice-<stamp>` is created; reset() always makes a new one. */
  sessionId?: string;
  /** Remembers the current session across restarts. */
  state?: { get(): string | undefined; set(id: string): void };
  /** Model the voice conversation runs on (a Hermes provider model id such as
   *  `deepseek-v4.1-flash`); unset = Hermes' global default. Sent with every run (the runs API
   *  reads the body, not the session row) and pinned on the session for its other routes. */
  model?: string;
  provider?: string;
  /** Standing instructions sent with every run (see VOICE_INSTRUCTIONS). */
  instructions?: string | null;
  fetch?: typeof fetch;
  /** How often to poll the run status when the event stream is gone. */
  pollMs?: number;
  /** For tests: how long to wait between polls / for the first status. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export const SESSION_PREFIX = "jev-voice";

/** What Hermes is told on every run from the voice lane, on top of its own persona (SOUL.md
 *  is untouched). Replaceable by ~/.jev/voice-instructions.md. */
export const VOICE_INSTRUCTIONS = `You are talking with Justin by voice, through Jev — the floating assistant panel on his Mac. Everything he says here is spoken; everything you write is read aloud to him, and the full text is shown in the panel.

How to reply
- Lead with the spoken answer: one to three short, natural sentences, the way you would say it out loud. No markdown, headings, bullet lists, code fences or URLs in that lead. Plain words, contractions, no filler.
- If there is more to show (details, lists, links, code), put it after a blank line; the panel shows it, the voice reads only the lead.
- If the request is ambiguous, ask one short question instead of guessing. If something needs his OK (anything destructive, spending money, sending a message on his behalf), say what you are about to do and ask.
- When you did something, say what happened in one sentence, not how.

Your hands
- jev_browse / jev_status / jev_reply / jev_cancel are Justin's own browser on this Mac, signed in to his accounts: use jev_browse for any to-do that happens in a web page (open a site, click, type, search, read what is on the page), in preference to your own browser_* tools, which are a separate unsigned-in browser. Go straight to it; do not plan or deliberate first.
- The super-browser tools are a separate hosted browser fleet: use them only when Justin says "Super Browser", when the task is not on this machine, or when it needs its own browsers or scraping at scale. Otherwise leave them alone.
- Terminal and file tools are this Mac. Memory and session search are your own recall.
- Spoken to-dos are exactly what was asked: no council, no readiness review, no scaling a list up beyond the number he said. Do the thing, then tell him.
- Effort cap: try at most two ways to do a thing. If neither works, stop and say in one sentence what is missing or not connected, and ask whether he wants you to keep digging. Never go hunting around the machine for a third and fourth way on your own.
- If a surface is not available — an app Jev cannot drive yet, a site the browser is not signed in to, a tool that is not connected — say so in one sentence and offer the nearest thing you can do.`;

export function loadVoiceInstructions(file = path.join(process.env.JEV_HOME ?? path.join(homedir(), ".jev"), "voice-instructions.md")): string {
  try {
    const text = readFileSync(file, "utf8").trim();
    return text || VOICE_INSTRUCTIONS;
  } catch {
    return VOICE_INSTRUCTIONS;
  }
}
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const CHOICES: ApprovalChoice[] = ["once", "session", "always", "deny"];

/** Split buffered SSE text into complete frames' `data:` payloads. Comment frames
 *  (`: keepalive`, `: stream closed`) are dropped; the unfinished tail comes back as `rest`. */
export function parseSseFrames(buffer: string): { events: unknown[]; rest: string } {
  const events: unknown[] = [];
  const frames = buffer.split(/\r?\n\r?\n/);
  const rest = frames.pop() ?? "";
  for (const frame of frames) {
    const data = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      /* not JSON: ignore */
    }
  }
  return { events, rest };
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

function choicesOf(raw: unknown): ApprovalChoice[] {
  const list = Array.isArray(raw) ? raw.filter((c): c is ApprovalChoice => CHOICES.includes(c as ApprovalChoice)) : [];
  return list.length ? list : ["once", "deny"];
}

function approvalEvent(e: Record<string, unknown>): BrainEvent {
  const summary = str(e.description) || str(e.command) || str(e.tool) || "do something that needs your permission";
  return { kind: "approval", requestId: str(e.request_id) || null, summary, choices: choicesOf(e.choices) };
}

/** One Hermes run event -> BrainEvent; null for events the UI does not show. */
export function mapHermesEvent(raw: unknown): BrainEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  switch (str(e.event)) {
    case "message.delta":
      return { kind: "delta", text: str(e.delta) };
    case "reasoning.available":
      return { kind: "reasoning", text: str(e.text) };
    case "tool.started":
      return { kind: "tool_start", tool: str(e.tool), preview: str(e.preview) };
    case "tool.completed":
      return { kind: "tool_end", tool: str(e.tool), durationMs: Math.round(Number(e.duration ?? 0) * 1000), error: !!e.error };
    case "approval.request":
      return approvalEvent(e);
    case "approval.responded":
      return { kind: "approved", choice: str(e.choice) };
    case "run.steered":
      return { kind: "steered" };
    case "run.completed":
      return { kind: "completed", output: str(e.output) };
    case "run.failed": {
      const error = str(e.error) || "run failed";
      return { kind: "failed", error, modelError: isModelError(error) };
    }
    case "run.cancelled":
    case "run.interrupted":
      return { kind: "cancelled" };
    default:
      return null;
  }
}

/** The terminal event a settled run status stands for; null while it is still going. */
export function terminalFromStatus(status: unknown): BrainTerminal | null {
  if (!status || typeof status !== "object") return null;
  const s = status as Record<string, unknown>;
  switch (str(s.status)) {
    case "completed":
      return { kind: "completed", output: str(s.output) };
    case "failed": {
      const error = str(s.error) || "run failed";
      return { kind: "failed", error, modelError: isModelError(error) };
    }
    case "cancelled":
    case "interrupted":
      return { kind: "cancelled" };
    default:
      return null;
  }
}

const isTerminal = (e: BrainEvent): e is BrainTerminal => e.kind === "completed" || e.kind === "failed" || e.kind === "cancelled";

export class HermesBrain implements Brain {
  readonly name = "Hermes";
  private readonly fetchImpl: typeof fetch;
  private sessionId: string;
  private readonly pollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private sessionReady: Promise<void> | null = null;

  constructor(private readonly opts: HermesOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.sessionId = opts.sessionId ?? opts.state?.get() ?? this.newSessionId();
    this.pollMs = opts.pollMs ?? 1000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The conversation the next run joins. */
  get session(): string {
    return this.sessionId;
  }

  /** Readable (when it started) and unique (a short random tail): two resets in one second,
   *  or a model change right after start, never land on the same conversation. */
  private newSessionId(): string {
    const d = this.now();
    const p = (n: number) => String(n).padStart(2, "0");
    const tail = randomUUID().replace(/-/g, "").slice(0, 3);
    return `${SESSION_PREFIX}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${tail}`;
  }

  /** Leave the current conversation behind; the next run starts a new one. */
  async reset(): Promise<void> {
    this.sessionId = this.newSessionId();
    this.sessionReady = null;
  }

  private url(path: string): string {
    return this.opts.baseUrl.replace(/\/$/, "") + path;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json", ...extra };
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown, extra?: Record<string, string>, signal?: AbortSignal): Promise<{ status: number; data: T }> {
    const res = await this.fetchImpl(this.url(path), {
      method,
      headers: this.headers(extra),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    }).catch((err: unknown) => {
      throw new Error(`Hermes API unreachable at ${this.opts.baseUrl} (${err instanceof Error ? err.message : String(err)}). Is the gateway running with API_SERVER_ENABLED=true?`);
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body */
    }
    return { status: res.status, data: data as T };
  }

  private fail(status: number, data: unknown, what: string): Error {
    const d = data as { error?: { message?: string; code?: string } | string } | null;
    const msg = typeof d?.error === "string" ? d.error : (d?.error?.message ?? (status === 401 ? "unauthorized (check HERMES_API_KEY = API_SERVER_KEY)" : `HTTP ${status}`));
    return new Error(`Hermes ${what}: ${msg}`);
  }

  /** Create the assistant's session once; "exists" on a later start is fine. */
  private ensureSession(): Promise<void> {
    this.sessionReady ??= (async () => {
      const body: Record<string, unknown> = { id: this.sessionId, title: `Jev (voice) ${this.sessionId}`, source: "api_server" };
      if (this.opts.model) body.model = this.opts.model;
      if (this.opts.provider) body.provider = this.opts.provider;
      const r = await this.request<{ error?: { code?: string; message?: string } }>("POST", "/api/sessions", body);
      const err = r.data?.error;
      // Hermes also refuses a duplicate *title*, hence the id in it; an id that exists is ours from before
      const exists = r.status === 409 || (typeof err === "object" && /exist/i.test(`${err?.code ?? ""} ${err?.message ?? ""}`));
      if (r.status !== 201 && r.status !== 200 && !exists) throw this.fail(r.status, r.data, "session");
      this.opts.state?.set(this.sessionId);
    })().catch((err) => {
      this.sessionReady = null; // try again on the next command
      throw err;
    });
    return this.sessionReady;
  }

  async send(text: string, opts: { signal?: AbortSignal; fresh?: boolean } = {}): Promise<BrainRun> {
    if (opts.fresh) await this.reset();
    await this.ensureSession();
    const body: Record<string, unknown> = { input: text, session_id: this.sessionId };
    const instructions = this.opts.instructions === undefined ? VOICE_INSTRUCTIONS : this.opts.instructions;
    if (instructions) body.instructions = instructions;
    if (this.opts.model) body.model = this.opts.model;
    if (this.opts.provider) body.provider = this.opts.provider;
    const r = await this.request<{ run_id?: string; error?: unknown }>("POST", "/v1/runs", body, { "Idempotency-Key": randomUUID() }, opts.signal);
    if (r.status !== 202 || !r.data?.run_id) throw this.fail(r.status, r.data, "run");
    const id = r.data.run_id;
    return { id, events: this.events(id, opts.signal) };
  }

  /** Stream the run's events; if the stream ends before a terminal event, poll the status. */
  private async *events(runId: string, signal?: AbortSignal): AsyncGenerator<BrainEvent> {
    let seenApproval: string | null = null;
    try {
      const res = await this.fetchImpl(this.url(`/v1/runs/${runId}/events`), { headers: this.headers({ accept: "text/event-stream" }), signal });
      if (res.ok && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { events, rest } = parseSseFrames(buffer);
          buffer = rest;
          for (const raw of events) {
            const ev = mapHermesEvent(raw);
            if (!ev) continue;
            if (ev.kind === "approval") seenApproval = ev.requestId ?? "";
            yield ev;
            if (isTerminal(ev)) return;
          }
        }
      }
    } catch (err) {
      if (signal?.aborted) {
        yield { kind: "cancelled" };
        return;
      }
      /* the stream dropped: fall through to polling */
    }
    yield* this.poll(runId, seenApproval, signal);
  }

  private async *poll(runId: string, seenApproval: string | null, signal?: AbortSignal): AsyncGenerator<BrainEvent> {
    for (;;) {
      if (signal?.aborted) {
        yield { kind: "cancelled" };
        return;
      }
      const r = await this.request<Record<string, unknown>>("GET", `/v1/runs/${runId}`, undefined, undefined, signal);
      if (r.status !== 200 || !r.data) {
        yield { kind: "failed", error: this.fail(r.status, r.data, "status").message };
        return;
      }
      const terminal = terminalFromStatus(r.data);
      if (terminal) {
        yield terminal;
        return;
      }
      if (str(r.data.status) === "waiting_for_approval" && r.data.approval && typeof r.data.approval === "object") {
        const ev = approvalEvent(r.data.approval as Record<string, unknown>);
        const key = ev.kind === "approval" ? (ev.requestId ?? "") : "";
        if (seenApproval !== key) {
          seenApproval = key;
          yield ev;
        }
      }
      await this.sleep(this.pollMs);
    }
  }

  async approve(runId: string, choice: ApprovalChoice, requestId?: string | null): Promise<void> {
    const r = await this.request("POST", `/v1/runs/${runId}/approval`, requestId ? { choice, request_id: requestId } : { choice });
    if (r.status >= 300) throw this.fail(r.status, r.data, "approval");
  }

  async steer(runId: string, text: string): Promise<void> {
    const r = await this.request("POST", `/v1/runs/${runId}/steer`, { message: text });
    if (r.status >= 300) throw this.fail(r.status, r.data, "steer");
  }

  async stop(runId: string): Promise<void> {
    const r = await this.request("POST", `/v1/runs/${runId}/stop`);
    if (r.status >= 300 && r.status !== 409) throw this.fail(r.status, r.data, "stop");
  }

  /** GET /v1/health with the key, so a misconfiguration shows up at startup, not mid-command. */
  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const r = await this.request<{ status?: string; version?: string }>("GET", "/v1/health");
      if (r.status === 200) return { ok: true, detail: `hermes-agent ${r.data?.version ?? ""}`.trim() };
      return { ok: false, detail: this.fail(r.status, r.data, "health").message };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** The brain from the environment; the current conversation is remembered in ~/.jev/state.json
 *  unless HERMES_SESSION_ID pins one. HERMES_VOICE_MODEL (+ HERMES_VOICE_PROVIDER) picks the
 *  model the voice conversation runs on; changing it starts a new conversation, since Hermes
 *  keeps a session on the model it was created with. */
export function createBrain(env: NodeJS.ProcessEnv = process.env, state: HermesOptions["state"] | null | undefined = undefined): HermesBrain | null {
  const apiKey = env.HERMES_API_KEY?.trim();
  if (!apiKey) return null;
  const model = env.HERMES_VOICE_MODEL?.trim() || undefined;
  const provider = env.HERMES_VOICE_PROVIDER?.trim() || (model ? "ollama-cloud" : undefined);
  return new HermesBrain({
    baseUrl: env.HERMES_API_URL?.trim() || "http://127.0.0.1:8642",
    apiKey,
    sessionId: env.HERMES_SESSION_ID?.trim() || undefined,
    state: state === undefined ? sessionStore(model) : (state ?? undefined),
    model,
    provider,
    instructions: loadVoiceInstructions(),
  });
}

/** The remembered conversation, but only if it runs on the model configured now. */
export function sessionStore(model: string | undefined, file?: string): HermesOptions["state"] {
  return {
    get: () => {
      const s = readState(file);
      return (s.hermesModel ?? undefined) === model ? s.hermesSessionId : undefined;
    },
    set: (id) => {
      try {
        writeState({ hermesSessionId: id, hermesModel: model ?? null }, file);
      } catch {
        /* a read-only home is not fatal: the session just is not remembered */
      }
    },
  };
}
