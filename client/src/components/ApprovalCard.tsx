import type { ApprovalChoice } from "../../../core/brain.ts";
import type { Approval } from "../state.ts";

const LABELS: Record<ApprovalChoice, string> = { once: "Allow once", session: "Allow this session", always: "Always allow", deny: "Deny" };

/** The brain asked before doing something; a spoken "yes"/"no" answers it too. */
export function ApprovalCard({ pending, onChoose }: { pending: NonNullable<Approval>; onChoose: (choice: ApprovalChoice) => void }) {
  const allow = pending.choices.filter((c) => c !== "deny");
  return (
    <div id="approval" className="card approval">
      <div className="card-title">Hermes needs your OK</div>
      <div className="card-body">{pending.question}</div>
      <div className="muted">Say "yes" or "no", or pick below.</div>
      <div className="row">
        {allow.map((c, i) => (
          <button key={c} type="button" className={i === 0 ? "primary" : ""} onClick={() => onChoose(c)}>{LABELS[c]}</button>
        ))}
        <button type="button" onClick={() => onChoose("deny")}>{LABELS.deny}</button>
      </div>
    </div>
  );
}
