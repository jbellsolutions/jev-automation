import type { Pending } from "../state.ts";

export function ClarifyCard({ pending, onPick }: { pending: Extract<Pending, { kind: "clarify" }>; onPick: (elementId: string) => void }) {
  return (
    <div id="clarify" className="card clarify">
      <div className="card-title">{pending.question}</div>
      <div id="clarify-options" className="chips">
        {pending.options.map((o, i) => (
          <button key={o.elementId} type="button" className="chip" onClick={() => onPick(o.elementId)}>
            {i + 1}. {o.label}
            <small>{Math.round(o.probability * 100)}%</small>
          </button>
        ))}
      </div>
    </div>
  );
}
