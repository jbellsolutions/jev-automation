/** The shape every voice-input hook returns, so the UI does not care which engine is behind it. */
export type VoiceAvailability = "ok" | "unsupported" | "insecure" | "no-mic";

export interface Voice {
  availability: VoiceAvailability;
  listening: boolean;
  /** Live text for display; never acted on. */
  interim: string;
  error: string | null;
  engine: "streaming" | "web-speech";
  /** The server-side STT provider when streaming (e.g. "deepgram", "apple"). */
  provider: string | null;
  start(): void;
  stop(): void;
  toggle(): void;
}
