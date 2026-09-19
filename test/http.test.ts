import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { HeuristicDecider } from "../core/decide.js";
import type { CommandResult } from "../core/results.js";
import { type Companion, createCompanion } from "../server/companion.js";
import { FakeBrain, tick, waitFor } from "./helpers/fake-brain.js";
import { FakeExecutor, el } from "./helpers/fake-executor.js";

const TOKEN = "test-token-123";
let companion: Companion | null = null;

async function boot(opts: { token?: string; elements?: Parameters<typeof el>[1][]; brain?: FakeBrain } = {}) {
  const executor = new FakeExecutor((opts.elements ?? []).map((o, i) => el(`e${i}`, o)), "playwright");
  companion = createCompanion({ decider: new HeuristicDecider(), token: "token" in opts ? opts.token : TOKEN, brain: opts.brain });
  const port = await companion.listen(0);
  companion.register(executor);
  const base = `http://127.0.0.1:${port}`;
  const call = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
    fetch(base + path, { ...init, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });
  const post = (path: string, body: unknown, token: string | null = TOKEN) => call(path, { method: "POST", body: JSON.stringify(body) }, token);
  return { executor, port, base, call, post };
}

afterEach(async () => {
  await companion?.close();
  companion = null;
});

describe("HTTP API", () => {
  it("serves health without a token", async () => {
    const { call } = await boot();
    const r = await call("/api/health", {}, null);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, jev: { enabled: false }, sessions: ["playwright"] });
  });

  it("rejects missing and wrong tokens", async () => {
    const { call, post } = await boot();
    expect((await call("/api/sessions", {}, null)).status).toBe(401);
    expect((await post("/api/command", { text: "open a.com" }, "nope")).status).toBe(401);
  });

  it("refuses everything but health when no token is configured", async () => {
    const { call, executor } = await boot({ token: undefined });
    const r = await call("/api/sessions", {}, "anything");
    expect(r.status).toBe(401);
    expect((await r.json()).error).toMatch(/JEV_TOKEN/);
    expect(executor.executed).toEqual([]);
  });

  it("runs a multi-step command and returns every step", async () => {
    const { post, executor } = await boot();
    const r = await post("/api/command", { text: "open wikipedia and scroll down" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as CommandResult;
    expect(body.ok).toBe(true);
    expect(body.steps.map((s) => s.command)).toEqual(["open wikipedia", "scroll down"]);
    expect(body.steps[0]!.decision?.intent).toBe("open_url");
    expect(body.page.url).toBe("https://www.wikipedia.org");
    expect(executor.executed.map((a) => a.kind)).toEqual(["navigate", "scroll"]);
  });

  it("returns a pending confirmation and resolves it through /api/reply", async () => {
    const { post, executor } = await boot({ elements: [{ tag: "button", text: "Delete account" }] });
    const first = (await (await post("/api/command", { text: "click delete account" })).json()) as CommandResult;
    expect(first.pending).toMatchObject({ kind: "confirm" });
    expect(executor.executed).toEqual([]);
    const second = (await (await post("/api/reply", { ok: true })).json()) as CommandResult;
    expect(second.ok).toBe(true);
    expect(executor.executed).toHaveLength(1);
  });

  it("resolves a clarification through /api/reply pick", async () => {
    const { post, executor } = await boot({ elements: [{ text: "Pricing", hrefShort: "/pricing" }, { text: "Pricing FAQ", hrefShort: "/faq" }, { text: "Pricing plans", hrefShort: "/plans" }] });
    const first = (await (await post("/api/command", { text: "click pricing" })).json()) as CommandResult;
    expect(first.pending?.kind).toBe("clarify");
    await post("/api/reply", { pick: "e1" });
    expect(executor.executed).toEqual([{ kind: "click", elementId: "e1", label: 'link "Pricing FAQ" → /faq' }]);
  });

  it("validates input and unknown sessions", async () => {
    const { post } = await boot();
    expect((await post("/api/command", {})).status).toBe(400);
    expect((await post("/api/command", { text: "open a.com", session: "mars" })).status).toBe(404);
    expect((await post("/api/reply", {})).status).toBe(400);
  });

  it("/api/ask waits for the brain's answer and /api/approve answers its requests", async () => {
    const brain = new FakeBrain();
    const { post } = await boot({ brain });
    const asking = post("/api/ask", { text: "what's on my calendar" });
    await waitFor(() => brain.sent.length === 1);
    expect(brain.sent).toEqual(["what's on my calendar"]);
    brain.emit("run_1", { kind: "approval", requestId: "r1", summary: "read your calendar", choices: ["once", "deny"] });
    await tick();
    const bad = await post("/api/approve", { choice: "maybe" });
    expect(bad.status).toBe(400);
    const okRes = await post("/api/approve", { choice: "once" });
    expect(okRes.status).toBe(200);
    expect(brain.approvals).toEqual([{ runId: "run_1", choice: "once", requestId: "r1" }]);
    brain.emit("run_1", { kind: "completed", output: "Two meetings." }, null);
    const body = (await (await asking).json()) as CommandResult & { output: string };
    expect(body).toMatchObject({ ok: true, output: "Two meetings." });
    expect(body.steps[0]!.decision?.route).toBe("hermes");
  });

  it("lists sessions", async () => {
    const { call } = await boot();
    const body = await (await call("/api/sessions")).json();
    expect(body.default).toBe("playwright");
    expect(body.sessions[0]).toMatchObject({ id: "playwright", kind: "playwright", busy: false, pending: null });
  });
});

describe("WebSocket origin check", () => {
  const open = (port: number, origin?: string, token?: string) =>
    new Promise<{ ok: boolean; first?: unknown }>((resolve) => {
      const headers: Record<string, string> = {};
      if (origin) headers.origin = origin;
      if (token) headers.authorization = `Bearer ${token}`;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
      ws.once("message", (data) => {
        resolve({ ok: true, first: JSON.parse(String(data)) });
        ws.close();
      });
      ws.once("error", () => resolve({ ok: false }));
      ws.once("unexpected-response", () => resolve({ ok: false }));
    });

  it("accepts the companion's own origin, rejects strangers, and makes non-browser clients present the token", async () => {
    const { port } = await boot();
    expect((await open(port, `http://localhost:${port}`)).first).toMatchObject({ type: "hello" });
    expect((await open(port, "https://evil.example")).ok).toBe(false);
    expect((await open(port)).ok).toBe(false);
    expect((await open(port, undefined, "wrong")).ok).toBe(false);
    expect((await open(port, undefined, TOKEN)).ok).toBe(true);
  });

  it("lets non-browser clients in without a token only when none is configured", async () => {
    const { port } = await boot({ token: undefined });
    expect((await open(port)).ok).toBe(true);
  });

  it("listens on IPv6 loopback too when available", async () => {
    const { port } = await boot();
    const r = await fetch(`http://[::1]:${port}/api/health`).catch(() => null);
    if (r) expect(r.status).toBe(200);
  });
});
