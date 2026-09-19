/** Did the last action do what the step wanted? Code diffs the before/after snapshots into a
 *  small state; obvious cases are decided here, the rest go to Jev as three typed questions.
 *  Jev reads literally, so it only ever sees booleans, short strings and ≤8 descriptions. */
import { type Questions, type SystemOneResult, choice, noul } from "@typesafe-ai/sdk";
import { type Action, describeAction } from "./actions.js";
import { type PageElement, type PageSnapshot, describeElement } from "./elements.js";

export interface VerifyInput {
  command: string;
  /** What the planner (or defaultExpectation) said the page should show afterwards. */
  expectation: string | null;
  action: Action;
  before: PageSnapshot;
  after: PageSnapshot;
  /** The executor's error message when the action itself failed. */
  error: string | null;
}

/** Exactly what goes into the systemOne `state`. */
export type VerifyState = {
  command: string;
  expectation: string;
  action_taken: string;
  before: { url: string; title: string };
  after: { url: string; title: string };
  url_changed: boolean;
  title_changed: boolean;
  new_elements: string[];
  gone_elements: string[];
  error: string | null;
};

export type Blocker = "none" | "consent_dialog" | "login_wall" | "captcha" | "error_page" | "no_results" | "popup" | "permission_prompt" | "no_change";

export const BLOCKERS: Record<Blocker, string> = {
  none: "Nothing is in the way",
  consent_dialog: "A cookie or privacy consent dialog",
  login_wall: "A sign-in or account prompt",
  captcha: "A captcha or robot check",
  error_page: "An error, not found, or cannot-reach page",
  no_results: "A search or list that says it found nothing",
  popup: "A newsletter, app-install or other overlay",
  permission_prompt: "A request for a permission such as location, notifications or camera",
  no_change: "The page did not change at all",
};

export interface VerifyResult {
  done: boolean;
  stuck: boolean;
  doneProbability: number;
  stuckProbability: number;
  blocker: Blocker;
  source: "code" | "jev" | "heuristic";
  meta: { latencyMs: number; inputTokens?: number; fallbackReason?: string };
}

export const VERIFY_THRESHOLDS = {
  /** step_done probability at or above which the step counts as achieved. */
  done: 0.6,
  /** stuck probability at or above which the sequence stops. */
  stuck: 0.6,
};

const MAX_NEW = 8;
const MAX_GONE = 5;

/** Identity of an element across snapshots: everything but its id and position. */
export function elementKey(e: PageElement): string {
  return [e.tag, e.role, e.type, e.text, e.label, e.placeholder, e.hrefShort ?? ""].join("|");
}

function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** A one-line expectation for actions the planner didn't annotate. */
export function defaultExpectation(a: Action): string {
  switch (a.kind) {
    case "navigate":
      return `the page at ${host(a.url) || a.url} is open`;
    case "search":
      return `web results for "${a.query}" are shown`;
    case "click":
      return `${a.label} was activated: a new page, section, menu or dialog appeared`;
    case "click_at":
      return "whatever was under the pointer was activated";
    case "type":
      return a.submit ? `results or the next step for "${a.text}" appear` : `"${a.text}" is in ${a.label ?? "the field"}`;
    case "press":
      return a.key === "Enter" ? "the form was submitted or the search ran" : `the ${a.key} key had its effect`;
    case "scroll":
      return `the page moved ${a.direction}`;
    case "back":
      return "the previous page is shown";
    case "forward":
      return "the next page is shown";
    case "reload":
      return "the page reloaded";
    case "stop":
    case "none":
      return "nothing needed to happen";
  }
}

export function buildVerifyState(i: VerifyInput): VerifyState {
  const beforeKeys = new Set(i.before.elements.map(elementKey));
  const afterKeys = new Set(i.after.elements.map(elementKey));
  const fresh = i.after.elements.filter((e) => !beforeKeys.has(elementKey(e)));
  const gone = i.before.elements.filter((e) => !afterKeys.has(elementKey(e)));
  return {
    command: i.command,
    expectation: i.expectation ?? defaultExpectation(i.action),
    action_taken: describeAction(i.action),
    before: { url: i.before.url, title: i.before.title },
    after: { url: i.after.url, title: i.after.title },
    url_changed: i.before.url !== i.after.url,
    title_changed: i.before.title !== i.after.title,
    new_elements: fresh.slice(0, MAX_NEW).map(describeElement),
    gone_elements: gone.slice(0, MAX_GONE).map(describeElement),
    error: i.error,
  };
}

const verdict = (done: boolean, stuck: boolean, blocker: Blocker, source: VerifyResult["source"], latencyMs = 0): VerifyResult => ({
  done,
  stuck,
  doneProbability: done ? 1 : 0,
  stuckProbability: stuck ? 1 : 0,
  blocker,
  source,
  meta: { latencyMs },
});

/** Verdicts code can reach on its own; null means "ask Jev". */
export function quickVerdict(s: VerifyState, a: Action): VerifyResult | null {
  if (s.error !== null) return verdict(false, true, "none", "code");
  switch (a.kind) {
    case "navigate":
    case "search": {
      const wanted = host(a.url);
      if (wanted && host(s.after.url) === wanted) return verdict(true, false, "none", "code");
      return null; // landed elsewhere: a redirect, a login wall, an error page
    }
    case "back":
    case "forward":
      return verdict(s.url_changed, !s.url_changed, s.url_changed ? "none" : "no_change", "code");
    case "reload":
    case "scroll":
    case "stop":
    case "none":
      return verdict(true, false, "none", "code");
    case "type":
      return a.submit ? null : verdict(true, false, "none", "code"); // fill() throws when it can't
    case "click":
    case "click_at":
    case "press":
      return null; // blockers appear without URL changes; URL changes can land on walls
  }
}

/** Without Jev: any change counts as progress, no change as stuck. */
export function heuristicVerdict(s: VerifyState): VerifyResult {
  const changed = s.url_changed || s.title_changed || s.new_elements.length > 0;
  return verdict(changed, !changed, changed ? "none" : "no_change", "heuristic");
}

export function buildVerifyQuestions(s: VerifyState): Questions {
  return {
    step_done: noul(
      { question: "Did the browser action achieve what the command asked, judging only by the listed changes to the page?", command: s.command, expectation: s.expectation },
      {
        true: "The page changed the way the command wanted: the requested site or section is open, search results or the typed text are visible, the clicked item opened or expanded",
        false: "Nothing relevant changed, an error or blocked page appeared, or the page shows something other than what was asked",
      },
    ),
    stuck: noul(
      { question: "Is the page blocked so that repeating the same action would not help?" },
      {
        true: "A sign-in form, captcha, cookie or consent dialog, popup, error page, or 'no results' now stands in the way, or nothing changed at all",
        false: "The page is progressing normally and the next step can proceed",
      },
    ),
    blocker: choice({ question: "What, if anything, is now in the way?" }, BLOCKERS),
  };
}

type Answers = SystemOneResult<Questions>["answers"];

export function interpretVerifyAnswers(answers: Answers): VerifyResult {
  const doneAns = answers.step_done;
  const stuckAns = answers.stuck;
  const blockerAns = answers.blocker;
  const doneProbability = doneAns?.type === "noul" ? doneAns.noul : 0;
  const stuckProbability = stuckAns?.type === "noul" ? stuckAns.noul : 0;
  const picked = blockerAns?.type === "choice" ? blockerAns.choice : "none";
  const blocker: Blocker = picked in BLOCKERS ? (picked as Blocker) : "none";
  return {
    done: doneProbability >= VERIFY_THRESHOLDS.done,
    stuck: stuckProbability >= VERIFY_THRESHOLDS.stuck,
    doneProbability,
    stuckProbability,
    blocker: stuckProbability >= VERIFY_THRESHOLDS.stuck ? blocker : "none",
    source: "jev",
    meta: { latencyMs: 0 },
  };
}

/** Short status line for the UI / MCP text. */
export function describeVerify(v: VerifyResult): string {
  if (v.stuck) return `stuck${v.blocker !== "none" ? `: ${v.blocker.replace("_", " ")}` : ""}`;
  if (v.done) return v.source === "code" ? "done" : `done ${Math.round(v.doneProbability * 100)}%`;
  return `not done ${Math.round(v.doneProbability * 100)}%`;
}
