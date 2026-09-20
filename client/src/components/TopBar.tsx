import type { State } from "../state.ts";

export function TopBar({
  jev,
  desktop = false,
  paused = false,
  busy = false,
  onStop,
  onPause,
  onHide,
}: {
  jev: State["jev"];
  desktop?: boolean;
  paused?: boolean;
  /** Something is running or being said: show the stop button. */
  busy?: boolean;
  onStop?: () => void;
  onPause?: (paused: boolean) => void;
  onHide?: () => void;
}) {
  const label = !jev ? "connecting…" : jev.enabled ? `Jev · ${jev.model}` : "heuristic mode · no TYPESAFE_API_KEY";
  const tone = !jev ? "" : jev.enabled ? "jev" : "heuristic";
  return (
    <header className={`topbar${paused ? " paused" : ""}`}>
      <div className="brand">
        <span className="dot" />
        <strong>{desktop ? "Jev" : "Jev Voice Browser"}</strong>
        <span className="sub">{paused ? "paused — nothing is heard, said or done" : desktop ? "⌥Space to talk · Esc to hide" : "speak · Jev decides · Chromium acts"}</span>
      </div>
      {onStop && busy && !paused && (
        <button type="button" className="stop-btn" title="Stop everything: the voice, the browser and Hermes" onClick={onStop}>
          ■ Stop
        </button>
      )}
      {onPause && (
        <button type="button" className={`pause-btn${paused ? " on" : ""}`} title={paused ? "Switch Jev back on" : "Switch Jev off: it stops listening, talking and acting until resumed"} onClick={() => onPause(!paused)}>
          {paused ? "⏻ Resume" : "⏻ Pause"}
        </button>
      )}
      <div id="jev-pill" className={`pill ${tone}`}>{label}</div>
      {onHide && (
        <button type="button" className="hide-btn" title="Hide (Esc)" onClick={onHide} aria-label="Hide panel">
          ×
        </button>
      )}
    </header>
  );
}
