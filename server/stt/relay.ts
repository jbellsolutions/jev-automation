/** Bridges one UI microphone socket (/ws/stt) to the STT provider and segments the result
 *  into utterances. One relay per socket; the provider stream lives from `start` to `stop`. */
import type { SttClientMessage, SttServerMessage } from "../../core/protocol.js";
import { Segmenter } from "./segment.js";
import type { SttProvider, SttStream } from "./types.js";

/** What the relay needs from a socket: the `ws` API subset, so tests can use real pairs. */
export interface RelaySocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", cb: (data: unknown, isBinary: boolean) => void): void;
  on(event: "close", cb: () => void): void;
}

export interface RelayOptions {
  provider: SttProvider;
  /** Silence after the last final before the buffered finals become an utterance. */
  gapMs?: number;
  tickMs?: number;
  /** After `stop`, how long to wait for the provider's last finals before flushing anyway. */
  finishTimeoutMs?: number;
  now?: () => number;
  /** Called for every complete utterance, after it was sent to the UI. */
  onUtterance?: (text: string) => void;
}

const OPEN = 1;
const MAX_SAMPLE_RATE = 48_000;

export function attachSttRelay(ws: RelaySocket, opts: RelayOptions): void {
  const now = opts.now ?? Date.now;
  let stream: SttStream | null = null;
  let segmenter: Segmenter | null = null;
  let ticker: ReturnType<typeof setInterval> | undefined;

  const send = (msg: SttServerMessage) => {
    if (ws.readyState === OPEN) ws.send(JSON.stringify(msg));
  };
  const emit = (events: ReturnType<Segmenter["push"]>) => {
    for (const ev of events) {
      if (ev.type === "interim") send({ type: "transcript", text: ev.text, final: false });
      else {
        send({ type: "utterance", text: ev.text });
        send({ type: "transcript", text: "", final: false });
        opts.onUtterance?.(ev.text);
      }
    }
  };
  const teardown = () => {
    clearInterval(ticker);
    ticker = undefined;
    clearTimeout(finishGuard);
    finishGuard = undefined;
    stream = null;
    segmenter = null;
  };
  /** Immediate: the UI went away or restarted the stream. */
  const abort = () => {
    stream?.close();
    teardown();
  };
  /** Graceful: ask the provider to flush, keep segmenting until it closes (or a guard fires). */
  const finish = () => {
    const s = stream;
    const seg = segmenter;
    if (!s || !seg) return;
    s.finish();
    finishGuard = setTimeout(() => {
      if (segmenter !== seg) return;
      emit(seg.flush());
      send({ type: "closed" });
      abort();
    }, opts.finishTimeoutMs ?? 3000);
  };
  let finishGuard: ReturnType<typeof setTimeout> | undefined;

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (stream) stream.send(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer));
      return;
    }
    let msg: SttClientMessage;
    try {
      msg = JSON.parse(String(data)) as SttClientMessage;
    } catch {
      return send({ type: "error", message: "bad message" });
    }
    if (msg.type === "start") {
      if (stream) abort();
      const sampleRate = Number(msg.sampleRate);
      if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > MAX_SAMPLE_RATE || msg.encoding !== "pcm_s16le" || msg.channels !== 1) {
        return send({ type: "error", message: "unsupported audio format: send mono pcm_s16le at 8–48 kHz" });
      }
      const seg = new Segmenter(opts.gapMs ?? 800);
      segmenter = seg;
      const s = opts.provider.open({ sampleRate, encoding: "pcm_s16le", channels: 1, lang: msg.lang, keywords: msg.keywords }, (ev) => {
        if (segmenter !== seg) return; // a later start replaced this stream
        switch (ev.type) {
          case "open":
            send({ type: "ready", provider: opts.provider.name });
            break;
          case "error":
            send({ type: "error", message: ev.message });
            break;
          case "closed":
            emit(seg.push(ev, now()));
            send({ type: "closed" });
            teardown();
            break;
          default:
            emit(seg.push(ev, now()));
        }
      });
      stream = s;
      ticker = setInterval(() => segmenter && emit(segmenter.tick(now())), opts.tickMs ?? 250);
    } else if (msg.type === "stop") {
      finish();
    }
  });
  ws.on("close", abort);
}
