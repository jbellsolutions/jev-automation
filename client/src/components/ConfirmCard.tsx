import type { Pending } from "../state.ts";

export function ConfirmCard({ pending, onReply }: { pending: Extract<Pending, { kind: "confirm" }>; onReply: (ok: boolean) => void }) {
  return (
    <div id="confirm" className="card confirm">
      <div className="card-title">Confirm?</div>
      <div id="confirm-action" className="card-body">{pending.actionLabel}</div>
      <div className="muted">{pending.reason}</div>
      <div className="row">
        <button type="button" className="primary" onClick={() => onReply(true)}>Yes, do it</button>
        <button type="button" onClick={() => onReply(false)}>No</button>
      </div>
    </div>
  );
}
