/** Spoken replies. The Speaker is a seam (macOS `say` now, a cloud voice later); what gets said
 *  is decided here from the CommandResult so every voice stays short and consistent. */
import type { CommandResult, StepResult } from "./results.js";

export interface Speaker {
  /** Say `text`, resolving when it has been spoken (or was interrupted). */
  speak(text: string, signal?: AbortSignal): Promise<void>;
  stop(): void;
}

const MAX_SPOKEN = 160;

/** URLs read aloud are noise: keep the host ("wikipedia.org"), drop scheme, path and query. */
export function speakableText(text: string): string {
  return text
    .replace(/https?:\/\/(?:www\.)?([^\s/?#]+)[^\s]*/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Shorten free text (a brain reply, an outcome) to something worth saying aloud. */
export function clipSpoken(text: string, max = MAX_SPOKEN): string {
  const t = speakableText(text.replace(/[*_`#>]+/g, ""));
  return t.length <= max ? t : `${t.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

const clip = clipSpoken;

function lastResult(steps: StepResult[]): StepResult | undefined {
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i]!.result) return steps[i];
  return undefined;
}

/** What the assistant says after a command: the question it is now waiting on, otherwise the
 *  outcome of the last step that ran (prefixed with "Done" for multi-step successes). */
export function spokenSummary(r: CommandResult): string {
  if (r.pending?.kind === "confirm") return clip(`${r.pending.actionLabel}? ${r.pending.reason}`);
  if (r.pending?.kind === "approval") return clip(r.pending.question);
  if (r.pending?.kind === "clarify") {
    const names = r.pending.options.slice(0, 4).map((o) => o.label);
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}` : (names[0] ?? "");
    return clip(`${r.pending.question} ${list}`);
  }
  const last = lastResult(r.steps);
  if (!last?.result) return "";
  // a step handed to the brain was acknowledged aloud when it left; its answer is spoken when it arrives
  if (last.decision?.route === "hermes" && last.result.level === "ok") return "";
  const outcome = last.result.text;
  if (last.result.level === "error" || last.result.level === "warn") return clip(outcome);
  if (last.verify?.stuck) return clip(`${outcome}, but it looks stuck: ${last.verify.text}`);
  const ran = r.steps.filter((s) => s.result).length;
  return clip(ran > 1 && r.ok ? `Done. ${outcome}` : outcome);
}
