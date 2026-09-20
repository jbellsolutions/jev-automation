import type { BrainProgress } from "../state.ts";

const STATE_LABEL: Record<BrainProgress["state"], string> = { running: "working…", waiting: "waiting for you", completed: "done", failed: "failed", cancelled: "stopped" };

/** What the brain has said and done for one step: streamed reply text plus a tool timeline. */
export function BrainCard({ brain }: { brain: BrainProgress }) {
  return (
    <div className={`brain ${brain.state}`}>
      <div className="brain-head">
        <span className="tag brain">Brain</span>
        <span className="muted">{STATE_LABEL[brain.state]}</span>
        {brain.retries ? <span className="muted">· retry {brain.retries}{brain.fresh ? ", fresh conversation" : ""}</span> : null}
      </div>
      {brain.tools.length > 0 && (
        <ul className="tools">
          {brain.tools.map((t, i) => (
            <li key={`${t.tool}-${i}`} className={t.error ? "error" : t.durationMs === undefined ? "running" : ""} title={t.preview}>
              <span className="tool-name">{t.tool}</span>
              {t.preview && <span className="muted preview">{t.preview}</span>}
              {t.durationMs !== undefined && <span className="muted">{t.error ? "✗" : "✓"} {(t.durationMs / 1000).toFixed(1)}s</span>}
            </li>
          ))}
        </ul>
      )}
      {brain.text && <pre className="reply">{brain.text}</pre>}
    </div>
  );
}
