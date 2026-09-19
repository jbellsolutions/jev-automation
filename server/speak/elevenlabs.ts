/** ElevenLabs text-to-speech, streamed. Each reply is cut into sentence-sized chunks; chunk
 *  n+1 is requested while chunk n is still being played, so the first words come out within
 *  the API's time-to-first-byte and long answers never wait for full synthesis. Short phrases
 *  (the fixed acknowledgements above all) are cached on disk, so repeats are instant and free. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Speaker } from "../../core/speak.js";
import type { Playback, Player } from "./player.js";

export interface ElevenLabsOptions {
  apiKey: string;
  voiceId: string;
  /** eleven_turbo_v2_5 (default): near-real-time and natural; eleven_flash_v2_5 is faster and flatter. */
  modelId?: string;
  player: Player;
  /** Spoken instead when the API fails before any audio has played (macOS `say`). */
  fallback?: Speaker | null;
  /** Directory for cached phrases; null disables the cache. */
  cacheDir?: string | null;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

/** Longest chunk sent to the API in one request; a sentence longer than this is split at a
 *  clause boundary so the first audio still arrives quickly. */
export const CHUNK_CHARS = 220;
/** Phrases up to this length are cached: acknowledgements and short answers repeat, long ones do not. */
export const CACHE_MAX_CHARS = 60;
export const DEFAULT_MODEL = "eleven_turbo_v2_5";
export const OUTPUT_FORMAT = "mp3_44100_64";

/** Cut text into chunks that end at sentence boundaries (then clauses, then words), each at
 *  most `max` characters. Quotes and URLs are never split from the sentence they are in. */
export function splitForSpeech(text: string, max = CHUNK_CHARS): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  // a sentence ends at . ! ? (plus a closing quote or bracket) followed by a space: "wikipedia.org" stays whole
  const sentences = clean.split(/(?<=[.!?]["')\]]?)\s+/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  let current = "";
  const push = (piece: string) => {
    if (!piece) return;
    if (!current) current = piece;
    else if (current.length + 1 + piece.length <= max) current = `${current} ${piece}`;
    else {
      out.push(current);
      current = piece;
    }
  };
  for (const sentence of sentences) {
    if (sentence.length <= max) {
      push(sentence);
      continue;
    }
    // too long for one request: break at clause boundaries, then at words
    for (const clause of sentence.split(/(?<=[,;:—–-])\s+/)) {
      if (clause.length <= max) push(clause);
      else {
        let rest = clause;
        while (rest.length > max) {
          const cut = rest.lastIndexOf(" ", max);
          const at = cut > max / 2 ? cut : max;
          push(rest.slice(0, at).trim());
          rest = rest.slice(at).trim();
        }
        push(rest);
      }
    }
  }
  if (current) out.push(current);
  return out;
}

export const defaultCacheDir = () => path.join(process.env.JEV_HOME ?? path.join(homedir(), ".jev"), "tts-cache");

type Audio = AsyncIterable<Uint8Array> | Uint8Array;

export class ElevenLabsSpeaker implements Speaker {
  /** A real voice can carry a longer reply than `say`. */
  readonly maxChars = 600;
  private readonly fetchImpl: typeof fetch;
  private readonly modelId: string;
  private readonly cacheDir: string | null;
  private current: { abort: AbortController; playback: Playback } | null = null;
  private warned = false;

  constructor(private readonly opts: ElevenLabsOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.modelId = opts.modelId || DEFAULT_MODEL;
    this.cacheDir = opts.cacheDir === undefined ? defaultCacheDir() : opts.cacheDir;
  }

  async speak(text: string, signal?: AbortSignal): Promise<void> {
    this.stop();
    const chunks = splitForSpeech(text);
    if (!chunks.length) return;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const playback = this.opts.player.open();
    const state = { abort, playback };
    this.current = state;
    let played = 0;
    try {
      let next = this.synth(chunks[0]!, abort.signal);
      for (let i = 0; i < chunks.length; i++) {
        const audio = next;
        if (i + 1 < chunks.length) next = this.synth(chunks[i + 1]!, abort.signal);
        else next = Promise.resolve(new Uint8Array());
        played += await pump(await audio, playback, abort.signal);
      }
      playback.end();
      await playback.done;
    } catch (err) {
      if (abort.signal.aborted) return;
      playback.stop();
      this.warn(err);
      if (played === 0 && this.opts.fallback) await this.opts.fallback.speak(text, abort.signal);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (this.current === state) this.current = null;
    }
  }

  stop(): void {
    const c = this.current;
    this.current = null;
    if (c) {
      c.abort.abort();
      c.playback.stop();
    }
    this.opts.fallback?.stop();
  }

  private warn(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (!this.warned) this.opts.log?.(`elevenlabs: ${message}; falling back to say`);
    this.warned = true;
  }

  private cacheFile(text: string): string | null {
    if (!this.cacheDir || text.length > CACHE_MAX_CHARS) return null;
    const key = createHash("sha1").update(`${this.opts.voiceId}|${this.modelId}|${OUTPUT_FORMAT}|${text}`).digest("hex");
    return path.join(this.cacheDir, `${key}.mp3`);
  }

  /** Audio for one chunk: cached bytes, or the API's stream (cached on the way when short). */
  private async synth(text: string, signal: AbortSignal): Promise<Audio> {
    const file = this.cacheFile(text);
    if (file) {
      try {
        return new Uint8Array(await readFile(file));
      } catch {
        /* not cached yet */
      }
    }
    const res = await this.fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.opts.voiceId)}/stream?output_format=${OUTPUT_FORMAT}`, {
      method: "POST",
      headers: { "xi-api-key": this.opts.apiKey, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: this.modelId, voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true } }),
      signal,
    });
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`HTTP ${res.status}${detail ? ` ${detail}` : ""}`);
    }
    if (!file) return res.body as unknown as AsyncIterable<Uint8Array>;
    const parts: Uint8Array[] = [];
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) parts.push(part);
    const bytes = Buffer.concat(parts);
    void mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      .then(() => writeFile(file, bytes, { mode: 0o600 }))
      .catch(() => {});
    return new Uint8Array(bytes);
  }
}

/** Feed audio into the playback as it arrives; returns the bytes written. Stops the moment
 *  the signal aborts, without waiting for the stream to notice. */
async function pump(audio: Audio, playback: Playback, signal: AbortSignal): Promise<number> {
  if (audio instanceof Uint8Array) {
    if (!signal.aborted) playback.write(audio);
    return audio.byteLength;
  }
  let n = 0;
  const iterator = audio[Symbol.asyncIterator]();
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error("aborted"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  try {
    for (;;) {
      const { value, done } = await Promise.race([iterator.next(), aborted]);
      if (done) break;
      playback.write(value);
      n += value.byteLength;
    }
  } finally {
    if (signal.aborted) void iterator.return?.().catch(() => {});
  }
  return n;
}
