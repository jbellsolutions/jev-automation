/** Spoken replies. The Speaker is a seam (macOS `say` now, a cloud voice later); what gets said
 *  is decided here from the CommandResult so every voice stays short and consistent. */
import type { CommandResult, StepResult } from "./results.js";

export interface Speaker {
  /** Say `text`, resolving when it has been spoken (or was interrupted). */
  speak(text: string, signal?: AbortSignal): Promise<void>;
  stop(): void;
  /** How much of an answer is worth reading aloud with this voice (a robotic voice earns less). */
  readonly maxChars?: number;
}

export const MAX_SPOKEN = 160;

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

/** The part of an answer to read aloud: the assistant is asked to lead with a short spoken
 *  reply and put detail after a blank line, so the first paragraph is it when it fits; long
 *  single paragraphs are cut at a sentence boundary instead of mid-word. */
export function spokenPart(text: string, max = MAX_SPOKEN): string {
  const plain = speakableText(text.replace(/[*_`#>]+/g, "").replace(/^\s*[-•]\s+/gm, ""));
  const first = text.trim().split(/\r?\n\s*\r?\n/)[0] ?? "";
  const lead = speakableText(first.replace(/[*_`#>]+/g, "").replace(/^\s*[-•]\s+/gm, ""));
  const candidate = lead && lead.length <= max && lead.length >= Math.min(plain.length, 20) ? lead : plain;
  if (candidate.length <= max) return candidate;
  const cut = candidate.slice(0, max);
  const boundary = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return boundary >= max / 3 ? cut.slice(0, boundary + 1) : clipSpoken(candidate, max);
}

const clip = clipSpoken;

function lastResult(steps: StepResult[]): StepResult | undefined {
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i]!.result) return steps[i];
  return undefined;
}

/** What the assistant says after a command: the question it is now waiting on, otherwise the
 *  outcome of the last step that ran (prefixed with "Done" for multi-step successes). */
export function spokenSummary(r: CommandResult, max = MAX_SPOKEN): string {
  const clip = (t: string) => clipSpoken(t, max);
  if (r.pending?.kind === "confirm") return clip(`${r.pending.actionLabel}? ${r.pending.reason}`);
  if (r.pending?.kind === "clarify") {
    const names = r.pending.options.slice(0, 4).map((o) => o.label);
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}` : (names[0] ?? "");
    return clip(`${r.pending.question} ${list}`);
  }
  const last = lastResult(r.steps);
  // a parked brain approval is read out after this command's outcome, so the user knows what is waiting
  const tail = r.pending?.kind === "approval" ? r.pending.question : "";
  const withTail = (text: string) => clip(tail ? `${text} ${tail}`.trim() : text);
  if (!last?.result) return withTail("");
  // a step handed to the brain was acknowledged aloud when it left; its answer is spoken when it arrives
  if (last.lane === "brain" && last.result.level === "ok") return withTail("");
  const outcome = last.result.text;
  if (last.result.level === "error" || last.result.level === "warn") return withTail(outcome);
  if (last.verify?.stuck) return withTail(`${outcome}, but it looks stuck: ${last.verify.text}`);
  const ran = r.steps.filter((s) => s.result).length;
  return withTail(ran > 1 && r.ok ? `Done. ${outcome}` : outcome);
}
