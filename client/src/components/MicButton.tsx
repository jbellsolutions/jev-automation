import type { Voice } from "../hooks/voice.ts";

const NOTES: Record<string, string> = {
  unsupported: "This browser cannot capture voice here. Use Chrome or Edge (or the desktop app); the text box below still works.",
  insecure: "Microphone access requires a secure context. Open this page via http://localhost or https.",
  "no-mic": "No microphone found.",
};

const PROVIDER_NAMES: Record<string, string> = { deepgram: "Deepgram", apple: "on-device" };

export function MicButton({ speech }: { speech: Voice }) {
  const disabled = speech.availability !== "ok";
  const engine = speech.engine === "streaming" ? (speech.provider ? (PROVIDER_NAMES[speech.provider] ?? speech.provider) : "streaming") : "browser speech";
  const label = speech.availability === "unsupported" ? "Voice not supported here" : speech.availability === "insecure" ? "Voice needs HTTPS or localhost" : speech.listening ? `Listening (${engine})… speak a command` : `Tap to start listening · ${engine}`;
  const note = NOTES[speech.availability] ?? speech.error;
  return (
    <>
      <div className="mic-block">
        <button
          id="mic"
          type="button"
          className="mic"
          aria-pressed={speech.listening}
          title={speech.listening ? "Stop listening" : "Start listening"}
          disabled={disabled}
          onClick={speech.toggle}
        >
          <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
            <path fill="currentColor" d="M12 15a4 4 0 0 0 4-4V6a4 4 0 1 0-8 0v5a4 4 0 0 0 4 4Zm6-4a1 1 0 1 1 2 0 8 8 0 0 1-7 7.94V21h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2.06A8 8 0 0 1 4 11a1 1 0 1 1 2 0 6 6 0 0 0 12 0Z" />
          </svg>
        </button>
        <div className="mic-text">
          <div className="mic-label">{label}</div>
          <div className="interim">{speech.interim || " "}</div>
        </div>
      </div>
      {note && <p className="note">{note}</p>}
    </>
  );
}
