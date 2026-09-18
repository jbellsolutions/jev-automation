import type { State } from "../state.ts";

export function TopBar({ jev }: { jev: State["jev"] }) {
  const label = !jev ? "connecting…" : jev.enabled ? `Jev · ${jev.model}` : "heuristic mode · no TYPESAFE_API_KEY";
  const tone = !jev ? "" : jev.enabled ? "jev" : "heuristic";
  return (
    <header className="topbar">
      <div className="brand">
        <span className="dot" />
        <strong>Jev Voice Browser</strong>
        <span className="sub">speak · Jev decides · Chromium acts</span>
      </div>
      <div id="jev-pill" className={`pill ${tone}`}>{label}</div>
    </header>
  );
}
