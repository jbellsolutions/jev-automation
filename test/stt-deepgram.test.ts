import { describe, expect, it } from "vitest";
import { DeepgramProvider, type SocketLike, deepgramUrl, parseDeepgramMessage } from "../server/stt/deepgram.js";
import type { SttEvent } from "../server/stt/types.js";

const start = { sampleRate: 16000, encoding: "pcm_s16le" as const, channels: 1, lang: "en-US", keywords: ["Jev", "Hermes"] };

describe("deepgramUrl", () => {
  it("uses the documented streaming parameters and keyterm on nova-3", () => {
    const u = new URL(deepgramUrl(start, { apiKey: "k" }));
    expect(u.origin + u.pathname).toBe("wss://api.deepgram.com/v1/listen");
    const q = u.searchParams;
    expect(q.get("model")).toBe("nova-3");
    expect(q.get("encoding")).toBe("linear16");
    expect(q.get("sample_rate")).toBe("16000");
    expect(q.get("channels")).toBe("1");
    expect(q.get("interim_results")).toBe("true");
    expect(q.get("endpointing")).toBe("300");
    expect(q.get("utterance_end_ms")).toBe("1000");
    expect(q.get("vad_events")).toBe("true");
    expect(q.get("smart_format")).toBe("true");
    expect(q.get("language")).toBe("en");
    expect(q.getAll("keyterm")).toEqual(["Jev", "Hermes"]);
    expect(q.has("keywords")).toBe(false);
  });

  it("falls back to `keywords` on models without keyterm support", () => {
    const q = new URL(deepgramUrl(start, { apiKey: "k", model: "nova-2" })).searchParams;
    expect(q.getAll("keywords")).toEqual(["Jev", "Hermes"]);
    expect(q.has("keyterm")).toBe(false);
  });

  it("never puts the key in the URL", () => {
    expect(deepgramUrl(start, { apiKey: "sekrit" })).not.toContain("sekrit");
  });
});

describe("parseDeepgramMessage", () => {
  it("maps Results, UtteranceEnd and ignores the rest", () => {
    expect(parseDeepgramMessage(JSON.stringify({ type: "Results", is_final: true, speech_final: true, channel: { alternatives: [{ transcript: "hi" }] } }))).toEqual({
      type: "transcript",
      text: "hi",
      final: true,
      speechFinal: true,
    });
    expect(parseDeepgramMessage(JSON.stringify({ type: "Results", channel: { alternatives: [{ transcript: "h" }] } }))).toEqual({ type: "transcript", text: "h", final: false, speechFinal: false });
    expect(parseDeepgramMessage(JSON.stringify({ type: "UtteranceEnd", last_word_end: 1.2 }))).toEqual({ type: "utterance_end" });
    expect(parseDeepgramMessage(JSON.stringify({ type: "Metadata" }))).toBeNull();
    expect(parseDeepgramMessage(JSON.stringify({ type: "SpeechStarted" }))).toBeNull();
    expect(parseDeepgramMessage("not json")).toBeNull();
  });
});

class FakeSocket implements SocketLike {
  readyState = 0;
  bufferedAmount = 0;
  sent: Array<string | Uint8Array> = [];
  closed = false;
  handlers: Record<string, ((...a: never[]) => void)[]> = {};
  url = "";
  headers: Record<string, string> = {};
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.fire("close", 1000, "");
  }
  on(event: string, cb: (...a: never[]) => void) {
    (this.handlers[event] ??= []).push(cb);
  }
  fire(event: string, ...args: unknown[]) {
    for (const h of this.handlers[event] ?? []) (h as (...a: unknown[]) => void)(...args);
  }
  open() {
    this.readyState = 1;
    this.fire("open");
  }
}

describe("DeepgramProvider", () => {
  it("authenticates with the Token header, streams audio, and finalizes on finish", () => {
    let sock!: FakeSocket;
    const provider = new DeepgramProvider({
      apiKey: "abc",
      connect: (url, headers) => {
        sock = new FakeSocket();
        sock.url = url;
        sock.headers = headers;
        return sock;
      },
    });
    const events: SttEvent[] = [];
    const stream = provider.open(start, (e) => events.push(e));
    expect(sock.headers).toEqual({ Authorization: "Token abc" });
    stream.send(new Uint8Array([1, 2])); // before open: dropped
    sock.open();
    expect(events).toEqual([{ type: "open" }]);
    stream.send(new Uint8Array([1, 2, 3]));
    expect(sock.sent).toEqual([new Uint8Array([1, 2, 3])]);
    sock.fire("message", JSON.stringify({ type: "Results", is_final: false, channel: { alternatives: [{ transcript: "op" }] } }));
    expect(events.at(-1)).toEqual({ type: "transcript", text: "op", final: false, speechFinal: false });
    stream.finish();
    expect(sock.sent.at(-1)).toBe(JSON.stringify({ type: "Finalize" }));
    stream.send(new Uint8Array([9])); // after finish: dropped
    sock.fire("message", JSON.stringify({ type: "Results", is_final: true, speech_final: true, channel: { alternatives: [{ transcript: "open" }] } }));
    expect(sock.sent.at(-1)).toBe(JSON.stringify({ type: "CloseStream" }));
    sock.close();
    expect(events.at(-1)).toEqual({ type: "closed" });
    stream.close();
  });

  it("drops audio when the provider socket is backed up", () => {
    let sock!: FakeSocket;
    const provider = new DeepgramProvider({ apiKey: "abc", maxBufferedBytes: 10, connect: () => (sock = new FakeSocket()) });
    const stream = provider.open(start, () => {});
    sock.open();
    sock.bufferedAmount = 11;
    stream.send(new Uint8Array([1]));
    expect(sock.sent).toEqual([]);
    stream.close();
  });

  it("reports abnormal closes as errors", () => {
    let sock!: FakeSocket;
    const provider = new DeepgramProvider({ apiKey: "abc", connect: () => (sock = new FakeSocket()) });
    const events: SttEvent[] = [];
    provider.open(start, (e) => events.push(e));
    sock.open();
    sock.fire("close", 1008, "bad key");
    expect(events.map((e) => e.type)).toEqual(["open", "error", "closed"]);
    expect(events[1]).toMatchObject({ message: expect.stringContaining("1008") });
  });
});
