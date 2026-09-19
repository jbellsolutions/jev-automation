import { useCallback, useEffect, useRef, useState } from "react";

/* Minimal typings for the Web Speech API (not in lib.dom for all targets). */
interface SpeechResultAlternative { transcript: string }
interface SpeechResult { isFinal: boolean; 0: SpeechResultAlternative }
interface SpeechResultEvent { resultIndex: number; results: ArrayLike<SpeechResult> }
interface SpeechErrorEvent { error: string }
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: SpeechResultEvent) => void) | null;
  onerror: ((ev: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => Recognition;

function getCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

import type { VoiceAvailability } from "./voice.ts";

export type SpeechAvailability = VoiceAvailability;

/** Continuous speech recognition in the browser. Only FINAL results reach `onFinal`;
 *  interim text is exposed for display and never acted on. */
export function useSpeechRecognition(onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<Recognition | null>(null);
  const listeningRef = useRef(false);
  const restartRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const availability: SpeechAvailability = !getCtor() ? "unsupported" : !window.isSecureContext ? "insecure" : "ok";

  const stop = useCallback(() => {
    listeningRef.current = false;
    clearTimeout(restartRef.current);
    try {
      recRef.current?.stop();
    } catch {
      /* already stopped */
    }
    setListening(false);
    setInterim("");
  }, []);

  const startSession = useCallback(() => {
    const Ctor = getCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    recRef.current = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    rec.onresult = (ev) => {
      let partial = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i]!;
        if (res.isFinal) onFinalRef.current(res[0].transcript);
        else partial += res[0].transcript;
      }
      setInterim(partial);
    };
    rec.onerror = (ev) => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        setError("Microphone permission was denied. Allow it in the address bar and try again.");
        stop();
      } else if (ev.error !== "no-speech" && ev.error !== "aborted") {
        setError(`Speech error: ${ev.error}`);
      }
    };
    // Chrome ends sessions after silence; keep going until the user stops.
    rec.onend = () => {
      if (listeningRef.current) restartRef.current = setTimeout(startSession, 200);
    };
    rec.start();
  }, [stop]);

  const start = useCallback(() => {
    if (availability !== "ok") return;
    listeningRef.current = true;
    setListening(true);
    setError(null);
    startSession();
  }, [availability, startSession]);

  const toggle = useCallback(() => (listeningRef.current ? stop() : start()), [start, stop]);

  useEffect(() => stop, [stop]);

  return { availability, listening, interim, error, start, stop, toggle };
}
