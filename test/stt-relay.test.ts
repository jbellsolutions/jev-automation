import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { SttServerMessage } from "../core/protocol.js";
import { attachSttRelay } from "../server/stt/relay.js";
import type { SttEvent, SttProvider, SttStart, SttStream } from "../server/stt/types.js";

class FakeProvider implements SttProvider {
  readonly name = "fake";
  starts: SttStart[] = [];
  audio: Uint8Array[] = [];
  finished = 0;
  closed = 0;
  emit: ((ev: SttEvent) => void) | null = null;
  open(start: SttStart, onEvent: (ev: SttEvent) => void): SttStream {
    this.starts.push(start);
    this.emit = onEvent;
    queueMicrotask(() => onEvent({ type: "open" }));
    return {
      send: (a) => this.audio.push(a),
      finish: () => {
        this.finished++;
        // a real provider flushes its last final and then closes
        setTimeout(() => {
          onEvent({ type: "transcript", text: "tail", final: true, speechFinal: true });
          onEvent({ type: "closed" });
        }, 20);
      },
      close: () => this.closed++,
    };
  }
}

let servers: WebSocketServer[] = [];
let sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets) ws.terminate();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
  sockets = [];
});

async function pair(provider: SttProvider, gapMs = 800) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(wss);
  const utterances: string[] = [];
  wss.on("connection", (ws) => attachSttRelay(ws, { provider, gapMs, tickMs: 20, finishTimeoutMs: 200, onUtterance: (t) => utterances.push(t) }));
  await new Promise<void>((r) => wss.once("listening", r));
  const { port } = wss.address() as { port: number };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/stt`);
  sockets.push(ws);
  const received: SttServerMessage[] = [];
  ws.on("message", (d) => received.push(JSON.parse(String(d)) as SttServerMessage));
  await new Promise<void>((r) => ws.once("open", r));
  const waitFor = (pred: (m: SttServerMessage) => boolean, ms = 1000) =>
    new Promise<SttServerMessage>((resolve, reject) => {
      const hit = received.find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error(`timeout waiting; got ${JSON.stringify(received)}`)), ms);
      ws.on("message", function h(d) {
        const m = JSON.parse(String(d)) as SttServerMessage;
        if (pred(m)) {
          clearTimeout(t);
          ws.off("message", h);
          resolve(m);
        }
      });
    });
  return { ws, received, utterances, waitFor };
}

const START = { type: "start", sampleRate: 16000, encoding: "pcm_s16le", channels: 1, lang: "en-US", keywords: ["Jev"] };

describe("STT relay", () => {
  it("starts the provider, forwards audio, and turns finals into utterances", async () => {
    const provider = new FakeProvider();
    const { ws, received, utterances, waitFor } = await pair(provider);
    ws.send(JSON.stringify(START));
    await waitFor((m) => m.type === "ready");
    expect(received[0]).toEqual({ type: "ready", provider: "fake" });
    expect(provider.starts[0]).toMatchObject({ sampleRate: 16000, channels: 1, lang: "en-US", keywords: ["Jev"] });

    ws.send(new Uint8Array([1, 2, 3, 4]));
    await new Promise((r) => setTimeout(r, 30));
    expect(provider.audio.map((a) => Array.from(a))).toEqual([[1, 2, 3, 4]]);

    provider.emit!({ type: "transcript", text: "open wiki", final: false, speechFinal: false });
    await waitFor((m) => m.type === "transcript" && m.text === "open wiki");
    provider.emit!({ type: "transcript", text: "open wikipedia", final: true, speechFinal: true });
    const utt = await waitFor((m) => m.type === "utterance");
    expect(utt).toEqual({ type: "utterance", text: "open wikipedia" });
    expect(utterances).toEqual(["open wikipedia"]);
    // the display is cleared after an utterance
    await waitFor((m) => m.type === "transcript" && m.text === "");
  });

  it("flushes on a silent gap without provider help", async () => {
    const provider = new FakeProvider();
    const { ws, waitFor } = await pair(provider, 50);
    ws.send(JSON.stringify(START));
    await waitFor((m) => m.type === "ready");
    provider.emit!({ type: "transcript", text: "scroll down", final: true, speechFinal: false });
    expect(await waitFor((m) => m.type === "utterance")).toEqual({ type: "utterance", text: "scroll down" });
  });

  it("stop lets the provider flush its last final before closing", async () => {
    const provider = new FakeProvider();
    const { ws, waitFor, utterances } = await pair(provider);
    ws.send(JSON.stringify(START));
    await waitFor((m) => m.type === "ready");
    ws.send(JSON.stringify({ type: "stop" }));
    await waitFor((m) => m.type === "closed");
    expect(provider.finished).toBe(1);
    expect(utterances).toEqual(["tail"]);
  });

  it("rejects unsupported formats and closes the provider when the UI goes away", async () => {
    const provider = new FakeProvider();
    const { ws, waitFor } = await pair(provider);
    ws.send(JSON.stringify({ ...START, sampleRate: 96000 }));
    expect((await waitFor((m) => m.type === "error")).type).toBe("error");
    expect(provider.starts).toHaveLength(0);
    ws.send(JSON.stringify(START));
    await waitFor((m) => m.type === "ready");
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(provider.closed).toBe(1);
  });

  it("a second start replaces the first stream", async () => {
    const provider = new FakeProvider();
    const { ws, waitFor, received } = await pair(provider);
    ws.send(JSON.stringify(START));
    await waitFor((m) => m.type === "ready");
    const firstEmit = provider.emit!;
    ws.send(JSON.stringify(START));
    await new Promise((r) => setTimeout(r, 30));
    expect(provider.closed).toBe(1);
    expect(provider.starts).toHaveLength(2);
    firstEmit({ type: "transcript", text: "stale", final: true, speechFinal: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(received.some((m) => m.type === "utterance")).toBe(false);
  });
});
