import type { useSpeechRecognition } from "../hooks/useSpeechRecognition.ts";

type Speech = ReturnType<typeof useSpeechRecognition>;

const NOTES: Record<string, string> = {
  unsupported: "This browser has no Web Speech API. Use Chrome or Edge for voice; the text box below still works.",
  insecure: "Microphone access requires a secure context. Open this page via http://localhost or https.",
};

export function MicButton({ speech }: { speech: Speech }) {
  const disabled = speech.availability !== "ok";
  const label = speech.availability === "unsupported" ? "Voice not supported here" : speech.availability === "insecure" ? "Voice needs HTTPS or localhost" : speech.listening ? "Listening… speak a command" : "Tap to start listening";
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
