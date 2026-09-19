/** Streaming speech-to-text seam. The relay (relay.ts) speaks this to whichever provider is
 *  configured; the UI never talks to a vendor directly. */

export interface SttStart {
  /** Samples per second of the PCM the client sends (the client resamples to this). */
  sampleRate: number;
  encoding: "pcm_s16le";
  channels: number;
  /** BCP-47 / ISO code, e.g. "en" or "en-US". */
  lang?: string;
  /** Words to boost, e.g. the assistant's name. */
  keywords?: string[];
}

export type SttEvent =
  | { type: "open" }
  /** `final` transcripts are stable; `speechFinal` marks the provider's end-of-speech detection. */
  | { type: "transcript"; text: string; final: boolean; speechFinal: boolean }
  /** Provider-side silence detection: whatever is buffered is a complete utterance. */
  | { type: "utterance_end" }
  | { type: "error"; message: string }
  | { type: "closed" };

export interface SttStream {
  send(audio: Uint8Array): void;
  /** No more audio: flush what the provider has buffered, then close. */
  finish(): void;
  close(): void;
}

export interface SttProvider {
  readonly name: string;
  open(start: SttStart, onEvent: (ev: SttEvent) => void): SttStream;
}
