/** A short, one-line description of a command's outcome — for callers that want a single
 *  sentence rather than the full decision log (Session.ask(), /api/ask). */
import type { CommandResult, StepResult } from "./results.js";

export const MAX_SUMMARY = 160;

/** Strip markdown and URLs down to plain text and cap the length. */
function clip(text: string, max: number): string {
  const t = text
    .replace(/https?:\/\/(?:www\.)?([^\s/?#]+)[^\s]*/gi, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

function lastResult(steps: StepResult[]): StepResult | undefined {
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i]!.result) return steps[i];
  return undefined;
}

/** One line: the question a command is now waiting on, otherwise the outcome of the last step
 *  that ran (prefixed with "Done" for multi-step successes). */
export function resultSummary(r: CommandResult, max = MAX_SUMMARY): string {
  const c = (t: string) => clip(t, max);
  if (r.pending?.kind === "confirm") return c(`${r.pending.actionLabel}? ${r.pending.reason}`);
  if (r.pending?.kind === "clarify") {
    const names = r.pending.options.slice(0, 4).map((o) => o.label);
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}` : (names[0] ?? "");
    return c(`${r.pending.question} ${list}`);
  }
  const last = lastResult(r.steps);
  // a parked brain approval is reported after this command's outcome, so the caller knows what is waiting
  const tail = r.pending?.kind === "approval" ? r.pending.question : "";
  const withTail = (text: string) => c(tail ? `${text} ${tail}`.trim() : text);
  if (!last?.result) return withTail("");
  // a step handed to the brain is acknowledged when it leaves; its answer arrives later
  if (last.lane === "brain" && last.result.level === "ok") return withTail("");
  const outcome = last.result.text;
  if (last.result.level === "error" || last.result.level === "warn") return withTail(outcome);
  if (last.verify?.stuck) return withTail(`${outcome}, but it looks stuck: ${last.verify.text}`);
  const ran = r.steps.filter((s) => s.result).length;
  return withTail(ran > 1 && r.ok ? `Done. ${outcome}` : outcome);
}
