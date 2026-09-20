import { mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrainEvent } from "../core/brain.js";
import { HermesBrain, VOICE_INSTRUCTIONS, createBrain, mapHermesEvent, parseSseFrames, sessionStore, terminalFromStatus } from "../server/hermes.js";
import { readState } from "../server/state.js";

/** Just enough of the Hermes API server (v0.21.1 wire shapes) to drive HermesBrain. */
class FakeHermes {
  server: http.Server;
  url = "";
  sessions = new Set<string>();
  runs = new Map<string, { status: Record<string, unknown>; queue: Array<Record<string, unknown> | null>; wake: (() => void) | null; res: http.ServerResponse | null }>();
  requests: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders; body: unknown }> = [];
  /** Kill the SSE connection after this many events (simulates a dropped stream). */
  dropAfter = Infinity;
  private ids = 0;

  constructor(private readonly key = "k") {
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }

  async listen(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    return (this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`);
  }
  close(): Promise<void> {
    for (const r of this.runs.values()) r.res?.destroy();
    return new Promise((r) => this.server.close(() => r()));
  }

  /** Push an event to a run's stream (null = end of stream). */
  emit(runId: string, ev: Record<string, unknown> | null): void {
    const run = this.runs.get(runId)!;
    if (ev?.event === "approval.request") run.status = { ...run.status, status: "waiting_for_approval", approval: ev };
    if (ev?.event === "run.completed") run.status = { ...run.status, status: "completed", output: ev.output };
    if (ev?.event === "run.failed") run.status = { ...run.status, status: "failed", error: ev.error };
    run.queue.push(ev);
    run.wake?.();
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : null;
    const path = req.url ?? "";
    this.requests.push({ method: req.method ?? "", path, headers: req.headers, body });
    if (req.headers.authorization !== `Bearer ${this.key}`) return this.json(res, 401, { error: { message: "Invalid API key", code: "invalid_api_key" } });
    if (path === "/v1/health") return this.json(res, 200, { status: "ok", platform: "hermes-agent", version: "0.21.1" });
    if (path === "/api/sessions" && req.method === "POST") {
      const id = String(body?.id ?? "");
      if (this.sessions.has(id)) return this.json(res, 409, { error: { message: "Session already exists", code: "session_exists" } });
      this.sessions.add(id);
      return this.json(res, 201, { id, title: body?.title });
    }
    if (path === "/v1/runs" && req.method === "POST") {
      if (!body?.input) return this.json(res, 400, { error: { message: "Missing 'input' field" } });
      const id = `run_${++this.ids}`;
      this.runs.set(id, { status: { object: "hermes.run", run_id: id, status: "queued", session_id: body.session_id }, queue: [], wake: null, res: null });
      return this.json(res, 202, { run_id: id, status: "queued", replayed: false });
    }
    const m = /^\/v1\/runs\/([^/]+)(?:\/(events|approval|steer|stop))?$/.exec(path);
    if (!m) return this.json(res, 404, { error: { message: "not found" } });
    const run = this.runs.get(m[1]!);
    if (!run) return this.json(res, 404, { error: { message: `Run not found: ${m[1]}`, code: "run_not_found" } });
    switch (m[2]) {
      case undefined:
        return this.json(res, 200, run.status);
      case "approval": {
        if (run.status.status !== "waiting_for_approval") return this.json(res, 409, { error: { message: "no approval pending", code: "approval_not_pending" } });
        run.status = { ...run.status, status: "running" };
        this.emit(m[1]!, { event: "approval.responded", run_id: m[1], choice: body.choice });
        return this.json(res, 200, { run_id: m[1], choice: body.choice, resolved: true });
      }
      case "steer":
        return this.json(res, 200, { object: "hermes.run.steer", run_id: m[1], accepted: true });
      case "stop":
        run.status = { ...run.status, status: "cancelled" };
        this.emit(m[1]!, { event: "run.cancelled", run_id: m[1] });
        this.emit(m[1]!, null);
        return this.json(res, 200, { run_id: m[1], status: "stopping" });
      case "events": {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        run.res = res;
        let sent = 0;
        for (;;) {
          if (run.queue.length === 0) await new Promise<void>((r) => (run.wake = r));
          run.wake = null;
          const ev = run.queue.shift()!;
          if (ev === null) {
            res.write(": stream closed\n\n");
            res.end();
            return;
          }
          if (sent === 0) res.write(": keepalive\n\n");
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
          if (++sent >= this.dropAfter) {
            await new Promise((r) => setTimeout(r, 10)); // let the frame flush, then drop the socket
            res.destroy();
            return;
          }
        }
      }
    }
  }
}

let fake: FakeHermes | null = null;
process.env.JEV_HOME = mkdtempSync(path.join(tmpdir(), "jev-home-")); // createBrain's session store must not touch ~/.jev
afterEach(async () => {
  await fake?.close();
  fake = null;
});

async function boot(opts: Partial<ConstructorParameters<typeof HermesBrain>[0]> = {}) {
  fake = new FakeHermes();
  const url = await fake.listen();
  const brain = new HermesBrain({ baseUrl: url, apiKey: "k", pollMs: 5, sessionId: "jev-voice", ...opts });
  return { brain, fake };
}

const terminal = (e: BrainEvent): boolean => e.kind === "completed" || e.kind === "failed" || e.kind === "cancelled";
async function collect(events: AsyncIterable<BrainEvent>, until: (e: BrainEvent) => boolean = terminal): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const e of events) {
    out.push(e);
    if (until(e)) break;
  }
  return out;
}

describe("parseSseFrames", () => {
  it("returns complete frames' data and keeps the tail", () => {
    const { events, rest } = parseSseFrames(': keepalive\n\ndata: {"a":1}\n\ndata: {"b":\n');
    expect(events).toEqual([{ a: 1 }]);
    expect(rest).toBe('data: {"b":\n');
  });
  it("joins multi-line data and skips non-JSON", () => {
    expect(parseSseFrames('event: x\ndata: {"a":\ndata: 2}\n\ndata: nope\n\n').events).toEqual([{ a: 2 }]);
  });
});

describe("mapHermesEvent / terminalFromStatus", () => {
  it("maps the run lifecycle", () => {
    expect(mapHermesEvent({ event: "message.delta", delta: "hi" })).toEqual({ kind: "delta", text: "hi" });
    expect(mapHermesEvent({ event: "tool.started", tool: "web_search", preview: "cats" })).toEqual({ kind: "tool_start", tool: "web_search", preview: "cats" });
    expect(mapHermesEvent({ event: "tool.completed", tool: "web_search", duration: 1.234, error: false })).toEqual({ kind: "tool_end", tool: "web_search", durationMs: 1234, error: false });
    expect(mapHermesEvent({ event: "approval.request", command: "rm -rf build", request_id: "r1", choices: ["once", "deny"] })).toEqual({ kind: "approval", requestId: "r1", summary: "rm -rf build", choices: ["once", "deny"] });
    expect(mapHermesEvent({ event: "approval.request", description: "send the email", choices: ["bogus"] })).toEqual({ kind: "approval", requestId: null, summary: "send the email", choices: ["once", "deny"] });
    expect(mapHermesEvent({ event: "run.completed", output: "done", usage: {} })).toEqual({ kind: "completed", output: "done" });
    expect(mapHermesEvent({ event: "run.failed", error: "boom" })).toEqual({ kind: "failed", error: "boom", modelError: false });
    expect(mapHermesEvent({ event: "run.failed", error: "ollama-cloud kimi-k3 HTTP 400 Bad Request" })).toEqual({ kind: "failed", error: "ollama-cloud kimi-k3 HTTP 400 Bad Request", modelError: true });
    expect(mapHermesEvent({ event: "run.cancelled" })).toEqual({ kind: "cancelled" });
    expect(mapHermesEvent({ event: "subagent.start", goal: "x" })).toBeNull();
    expect(mapHermesEvent("junk")).toBeNull();
  });
  it("reads terminal statuses", () => {
    expect(terminalFromStatus({ status: "completed", output: "42" })).toEqual({ kind: "completed", output: "42" });
    expect(terminalFromStatus({ status: "failed", error: "context length exceeded" })).toEqual({ kind: "failed", error: "context length exceeded", modelError: true });
    expect(terminalFromStatus({ status: "interrupted", error: "restart" })).toEqual({ kind: "cancelled" });
    expect(terminalFromStatus({ status: "running" })).toBeNull();
  });
});

describe("HermesBrain", () => {
  it("creates the session once, admits a run with an idempotency key and streams its events", async () => {
    const { brain, fake } = await boot();
    const run = await brain.send("what's up");
    expect(run.id).toBe("run_1");
    const admit = fake.requests.find((r) => r.path === "/v1/runs")!;
    expect(admit.body).toEqual({ input: "what's up", session_id: "jev-voice", instructions: VOICE_INSTRUCTIONS });
    expect(admit.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake.sessions.has("jev-voice")).toBe(true);
    const events = collect(run.events);
    fake.emit("run_1", { event: "tool.started", run_id: "run_1", tool: "web_search", preview: "x" });
    fake.emit("run_1", { event: "tool.completed", run_id: "run_1", tool: "web_search", duration: 0.5, error: false });
    fake.emit("run_1", { event: "message.delta", run_id: "run_1", delta: "All " });
    fake.emit("run_1", { event: "message.delta", run_id: "run_1", delta: "good." });
    fake.emit("run_1", { event: "run.completed", run_id: "run_1", output: "All good.", usage: { total_tokens: 3 } });
    fake.emit("run_1", null);
    expect((await events).map((e) => e.kind)).toEqual(["tool_start", "tool_end", "delta", "delta", "completed"]);
    // second run: no second session create
    await brain.send("and now");
    expect(fake.requests.filter((r) => r.path === "/api/sessions")).toHaveLength(1);
  });

  it("treats an existing session as fine on restart", async () => {
    const { brain, fake } = await boot();
    fake.sessions.add("jev-voice");
    await expect(brain.send("hi")).resolves.toMatchObject({ id: "run_1" });
  });

  it("surfaces approval requests, posts the choice, and continues", async () => {
    const { brain, fake } = await boot();
    const run = await brain.send("clean the build dir");
    const events = collect(run.events);
    fake.emit("run_1", { event: "approval.request", run_id: "run_1", command: "rm -rf build", request_id: "req9", choices: ["once", "session", "always", "deny"] });
    await new Promise((r) => setTimeout(r, 20));
    await brain.approve("run_1", "once", "req9");
    expect(fake.requests.at(-1)).toMatchObject({ path: "/v1/runs/run_1/approval", body: { choice: "once", request_id: "req9" } });
    fake.emit("run_1", { event: "run.completed", run_id: "run_1", output: "Cleaned." });
    fake.emit("run_1", null);
    expect(await events).toEqual([
      { kind: "approval", requestId: "req9", summary: "rm -rf build", choices: ["once", "session", "always", "deny"] },
      { kind: "approved", choice: "once" },
      { kind: "completed", output: "Cleaned." },
    ]);
  });

  it("rejects an approval nothing is waiting for", async () => {
    const { brain } = await boot();
    await brain.send("x");
    await expect(brain.approve("run_1", "once")).rejects.toThrow(/no approval pending/);
  });

  it("steers and stops", async () => {
    const { brain, fake } = await boot();
    const run = await brain.send("x");
    const events = collect(run.events);
    await brain.steer("run_1", "also the second one");
    expect(fake.requests.at(-1)).toMatchObject({ path: "/v1/runs/run_1/steer", body: { message: "also the second one" } });
    await brain.stop("run_1");
    expect((await events).at(-1)).toEqual({ kind: "cancelled" });
  });

  it("falls back to polling the status when the stream drops, and still delivers the output", async () => {
    const { brain, fake } = await boot();
    fake.dropAfter = 1;
    const run = await brain.send("x");
    const events = collect(run.events);
    fake.emit("run_1", { event: "tool.started", run_id: "run_1", tool: "terminal", preview: "ls" });
    await new Promise((r) => setTimeout(r, 30));
    fake.emit("run_1", { event: "run.completed", run_id: "run_1", output: "Polled answer" }); // never streamed: the socket is gone
    const got = await events;
    expect(got).toEqual([{ kind: "tool_start", tool: "terminal", preview: "ls" }, { kind: "completed", output: "Polled answer" }]);
    expect(fake.requests.filter((r) => r.method === "GET" && r.path === "/v1/runs/run_1").length).toBeGreaterThan(0);
  });

  it("reports an approval seen only through polling once", async () => {
    const { brain, fake } = await boot();
    fake.dropAfter = 1;
    const run = await brain.send("x");
    const events = collect(run.events, (e) => e.kind === "approval");
    fake.emit("run_1", { event: "message.delta", run_id: "run_1", delta: "hm" });
    await new Promise((r) => setTimeout(r, 20));
    fake.emit("run_1", { event: "approval.request", run_id: "run_1", command: "curl evil", request_id: "r2", choices: ["once", "deny"] });
    expect((await events).at(-1)).toEqual({ kind: "approval", requestId: "r2", summary: "curl evil", choices: ["once", "deny"] });
  });

  it("explains a bad key and an unreachable server", async () => {
    const { fake } = await boot();
    const wrong = new HermesBrain({ baseUrl: fake.url, apiKey: "nope" });
    await expect(wrong.send("x")).rejects.toThrow(/Hermes session: Invalid API key/);
    expect(await wrong.health()).toMatchObject({ ok: false });
    const gone = new HermesBrain({ baseUrl: "http://127.0.0.1:1", apiKey: "k" });
    await expect(gone.send("x")).rejects.toThrow(/unreachable/);
    const ok = new HermesBrain({ baseUrl: fake.url, apiKey: "k" });
    expect(await ok.health()).toEqual({ ok: true, detail: "hermes-agent 0.21.1" });
  });

  it("names sessions by time, remembers the current one, and leaves it behind on reset", async () => {
    const store: { id?: string } = {};
    const state = { get: () => store.id, set: (id: string) => void (store.id = id) };
    let t = new Date(2026, 8, 19, 18, 5, 7);
    const { brain, fake } = await boot({ sessionId: undefined, state, now: () => t, instructions: "be brief" });
    const first = brain.session;
    expect(first).toMatch(/^jev-voice-20260919-180507-[0-9a-f]{3}$/);
    await brain.send("hi");
    expect(store.id).toBe(first);
    expect(fake.requests.find((r) => r.path === "/v1/runs")!.body).toMatchObject({ session_id: first, instructions: "be brief" });

    await brain.reset(); // same second: still a different id
    expect(brain.session).not.toBe(first);
    expect(brain.session).toMatch(/^jev-voice-20260919-180507-/);
    t = new Date(2026, 8, 19, 18, 5, 9);
    await brain.send("again", { fresh: true });
    const third = brain.session;
    expect(third).toMatch(/^jev-voice-20260919-180509-/);
    expect(store.id).toBe(third);
    expect([...fake.sessions]).toEqual([first, third]);

    // a restart picks the remembered conversation up
    const again = new HermesBrain({ baseUrl: fake.url, apiKey: "k", state, now: () => t });
    expect(again.session).toBe(third);
    // and instructions can be switched off
    const quiet = new HermesBrain({ baseUrl: fake.url, apiKey: "k", sessionId: "s", instructions: null });
    await quiet.send("x");
    expect(fake.requests.at(-1)!.body).toEqual({ input: "x", session_id: "s" });
  });

  it("pins the voice model on the session it creates, and a model change means a new conversation", async () => {
    const { fake } = await boot();
    const file = path.join(process.env.JEV_HOME!, "state.json");
    const env = { HERMES_API_KEY: "k", HERMES_API_URL: fake.url, HERMES_VOICE_MODEL: "deepseek-v4.1-flash" };
    const a = createBrain(env, sessionStore("deepseek-v4.1-flash", file))!;
    await a.send("hi");
    expect(fake.requests.find((r) => r.path === "/api/sessions")!.body).toMatchObject({ id: a.session, model: "deepseek-v4.1-flash", provider: "ollama-cloud" });
    expect(fake.requests.find((r) => r.path === "/v1/runs")!.body).toMatchObject({ session_id: a.session, model: "deepseek-v4.1-flash", provider: "ollama-cloud" });
    expect(readState(file)).toEqual({ hermesSessionId: a.session, hermesModel: "deepseek-v4.1-flash" });
    // same model on restart: same conversation
    expect(createBrain(env, sessionStore("deepseek-v4.1-flash", file))!.session).toBe(a.session);
    // another model: the remembered conversation is left behind
    const b = createBrain({ ...env, HERMES_VOICE_MODEL: "glm-5.3-flash", HERMES_VOICE_PROVIDER: "ollama-cloud" }, sessionStore("glm-5.3-flash", file))!;
    expect(b.session).not.toBe(a.session);
    // no model at all: no model on the session body
    const plain = createBrain({ HERMES_API_KEY: "k", HERMES_API_URL: fake.url }, sessionStore(undefined, file))!;
    await plain.send("hi");
    expect(fake.requests.filter((r) => r.path === "/api/sessions").at(-1)!.body).toEqual({ id: plain.session, title: `Jev (voice) ${plain.session}`, source: "api_server" });
  });

  it("createBrain needs the key and defaults the URL", () => {
    expect(createBrain({})).toBeNull();
    const b = createBrain({ HERMES_API_KEY: "abc" })!;
    expect(b).toBeInstanceOf(HermesBrain);
    expect(b.name).toBe("Hermes");
  });
});
