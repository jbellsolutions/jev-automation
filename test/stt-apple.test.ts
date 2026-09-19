import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AppleSpeechProvider } from "../server/stt/apple.js";
import { FallbackProvider } from "../server/stt/fallback.js";
import type { SttEvent, SttProvider, SttStart, SttStream } from "../server/stt/types.js";

const start: SttStart = { sampleRate: 16000, encoding: "pcm_s16le", channels: 1, lang: "en-US", keywords: ["Jev"] };

/** A fake jev-speech child: JSON lines in via `say`, PCM out via stdin. */
function fakeChild() {
  class Child extends EventEmitter {
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    killed = false;
    kill(sig?: string) {
      this.killed = true;
      void sig;
      queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
      return true;
    }
  }
  const child = new Child();
  const say = (obj: unknown) => child.stdout.write(`${JSON.stringify(obj)}\n`);
  const received: Buffer[] = [];
  child.stdin.on("data", (d: Buffer) => received.push(d));
  return { child, say, received };
}

describe("AppleSpeechProvider", () => {
  it("spawns the helper with rate, locale and keywords; maps its lines to events", async () => {
    const fake = fakeChild();
    let spawned: { bin: string; args: string[] } | null = null;
    const provider = new AppleSpeechProvider({
      bin: "/x/jev-speech",
      spawn: ((bin: string, args: string[]) => {
        spawned = { bin, args };
        return fake.child;
      }) as never,
    });
    const events: SttEvent[] = [];
    const stream = provider.open(start, (e) => events.push(e));
    expect(spawned).toEqual({ bin: "/x/jev-speech", args: ["16000", "en-US", "Jev"] });
    fake.say({ type: "ready", onDevice: true });
    fake.say({ type: "transcript", text: "open wiki", final: false });
    fake.say({ type: "transcript", text: "Open Wikipedia.", final: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual([
      { type: "open" },
      { type: "transcript", text: "open wiki", final: false, speechFinal: false },
      { type: "transcript", text: "Open Wikipedia.", final: true, speechFinal: true },
    ]);
    stream.send(new Uint8Array([1, 2, 3]));
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.received.map((b) => Array.from(b))).toEqual([[1, 2, 3]]);
    stream.finish();
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.child.stdin.writableEnded).toBe(true);
    fake.child.emit("exit", 0, null);
    expect(events.at(-1)).toEqual({ type: "closed" });
  });

  it("reports a non-zero exit as an error, and close() kills the helper", async () => {
    const fake = fakeChild();
    const provider = new AppleSpeechProvider({ bin: "/x", spawn: (() => fake.child) as never });
    const events: SttEvent[] = [];
    const stream = provider.open(start, (e) => events.push(e));
    fake.child.stderr.write("boom");
    fake.child.emit("exit", 3, null);
    expect(events.map((e) => e.type)).toEqual(["error", "closed"]);
    expect(events[0]).toMatchObject({ message: expect.stringContaining("exited 3") });
    const fake2 = fakeChild();
    const p2 = new AppleSpeechProvider({ bin: "/x", spawn: (() => fake2.child) as never });
    const s2 = p2.open(start, () => {});
    s2.close();
    expect(fake2.child.killed).toBe(true);
    void stream;
  });
});

class ScriptedProvider implements SttProvider {
  opened = 0;
  audio: Uint8Array[] = [];
  finished = 0;
  closed = 0;
  emit: ((ev: SttEvent) => void) | null = null;
  constructor(
    readonly name: string,
    private readonly behaviour: "open" | "fail-before-open",
  ) {}
  open(_s: SttStart, onEvent: (ev: SttEvent) => void): SttStream {
    this.opened++;
    this.emit = onEvent;
    if (this.behaviour === "open") queueMicrotask(() => onEvent({ type: "open" }));
    else
      queueMicrotask(() => {
        onEvent({ type: "error", message: "402" });
        onEvent({ type: "closed" });
      });
    return { send: (a) => this.audio.push(a), finish: () => this.finished++, close: () => this.closed++ };
  }
}

describe("FallbackProvider", () => {
  it("moves to the next provider when the first fails before opening, replaying buffered audio", async () => {
    const a = new ScriptedProvider("deepgram", "fail-before-open");
    const b = new ScriptedProvider("apple", "open");
    const fb = new FallbackProvider([a, b]);
    const events: SttEvent[] = [];
    const stream = fb.open(start, (e) => events.push(e));
    stream.send(new Uint8Array([7]));
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual([{ type: "error", message: "deepgram: 402 — trying apple" }, { type: "open" }]);
    expect(fb.name).toBe("apple");
    expect(b.audio.map((x) => Array.from(x))).toEqual([[7]]);
    stream.send(new Uint8Array([8]));
    expect(b.audio).toHaveLength(2);
    b.emit!({ type: "transcript", text: "hi", final: true, speechFinal: true });
    expect(events.at(-1)).toMatchObject({ type: "transcript", text: "hi" });
    stream.finish();
    expect(b.finished).toBe(1);
  });

  it("uses the first provider when it opens, and closes when all fail", async () => {
    const a = new ScriptedProvider("deepgram", "open");
    const b = new ScriptedProvider("apple", "open");
    const fb = new FallbackProvider([a, b]);
    const events: SttEvent[] = [];
    fb.open(start, (e) => events.push(e));
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual([{ type: "open" }]);
    expect(b.opened).toBe(0);

    const c = new ScriptedProvider("x", "fail-before-open");
    const d = new ScriptedProvider("y", "fail-before-open");
    const events2: SttEvent[] = [];
    new FallbackProvider([c, d]).open(start, (e) => events2.push(e));
    await new Promise((r) => setTimeout(r, 10));
    expect(events2.map((e) => e.type)).toEqual(["error", "error", "closed"]);
  });
});
