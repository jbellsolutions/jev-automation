import type { State } from "../state.ts";

export function TopBar({ jev, desktop = false, onHide }: { jev: State["jev"]; desktop?: boolean; onHide?: () => void }) {
  const label = !jev ? "connecting…" : jev.enabled ? `Jev · ${jev.model}` : "heuristic mode · no TYPESAFE_API_KEY";
  const tone = !jev ? "" : jev.enabled ? "jev" : "heuristic";
  return (
    <header className="topbar">
      <div className="brand">
        <span className="dot" />
        <strong>{desktop ? "Jev" : "Jev Voice Browser"}</strong>
        <span className="sub">{desktop ? "⌥Space to talk · Esc to hide" : "speak · Jev decides · Chromium acts"}</span>
      </div>
      <div id="jev-pill" className={`pill ${tone}`}>{label}</div>
      {onHide && (
        <button type="button" className="hide-btn" title="Hide (Esc)" onClick={onHide} aria-label="Hide panel">
          ×
        </button>
      )}
    </header>
  );
}
