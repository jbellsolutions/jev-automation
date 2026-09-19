import type { LogEntry } from "../state.ts";

const resultColor: Record<string, string | undefined> = { error: "var(--danger)", warn: "var(--warn)", ok: "var(--accent-2)" };

function Entry({ entry }: { entry: LogEntry }) {
  const d = entry.decision;
  const outcome = d ? `→ ${d.actionLabel}` : entry.result ? `→ ${entry.result.text}` : "thinking…";
  return (
    <li className="entry">
      <div className="said">
        {entry.said}
        {entry.step && <span className="tag step" title={entry.step.original}>step {entry.step.index + 1}/{entry.step.total}</span>}
      </div>
      <div className={`did ${d || entry.result ? "" : "muted"}`}>{outcome}</div>
      {d && (
        <div className="meta">
          <span className={`tag ${d.source}`}>{d.source === "jev" ? d.model || "jev" : "heuristic"}</span>
          <span className="tag">intent: {d.intent} {Math.round(d.intentConfidence * 100)}%</span>
          {d.targetConfidence != null && <span className="tag">target {Math.round(d.targetConfidence * 100)}%</span>}
          {d.risky != null && d.risky >= 0.6 && <span className="tag risk">risky {Math.round(d.risky * 100)}%</span>}
          <span className="tag">{d.latencyMs} ms{d.inputTokens ? ` · ${d.inputTokens} tok` : ""}</span>
          <div className="bar"><span style={{ width: `${Math.round(d.intentConfidence * 100)}%` }} /></div>
        </div>
      )}
      {d && entry.result && (
        <div className="result muted" style={{ color: resultColor[entry.result.level] }}>
          {entry.result.text}
          {entry.verify && (
            <span className={`tag verify ${entry.verify.stuck ? "stuck" : entry.verify.done ? "done" : "undone"}`} title={`checked by ${entry.verify.source}${entry.verify.latencyMs ? ` in ${entry.verify.latencyMs} ms` : ""}`}>
              {entry.verify.stuck ? "⛔" : entry.verify.done ? "✓" : "?"} {entry.verify.text}
            </span>
          )}
        </div>
      )}
    </li>
  );
}

export function DecisionLog({ entries, onClear }: { entries: LogEntry[]; onClear: () => void }) {
  return (
    <>
      <div className="log-head">
        <span>Transcript &amp; decisions</span>
        <button type="button" className="link" onClick={onClear}>clear</button>
      </div>
      <ol id="log" className="log" aria-live="polite">
        {entries.map((e) => <Entry key={e.id} entry={e} />)}
      </ol>
    </>
  );
}
