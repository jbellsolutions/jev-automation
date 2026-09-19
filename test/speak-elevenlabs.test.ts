import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Speaker } from "../core/speak.js";
import { CHUNK_CHARS, ElevenLabsSpeaker, splitForSpeech } from "../server/speak/elevenlabs.js";
import type { Playback, Player } from "../server/speak/player.js";
import { DEFAULT_VOICE_ID, describeSpeaker, selectSpeaker } from "../server/speak/select.js";

describe("splitForSpeech", () => {
  it("keeps short text whole and joins sentences up to the chunk size", () => {
    expect(splitForSpeech("On it.")).toEqual(["On it."]);
    expect(splitForSpeech("  ")).toEqual([]);
    expect(splitForSpeech("Two meetings today. Standup at nine, lunch with Sam at noon. Anything else?")).toEqual(["Two meetings today. Standup at nine, lunch with Sam at noon. Anything else?"]);
  });
  it("cuts at sentence boundaries when the text is long", () => {
    const s = "This sentence is about sixty characters long, give or take a few. ";
    const chunks = splitForSpeech(s.repeat(8));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(CHUNK_CHARS);
      expect(c.endsWith(".")).toBe(true);
    }
    expect(chunks.join(" ")).toBe(s.repeat(8).trim());
  });
  it("breaks a single overlong sentence at clauses, then words, never mid-word", () => {
    const chunks = splitForSpeech(`${"word ".repeat(80)}end, and then ${"more ".repeat(60)}done`);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CHUNK_CHARS);
    expect(chunks.join(" ").split(" ")).toEqual(`${"word ".repeat(80)}end, and then ${"more ".repeat(60)}done`.split(" "));
  });
  it("keeps quotes and URLs inside their sentence", () => {
    expect(splitForSpeech('Opened "wikipedia.org". Then searched for cats.')).toEqual(['Opened "wikipedia.org". Then searched for cats.']);
  });
});

/** A player that records what it was fed and settles `done` when asked. */
class FakePlayer implements Player {
  readonly name = "fake";
  playbacks: Array<{ writes: string[]; ended: boolean; stopped: boolean; finish: () => void }> = [];
  open(): Playback {
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r));
    const rec = { writes: [] as string[], ended: false, stopped: false, finish };
    this.playbacks.push(rec);
    return {
      write: (chunk) => void rec.writes.push(Buffer.from(chunk).toString()),
      end: () => {
        rec.ended = true;
        finish();
      },
      stop: () => {
        rec.stopped = true;
        finish();
      },
      done,
    };
  }
}

class FakeSay implements Speaker {
  readonly maxChars = 160;
  said: string[] = [];
  stopped = 0;
  async speak(text: string) {
    this.said.push(text);
  }
  stop() {
    this.stopped++;
  }
}

/** Streams `text` back as its own audio in two parts; with `hold`, the second part waits until
 *  the test releases it (and an abort ends the stream, as a real fetch body would). */
function fakeFetch(opts: { status?: number; log: Array<{ text: string; signal: AbortSignal; at: number }>; hold?: Map<string, () => void> }) {
  let t = 0;
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { text: string; model_id: string; voice_settings: unknown };
    opts.log.push({ text: body.text, signal: init!.signal!, at: t++ });
    if (opts.status && opts.status !== 200) return new Response("nope", { status: opts.status });
    const enc = (s: string) => new TextEncoder().encode(s);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc(`[${body.text}:1]`));
        const finish = () => {
          try {
            controller.enqueue(enc(`[${body.text}:2]`));
            controller.close();
          } catch {
            /* already closed */
          }
        };
        if (!opts.hold) return finish();
        opts.hold.set(body.text, finish);
        init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "audio/mpeg" } });
  }) as unknown as typeof fetch;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("ElevenLabsSpeaker", () => {
  it("requests sentence chunks in a pipeline and feeds one playback in order", async () => {
    const log: Array<{ text: string; signal: AbortSignal; at: number }> = [];
    const hold = new Map<string, () => void>();
    const player = new FakePlayer();
    const s = new ElevenLabsSpeaker({ apiKey: "k", voiceId: "v", player, fetch: fakeFetch({ log, hold }), cacheDir: null });
    const long = `${"Alpha sentence about the first thing that happened today, in some detail. ".repeat(3)}${"Beta sentence about the second thing, also in detail for length. ".repeat(3)}`;
    const chunks = splitForSpeech(long);
    expect(chunks).toHaveLength(3);
    const p = s.speak(long);
    await new Promise((r) => setTimeout(r, 10));
    // the second chunk was requested while the first is still streaming; the third not yet
    expect(log.map((l) => l.text)).toEqual(chunks.slice(0, 2));
    expect(player.playbacks[0]!.writes).toEqual([`[${chunks[0]}:1]`]);
    hold.get(chunks[0]!)!();
    await new Promise((r) => setTimeout(r, 10));
    expect(log.map((l) => l.text)).toEqual(chunks);
    hold.get(chunks[1]!)!();
    await new Promise((r) => setTimeout(r, 10));
    hold.get(chunks[2]!)!();
    await p;
    const pb = player.playbacks[0]!;
    expect(pb.writes).toEqual(chunks.flatMap((c) => [`[${c}:1]`, `[${c}:2]`]));
    expect(pb.ended).toBe(true);
    expect(player.playbacks).toHaveLength(1);
  });

  it("sends the documented request shape", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;
    const player = new FakePlayer();
    await new ElevenLabsSpeaker({ apiKey: "secret", voiceId: "pNInz6obpgDQGcFmaJgB", modelId: "eleven_turbo_v2_5", player, fetch: f, cacheDir: null }).speak("Hi there.");
    expect(calls[0]!.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/pNInz6obpgDQGcFmaJgB/stream?output_format=mp3_44100_64");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["xi-api-key"]).toBe("secret");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: "Hi there.", model_id: "eleven_turbo_v2_5", voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true } });
    expect(player.playbacks[0]!.writes).toHaveLength(1);
  });

  it("stop() aborts the fetches, kills the playback and resolves speak()", async () => {
    const log: Array<{ text: string; signal: AbortSignal; at: number }> = [];
    const hold = new Map<string, () => void>();
    const player = new FakePlayer();
    const say = new FakeSay();
    const s = new ElevenLabsSpeaker({ apiKey: "k", voiceId: "v", player, fetch: fakeFetch({ log, hold }), cacheDir: null, fallback: say });
    const p = s.speak("First sentence here. Second sentence here.");
    await new Promise((r) => setTimeout(r, 10));
    s.stop();
    await p;
    expect(log[0]!.signal.aborted).toBe(true);
    expect(player.playbacks[0]!.stopped).toBe(true);
    expect(say.said).toEqual([]); // an interruption is not a failure
    expect(say.stopped).toBeGreaterThan(0);
  });

  it("a new utterance cuts off the previous one", async () => {
    const log: Array<{ text: string; signal: AbortSignal; at: number }> = [];
    const hold = new Map<string, () => void>();
    const player = new FakePlayer();
    const s = new ElevenLabsSpeaker({ apiKey: "k", voiceId: "v", player, fetch: fakeFetch({ log, hold }), cacheDir: null });
    const first = s.speak("One.");
    await new Promise((r) => setTimeout(r, 5));
    const second = s.speak("Two.");
    await new Promise((r) => setTimeout(r, 5));
    hold.get("Two.")!();
    await Promise.all([first, second]);
    expect(player.playbacks[0]!.stopped).toBe(true);
    expect(player.playbacks[1]!.ended).toBe(true);
  });

  it("falls back to say when the API fails before any audio played, and logs once", async () => {
    const log: Array<{ text: string; signal: AbortSignal; at: number }> = [];
    const player = new FakePlayer();
    const say = new FakeSay();
    const warnings: string[] = [];
    const s = new ElevenLabsSpeaker({ apiKey: "k", voiceId: "v", player, fetch: fakeFetch({ log, status: 401 }), cacheDir: null, fallback: say, log: (m) => warnings.push(m) });
    await s.speak("Opened wikipedia.");
    await s.speak("Scrolled down.");
    expect(say.said).toEqual(["Opened wikipedia.", "Scrolled down."]);
    expect(warnings).toEqual(["elevenlabs: HTTP 401 nope; falling back to say"]);
    expect(player.playbacks.every((p) => p.stopped)).toBe(true);
  });

  it("caches short phrases on disk so repeats need no request", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jev-tts-"));
    dirs.push(dir);
    const log: Array<{ text: string; signal: AbortSignal; at: number }> = [];
    const player = new FakePlayer();
    const s = new ElevenLabsSpeaker({ apiKey: "k", voiceId: "v", player, fetch: fakeFetch({ log }), cacheDir: dir });
    await s.speak("On it.");
    await new Promise((r) => setTimeout(r, 20));
    expect(readdirSync(dir)).toHaveLength(1);
    await s.speak("On it.");
    expect(log.map((l) => l.text)).toEqual(["On it."]);
    expect(player.playbacks[1]!.writes).toEqual(["[On it.:1][On it.:2]"]);
    // long text is not cached
    await s.speak("This answer is much longer than the cache limit allows, so it is streamed and forgotten.");
    await new Promise((r) => setTimeout(r, 20));
    expect(readdirSync(dir)).toHaveLength(1);
  });
});

describe("selectSpeaker", () => {
  const darwin = process.platform === "darwin";
  it("picks by JEV_TTS, defaulting to ElevenLabs when keyed", () => {
    expect(selectSpeaker({ JEV_TTS: "off", ELEVENLABS_API_KEY: "k" })).toBeNull();
    expect(selectSpeaker({ JEV_SPEAK: "off" })).toBeNull();
    expect(describeSpeaker(selectSpeaker({ ELEVENLABS_API_KEY: "k" }))).toBe("elevenlabs");
    expect(describeSpeaker(selectSpeaker({ ELEVENLABS_API_KEY: "k", JEV_TTS: "say" }))).toBe(darwin ? "say" : "off");
    expect(describeSpeaker(selectSpeaker({}))).toBe(darwin ? "say" : "off");
    const warnings: string[] = [];
    expect(describeSpeaker(selectSpeaker({ JEV_TTS: "elevenlabs" }, (m) => warnings.push(m)))).toBe(darwin ? "say" : "off");
    expect(warnings).toEqual(["JEV_TTS=elevenlabs but ELEVENLABS_API_KEY is not set; using say"]);
    expect(selectSpeaker({ ELEVENLABS_API_KEY: "k" })?.maxChars).toBe(600);
    expect(DEFAULT_VOICE_ID).toBe("pNInz6obpgDQGcFmaJgB");
  });
});
