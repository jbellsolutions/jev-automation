import { useCallback, useEffect, useRef, useState } from "react";
import type { SttClientMessage, SttServerMessage } from "../../../core/protocol.ts";
import { Framer, PCM_WORKLET_SOURCE, floatTo16BitPCM, resample } from "../audio/pcm16.ts";
import type { Transport } from "../transport.ts";
import type { VoiceAvailability } from "./voice.ts";

const TARGET_RATE = 16000;
const FRAME_MS = 100;

export interface StreamingOptions {
  transport: Transport;
  onUtterance: (text: string) => void;
  /** While true, captured audio is dropped (the assistant is talking). */
  muted: boolean;
  lang?: string;
  keywords?: string[];
}

interface Capture {
  stream: MediaStream;
  ctx: AudioContext;
  node: AudioWorkletNode;
  source: MediaStreamAudioSourceNode;
}

/** Microphone → 16 kHz PCM frames → /ws/stt → transcripts. Only complete utterances reach
 *  `onUtterance`; interim text is for display. */
export function useStreamingTranscription(opts: StreamingOptions) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const captureRef = useRef<Capture | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const availability: VoiceAvailability =
    typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined"
      ? "unsupported"
      : !window.isSecureContext
        ? "insecure"
        : "ok";

  const teardown = useCallback(() => {
    const c = captureRef.current;
    captureRef.current = null;
    if (c) {
      c.node.port.onmessage = null;
      c.node.disconnect();
      c.source.disconnect();
      for (const t of c.stream.getTracks()) t.stop();
      void c.ctx.close().catch(() => {});
    }
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
    setListening(false);
    setInterim("");
  }, []);

  const stop = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const stopMsg: SttClientMessage = { type: "stop" };
      ws.send(JSON.stringify(stopMsg));
    }
    // give the server a moment to flush the last utterance before the socket goes
    const c = captureRef.current;
    if (c) {
      c.node.port.onmessage = null;
      for (const t of c.stream.getTracks()) t.stop();
    }
    setTimeout(teardown, 1200);
    setListening(false);
  }, [teardown]);

  const start = useCallback(async () => {
    if (availability !== "ok" || captureRef.current) return;
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      setError(name === "NotAllowedError" ? "Microphone permission was denied. Allow it and try again." : name === "NotFoundError" ? "No microphone found." : `Microphone error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: TARGET_RATE });
    } catch {
      ctx = new AudioContext();
    }
    const blob = new Blob([PCM_WORKLET_SOURCE], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "jev-capture", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
    source.connect(node);
    const framer = new Framer((TARGET_RATE * FRAME_MS) / 1000);
    const ws = new WebSocket(optsRef.current.transport.wsUrl("/ws/stt"));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    captureRef.current = { stream, ctx, node, source };
    setListening(true);

    node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      if (ws.readyState !== WebSocket.OPEN || optsRef.current.muted) return;
      const pcm = floatTo16BitPCM(resample(ev.data, ctx.sampleRate, TARGET_RATE));
      for (const frame of framer.push(pcm)) ws.send(frame.buffer);
    };
    ws.onopen = () => {
      const startMsg: SttClientMessage = {
        type: "start",
        sampleRate: TARGET_RATE,
        encoding: "pcm_s16le",
        channels: 1,
        lang: optsRef.current.lang ?? navigator.language ?? "en-US",
        keywords: optsRef.current.keywords ?? ["Jev", "Hermes"],
      };
      ws.send(JSON.stringify(startMsg));
    };
    ws.onmessage = (ev) => {
      let msg: SttServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as SttServerMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case "ready":
          setProvider(msg.provider);
          break;
        case "transcript":
          setInterim(msg.text);
          break;
        case "utterance":
          setInterim("");
          if (!optsRef.current.muted) optsRef.current.onUtterance(msg.text);
          break;
        case "error":
          setError(msg.message);
          break;
        case "closed":
          if (wsRef.current === ws) teardown();
          break;
      }
    };
    ws.onclose = (ev) => {
      if (wsRef.current !== ws) return;
      if (ev.code === 1013) setError("The server has no speech-to-text provider configured.");
      else if (captureRef.current) setError("Transcription connection closed.");
      teardown();
    };
    ws.onerror = () => {
      if (wsRef.current === ws) setError("Could not reach the transcription relay.");
    };
  }, [availability, teardown]);

  const toggle = useCallback(() => (captureRef.current ? stop() : void start()), [start, stop]);

  useEffect(() => teardown, [teardown]);

  return { availability, listening, interim, error, provider, start: () => void start(), stop, toggle };
}
