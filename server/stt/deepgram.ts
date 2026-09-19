/** Deepgram streaming STT (wss://api.deepgram.com/v1/listen). Parameter names follow the
 *  streaming reference: encoding/sample_rate/channels, interim_results, endpointing,
 *  utterance_end_ms, vad_events, smart_format, language, and keyterm (nova-3+/flux; older
 *  models take `keywords`). Auth is the `Authorization: Token <key>` header. */
import { WebSocket } from "ws";
import type { SttEvent, SttProvider, SttStart, SttStream } from "./types.js";

/** The slice of the `ws` client API the provider uses; tests pass a fake. */
export interface SocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(): void;
  on(event: "open", cb: () => void): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: (code: number, reason: unknown) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}

export interface DeepgramOptions {
  apiKey: string;
  /** Default nova-3: the current general model and the one that supports keyterm boosting. */
  model?: string;
  /** Silence (ms) after which a final gets speech_final=true. */
  endpointingMs?: number;
  /** Silence (ms) without words after which an UtteranceEnd message arrives (min 1000). */
  utteranceEndMs?: number;
  /** Bytes queued to Deepgram above which incoming audio is dropped rather than buffered. */
  maxBufferedBytes?: number;
  keepAliveMs?: number;
  connect?: (url: string, headers: Record<string, string>) => SocketLike;
  baseUrl?: string;
}

const OPEN = 1;

export function deepgramUrl(start: SttStart, opts: DeepgramOptions): string {
  const model = opts.model ?? "nova-3";
  const url = new URL(opts.baseUrl ?? "wss://api.deepgram.com/v1/listen");
  const q = url.searchParams;
  q.set("model", model);
  q.set("encoding", "linear16");
  q.set("sample_rate", String(start.sampleRate));
  q.set("channels", String(start.channels));
  q.set("interim_results", "true");
  q.set("endpointing", String(opts.endpointingMs ?? 300));
  q.set("utterance_end_ms", String(Math.max(1000, opts.utteranceEndMs ?? 1000)));
  q.set("vad_events", "true");
  q.set("smart_format", "true");
  q.set("language", (start.lang ?? "en").split("-")[0] ?? "en");
  const boost = /^(nova-3|flux)/.test(model) ? "keyterm" : "keywords";
  for (const k of start.keywords ?? []) q.append(boost, k);
  return url.toString();
}

interface DeepgramMessage {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string }> };
}

export function parseDeepgramMessage(raw: string): SttEvent | null {
  let msg: DeepgramMessage;
  try {
    msg = JSON.parse(raw) as DeepgramMessage;
  } catch {
    return null;
  }
  switch (msg.type) {
    case "Results":
      return {
        type: "transcript",
        text: msg.channel?.alternatives?.[0]?.transcript ?? "",
        final: !!msg.is_final,
        speechFinal: !!msg.speech_final,
      };
    case "UtteranceEnd":
      return { type: "utterance_end" };
    case "Error":
      return { type: "error", message: JSON.stringify(msg) };
    default:
      return null; // Metadata, SpeechStarted
  }
}

export class DeepgramProvider implements SttProvider {
  readonly name = "deepgram";

  constructor(private readonly opts: DeepgramOptions) {}

  get model(): string {
    return this.opts.model ?? "nova-3";
  }

  open(start: SttStart, onEvent: (ev: SttEvent) => void): SttStream {
    const headers = { Authorization: `Token ${this.opts.apiKey}` };
    const url = deepgramUrl(start, this.opts);
    const ws: SocketLike = this.opts.connect ? this.opts.connect(url, headers) : new WebSocket(url, { headers });
    const maxBuffered = this.opts.maxBufferedBytes ?? 1_000_000;
    let closed = false;
    let lastAudioAt = Date.now();
    let closeAfterFlush = false;

    const keepAlive = setInterval(() => {
      // Deepgram drops the socket after ~10 s without audio, e.g. while the mic is muted.
      if (ws.readyState === OPEN && Date.now() - lastAudioAt >= (this.opts.keepAliveMs ?? 5000)) ws.send(JSON.stringify({ type: "KeepAlive" }));
    }, this.opts.keepAliveMs ?? 5000);

    let errored = false;
    const fail = (message: string) => {
      if (closed || errored) return;
      errored = true;
      onEvent({ type: "error", message });
    };
    const done = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      onEvent({ type: "closed" });
    };

    ws.on("open", () => onEvent({ type: "open" }));
    ws.on("message", (data) => {
      const ev = parseDeepgramMessage(String(data));
      if (!ev) return;
      onEvent(ev);
      if (closeAfterFlush && ev.type === "transcript" && ev.final) {
        // the flush produced its final; nothing more is coming
        ws.send(JSON.stringify({ type: "CloseStream" }));
      }
    });
    ws.on("error", (err) => fail(err.message));
    ws.on("close", (code, reason) => {
      if (code !== 1000) fail(`deepgram closed ${code}${reason ? ` ${String(reason)}` : ""}`);
      done();
    });

    return {
      send: (audio) => {
        if (ws.readyState !== OPEN || closeAfterFlush) return;
        if (ws.bufferedAmount > maxBuffered) return; // drop rather than fall behind
        lastAudioAt = Date.now();
        ws.send(audio);
      },
      finish: () => {
        if (ws.readyState !== OPEN) return ws.close();
        closeAfterFlush = true;
        ws.send(JSON.stringify({ type: "Finalize" }));
        setTimeout(() => ws.readyState === OPEN && ws.send(JSON.stringify({ type: "CloseStream" })), 1500);
      },
      close: () => {
        clearInterval(keepAlive);
        ws.close();
      },
    };
  }
}
