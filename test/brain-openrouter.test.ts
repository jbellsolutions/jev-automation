import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { BrainEvent } from "../core/brain.js";
import { BRAIN_INSTRUCTIONS, DEFAULT_MODEL, OpenRouterBrain, chunkDelta, createBrain, parseSseFrames } from "../server/brain/openrouter.js";

describe("parseSseFrames", () => {
  it("returns complete frames' data, keeps the tail, and flags [DONE]", () => {
    const { events, rest, done } = parseSseFrames('data: {"a":1}\n\ndata: {"b":\n');
    expect(events).toEqual([{ a: 1 }]);
    expect(rest).toBe('data: {"b":\n');
    expect(done).toBe(false);
  });
  it("joins multi-line data, skips non-JSON, and stops on [DONE]", () => {
    const { events, done } = parseSseFrames('data: {"a":\ndata: 2}\n\ndata: nope\n\ndata: [DONE]\n\n');
    expect(events).toEqual([{ a: 2 }]);
    expect(done).toBe(true);
  });
});

describe("chunkDelta", () => {
  it("reads the delta content out of a chat-completion chunk", () => {
    expect(chunkDelta({ choices: [{ delta: { content: "hi" }, index: 0 }] })).toBe("hi");
    expect(chunkDelta({ choices: [{ delta: { role: "assistant" }, index: 0 }] })).toBe(""); // first chunk: role only
    expect(chunkDelta({ choices: [] })).toBe("");
    expect(chunkDelta(null)).toBe("");
    expect(chunkDelta("junk")).toBe("");
  });
});

/** Just enough of OpenRouter's chat-completions + key endpoints to drive OpenRouterBrain. */
class FakeOpenRouter {
  server: http.Server;
  baseUrl = "";
  requests: Array<{ path: string; headers: http.IncomingHttpHeaders; body: unknown }> = [];
  private res: http.ServerResponse | null = null;
  /** Called for each POST to /api/v1/chat/completions; the test drives the response from here. */
  onCompletion: ((res: http.ServerResponse, body: Record<string, unknown>) => void) | null = null;
  /** Called for GET /api/v1/key; defaults to a 200 with a label. */
  onKey: ((res: http.ServerResponse) => void) | null = null;

  constructor() {
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }

  async listen(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    return (this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`);
  }

  close(): Promise<void> {
    this.res?.destroy();
    return new Promise((r) => this.server.close(() => r()));
  }

  /** A `fetch` that keeps the real ENDPOINT's path but redirects the origin here. */
  fetch: typeof fetch = (input, init) => {
    const u = new URL(String(input));
    return fetch(`${this.baseUrl}${u.pathname}`, init);
  };

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : null;
    const path = req.url ?? "";
    this.requests.push({ path, headers: req.headers, body });
    if (path === "/api/v1/key") {
      if (this.onKey) return this.onKey(res);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { label: "jev" } }));
      return;
    }
    if (path === "/api/v1/chat/completions") {
      this.res = res;
      if (this.onCompletion) return this.onCompletion(res, body);
      res.writeHead(500).end();
      return;
    }
    res.writeHead(404).end();
  }

  /** Start an SSE response and hold it open for `sendChunk`/`sendDone` calls. */
  startStream(res: http.ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream" });
  }

  sendChunk(res: http.ServerResponse, content: string): void {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, index: 0, finish_reason: null }] })}\n\n`);
  }

  sendDone(res: http.ServerResponse): void {
    res.write("data: [DONE]\n\n");
    res.end();
  }

  jsonError(res: http.ServerResponse, status: number, message: string): void {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message } }));
  }
}

let fake: FakeOpenRouter | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

async function boot(opts: Partial<ConstructorParameters<typeof OpenRouterBrain>[0]> = {}) {
  fake = new FakeOpenRouter();
  await fake.listen();
  const brain = new OpenRouterBrain({ apiKey: "k", fetch: fake.fetch, ...opts });
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

describe("OpenRouterBrain", () => {
  it("sends the system instructions + history, streams deltas, and remembers the turn", async () => {
    const { brain, fake } = await boot();
    fake.onCompletion = (res) => {
      fake!.startStream(res);
      fake!.sendChunk(res, "All ");
      fake!.sendChunk(res, "good.");
      fake!.sendDone(res);
    };
    const run = await brain.send("what's up");
    expect(run.id).toMatch(/^[0-9a-f-]{36}$/);
    const events = await collect(run.events);
    expect(events).toEqual([{ kind: "delta", text: "All " }, { kind: "delta", text: "good." }, { kind: "completed", output: "All good." }]);

    const admit = fake.requests.find((r) => r.path === "/api/v1/chat/completions")!;
    expect(admit.headers.authorization).toBe("Bearer k");
    expect(admit.body).toEqual({
      model: DEFAULT_MODEL,
      messages: [{ role: "system", content: BRAIN_INSTRUCTIONS }, { role: "user", content: "what's up" }],
      stream: true,
    });

    // a second turn carries the first exchange forward
    fake.onCompletion = (res) => {
      fake!.startStream(res);
      fake!.sendChunk(res, "Still good.");
      fake!.sendDone(res);
    };
    await collect((await brain.send("and now")).events);
    const second = fake.requests.filter((r) => r.path === "/api/v1/chat/completions")[1]!;
    expect((second.body as { messages: unknown[] }).messages).toEqual([
      { role: "system", content: BRAIN_INSTRUCTIONS },
      { role: "user", content: "what's up" },
      { role: "assistant", content: "All good." },
      { role: "user", content: "and now" },
    ]);
  });

  it("reset() and send(fresh) both start a clean thread", async () => {
    const { brain, fake } = await boot();
    fake.onCompletion = (res) => {
      fake!.startStream(res);
      fake!.sendChunk(res, "hi");
      fake!.sendDone(res);
    };
    await collect((await brain.send("one")).events);
    await brain.reset();
    await collect((await brain.send("two")).events);
    let last = fake.requests.at(-1)!;
    expect((last.body as { messages: { content: string }[] }).messages.map((m) => m.content)).toEqual([BRAIN_INSTRUCTIONS, "two"]);

    await collect((await brain.send("three", { fresh: true })).events);
    last = fake.requests.at(-1)!;
    expect((last.body as { messages: { content: string }[] }).messages.map((m) => m.content)).toEqual([BRAIN_INSTRUCTIONS, "three"]);
  });

  it("a 4xx response is a model error; a 5xx is not", async () => {
    const { brain, fake } = await boot();
    fake.onCompletion = (res) => fake!.jsonError(res, 400, "context length exceeded");
    const bad = await collect((await brain.send("x")).events);
    expect(bad).toEqual([{ kind: "failed", error: "OpenRouter: HTTP 400: context length exceeded", modelError: true }]);

    fake.onCompletion = (res) => fake!.jsonError(res, 502, "upstream error");
    const worse = await collect((await brain.send("y")).events);
    expect(worse).toEqual([{ kind: "failed", error: "OpenRouter: HTTP 502: upstream error", modelError: false }]);
  });

  it("an unreachable server fails without hanging", async () => {
    const brain = new OpenRouterBrain({ apiKey: "k", fetch: () => fetch("http://127.0.0.1:1") });
    const events = await collect((await brain.send("x")).events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "failed", modelError: false });
  });

  it("stop() cancels an in-flight run", async () => {
    const { brain, fake } = await boot();
    let held: http.ServerResponse | null = null;
    fake.onCompletion = (res) => {
      fake!.startStream(res);
      held = res;
    };
    const run = await brain.send("x");
    const events = collect(run.events);
    await new Promise((r) => setTimeout(r, 20));
    await brain.stop(run.id);
    expect(await events).toEqual([{ kind: "cancelled" }]);
    held!.destroy();
  });

  it("steer() aborts the in-flight request, appends the message, and continues the same stream", async () => {
    const { brain, fake } = await boot();
    let firstRes: http.ServerResponse | null = null;
    let calls = 0;
    fake.onCompletion = (res, body) => {
      calls++;
      if (calls === 1) {
        fake!.startStream(res);
        firstRes = res;
        return; // held open: never completes on its own
      }
      // second call: the steered request
      expect((body.messages as { content: string }[]).map((m) => m.content)).toEqual([BRAIN_INSTRUCTIONS, "find a hotel", "also near the louvre"]);
      fake!.startStream(res);
      fake!.sendChunk(res, "Found one.");
      fake!.sendDone(res);
    };
    const run = await brain.send("find a hotel");
    const events = collect(run.events);
    await new Promise((r) => setTimeout(r, 20));
    await brain.steer(run.id, "also near the louvre");
    expect(await events).toEqual([{ kind: "steered" }, { kind: "delta", text: "Found one." }, { kind: "completed", output: "Found one." }]);
    expect(calls).toBe(2);
    firstRes!.destroy();
  });

  it("approve() is a no-op", async () => {
    const { brain } = await boot();
    await expect(brain.approve("run_1", "once")).resolves.toBeUndefined();
  });

  it("health() reports ok on a valid key and the error otherwise", async () => {
    const { brain, fake } = await boot();
    expect(await brain.health()).toEqual({ ok: true, detail: `openrouter, ${DEFAULT_MODEL}` });
    fake.onKey = (res) => fake!.jsonError(res, 401, "No auth credentials found");
    expect(await brain.health()).toEqual({ ok: false, detail: "HTTP 401: No auth credentials found" });
  });

  it("createBrain needs the key, defaults the model, and honors JEV_BRAIN_MODEL", () => {
    expect(createBrain({})).toBeNull();
    const b = createBrain({ OPENROUTER_API_KEY: "abc" })!;
    expect(b).toBeInstanceOf(OpenRouterBrain);
    expect(b.name).toBe("Jev");
    const custom = createBrain({ OPENROUTER_API_KEY: "abc", JEV_BRAIN_MODEL: "some/other-model" })!;
    expect(custom).toBeInstanceOf(OpenRouterBrain);
  });
});
