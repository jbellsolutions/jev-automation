/** Turns a spoken command + page snapshot into an Action.
 *
 *  Division of labour (see docs.typesafe.ai/concepts/how-to-build-with-system-one):
 *   - code pre-parses anything that must be copied verbatim (URLs, text to type);
 *   - Jev answers the judgment calls in ONE request (speculative fan-out): what the user
 *     intends, which element they mean, whether to submit, whether it's risky;
 *   - code applies confidence gates and assembles the Action.
 *  With no API key the same pipeline runs on keyword heuristics so the app still works. */
import { type ChoiceCriteria, type Questions, type SystemOneResult, TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";
import type { Action, ScrollDirection } from "./actions.js";
import { describeAction } from "./actions.js";
import { type ParsedCommand, knownSiteUrl, parseCommand, parseYesNo, toUrl } from "./commands.js";
import { NONE_OPTION, type PageElement, type PageSnapshot, describeElement, elementCriteria } from "./elements.js";
import { FAST_LANE_THRESHOLD, ROUTES, ROUTE_THRESHOLD, type Route, appRequest, fileRequest, reconcileRoute, routeHeuristically } from "./route.js";
import { type VerifyInput, type VerifyResult, buildVerifyQuestions, buildVerifyState, heuristicVerdict, interpretVerifyAnswers, quickVerdict } from "./verify.js";

export const INTENTS = {
  open_url: {
    what: "Go to, open, visit or load a specific website, web address or named site",
    examples: ["open google.com", "go to youtube", "take me to the typesafe website"],
  },
  search_web: {
    what: "Run a web search for a topic; no particular site or on-page element is named",
    examples: ["search for cheap flights to lisbon", "google the weather in paris", "look up who invented the telephone"],
  },
  click: {
    what: "Click, press, tap, select, choose, open or toggle something that is on the current page: a link, button, tab, menu item, checkbox",
    examples: ["click on the pricing link", "press the sign in button", "open the first result", "select the docs tab"],
  },
  type_text: {
    what: "Type, enter, write or fill some words into a text field, search box or editor on the current page",
    examples: ["type hello world in the search box", "enter my name john", "search for cats here", "write a comment saying thanks"],
  },
  press_enter: {
    what: "Press the enter/return key or submit the current form without typing anything new",
    examples: ["press enter", "hit return", "submit"],
  },
  scroll: {
    what: "Scroll or move the page up, down, to the top or to the bottom",
    examples: ["scroll down", "go up a bit", "scroll to the bottom", "page down"],
  },
  go_back: { what: "Go back to the previous page in history", examples: ["go back", "back", "previous page"] },
  go_forward: { what: "Go forward in history", examples: ["go forward", "forward"] },
  reload: { what: "Reload or refresh the current page", examples: ["refresh", "reload the page"] },
  stop: { what: "Stop, cancel, wait, or never mind the current action", examples: ["stop", "cancel that", "never mind"] },
  unclear: {
    what: "Not an instruction for the web browser: small talk, a question to the assistant, background speech, or unintelligible",
    examples: ["what do you think", "hello there", "um so anyway"],
  },
} as const;

export type Intent = keyof typeof INTENTS;
/** Browser intents plus the one computer-lane intent code can act on before M5. */
export type DecisionIntent = Intent | "open_app" | "open_path";

export interface Alternative {
  elementId: string;
  label: string;
  probability: number;
}

export interface Decision {
  command: string;
  action: Action;
  intent: DecisionIntent;
  intentConfidence: number;
  /** Which lane handles the utterance; decided on the whole utterance, before splitting. */
  route: Route;
  routeConfidence: number;
  source: "jev" | "heuristic";
  /** P(action is hard to undo) from Jev; heuristics use a keyword list. */
  riskProbability: number;
  needsConfirmation: boolean;
  targetConfidence: number | null;
  alternatives: Alternative[];
  clarify: { question: string; options: Alternative[] } | null;
  meta: { model?: string; latencyMs: number; inputTokens?: number; fallbackReason?: string };
}

export const THRESHOLDS = {
  /** Below this, an intent answer is treated as "unclear" rather than acted on. */
  intent: 0.25,
  /** Below this, a target pick becomes a clarification with the top alternatives. */
  target: 0.35,
  /** Noul probability above which an action needs a spoken/clicked confirmation. */
  risk: 0.6,
  /** Noul probability above which typed text is followed by Enter. */
  submit: 0.6,
  /** Below this the route answer is ignored and the brain takes the utterance. */
  route: ROUTE_THRESHOLD,
  /** Route confidence the fast lanes (browser_now, computer) need; less is conversation. */
  fastLane: FAST_LANE_THRESHOLD,
  /** Intent confidence at or above which a browser intent counts as actionable for the fast lane. */
  browserIntent: 0.6,
};

/** Actions that are gated by the risk check; navigation and scrolling never are. */
const GATED_KINDS = new Set<Action["kind"]>(["click", "type", "press"]);

export function buildState(parsed: ParsedCommand, snapshot: PageSnapshot) {
  return {
    command: parsed.text,
    page: { url: snapshot.url, title: snapshot.title },
  };
}

/** Every question in one request; code reads only the answers the intent needs. */
export function buildQuestions(parsed: ParsedCommand, snapshot: PageSnapshot): Questions {
  const questions: Questions = {
    route: choice(
      {
        question: "The user is talking to their assistant, who answers and remembers. Should this go to the assistant as conversation, or is it an obvious quick action for the browser on the current page, or for opening a Mac app?",
        command: parsed.text,
      },
      ROUTES as unknown as ChoiceCriteria,
    ),
    intent: choice(
      { question: "If this is for the web browser, what is the user asking it to do?", command: parsed.text },
      INTENTS as unknown as ChoiceCriteria,
    ),
    risky: noul(
      { question: "Would carrying out this command do something hard to undo?", command: parsed.text },
      {
        true: "It would buy or pay for something, delete or remove data, send a message or email, post publicly, log out, or confirm/submit an order",
        false: "It only reads, navigates, scrolls, searches, types into a field, or opens something",
      },
    ),
    scroll_direction: choice({ question: "Which way does the user want the page to move?", command: parsed.text }, {
      down: "further down the page",
      up: "back up the page",
      top: "all the way to the top / beginning",
      bottom: "all the way to the bottom / end",
    }),
    submit_after_typing: noul(
      { question: "After the text is typed, does the user want it submitted right away (press enter / run the search)?", command: parsed.text },
      { true: "Yes: they said to search, submit, press enter, or the phrasing is 'search for X'", false: "No: just fill in the text and wait" },
    ),
  };
  if (snapshot.elements.length > 0) {
    questions.target = choice(
      {
        question: "Which element on the current page is the user referring to? Choose 'none' if the command does not name anything on this page.",
        command: parsed.text,
      },
      elementCriteria(snapshot.elements),
    );
  }
  if (parsed.urls.length > 1) {
    questions.url_pick = choice(
      { question: "Which of these web addresses does the user want to open?", command: parsed.text },
      Object.fromEntries(parsed.urls.map((u) => [u, null])),
    );
  }
  return questions;
}

type Answers = SystemOneResult<Questions>["answers"];

function choiceOf(answers: Answers, key: string): { choice: string; confidence: number; probabilities: Record<string, number> } | null {
  const a = answers[key];
  if (!a || a.type !== "choice") return null;
  return { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities as Record<string, number> };
}

function noulOf(answers: Answers, key: string, fallback = 0): number {
  const a = answers[key];
  return a && a.type === "noul" ? a.noul : fallback;
}

export function searchUrl(query: string): string {
  return `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
}

function topAlternatives(probabilities: Record<string, number>, elements: PageElement[], limit = 3): Alternative[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  return Object.entries(probabilities)
    .filter(([id, p]) => id !== NONE_OPTION && p >= 0.05 && byId.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, p]) => ({ elementId: id, label: describeElement(byId.get(id)!), probability: p }));
}

function textAfterVerb(parsed: ParsedCommand): string {
  return parsed.text.replace(/^(?:type|enter|write|input|put|say|search for|search|look up|google|find)\s+/, "").trim();
}

/** The URL an "open <url>" command names outright, when that URL is the whole target. There is
 *  nothing for Jev to weigh there, and on a page with one prominent link it has picked the link
 *  instead of the URL (2026-09-23). "open the pricing page on example.com" is not this. */
export function explicitNavigation(parsed: ParsedCommand): string | null {
  const [url, ...more] = parsed.urls;
  if (!url || more.length > 0 || !parsed.navTarget) return null;
  return toUrl(parsed.navTarget).toLowerCase() === url.toLowerCase() ? url : null;
}

function navigateTo(parsed: ParsedCommand, url: string): Decision {
  const d = base(parsed, "open_url", 1, "heuristic", { kind: "navigate", url });
  d.routeConfidence = 1;
  return d;
}

function base(parsed: ParsedCommand, intent: DecisionIntent, intentConfidence: number, source: Decision["source"], action: Action): Decision {
  return {
    command: parsed.text,
    action,
    intent,
    intentConfidence,
    route: "browser_now",
    routeConfidence: 0,
    source,
    riskProbability: 0,
    needsConfirmation: false,
    targetConfidence: null,
    alternatives: [],
    clarify: null,
    meta: { latencyMs: 0 },
  };
}

/** Pure: Jev's answers + pre-parsed command -> Decision. */
export function interpretAnswers(answers: Answers, parsed: ParsedCommand, snapshot: PageSnapshot): Decision {
  const d = interpretBrowserAnswers(answers, parsed, snapshot);
  const actionable = d.intent !== "unclear" && d.intent !== "stop";
  const r = reconcileRoute(choiceOf(answers, "route"), actionable && d.intentConfidence >= THRESHOLDS.browserIntent, actionable);
  return applyRoute(d, r.route, r.confidence, parsed);
}

/** Stamp the lane onto a browser decision and swap in the lane's own action where code can
 *  act: a parsed app name for the computer lane, a stop for stop. A computer route without a
 *  recognisable app, and background speech, are handed to the brain / reported as unclear. */
function applyRoute(d: Decision, route: Route, confidence: number, parsed: ParsedCommand): Decision {
  d.route = route;
  d.routeConfidence = confidence;
  if (route === "computer") {
    const app = appRequest(parsed.text);
    const file = app ? null : fileRequest(parsed.text);
    if (app) {
      d.intent = "open_app";
      d.action = { kind: "open_app", app };
      d.needsConfirmation = false;
      d.clarify = null;
    } else if (file) {
      d.intent = "open_path";
      d.action = { kind: "open_path", query: file };
      d.needsConfirmation = false;
      d.clarify = null;
    } else {
      d.route = "hermes";
      d.meta.fallbackReason ??= `computer route but no app/file matched in "${parsed.text}"`;
    }
  } else if (route === "stop") {
    d.intent = "stop";
    d.action = { kind: "stop" };
    d.needsConfirmation = false;
    d.clarify = null;
  } else if (route === "unclear") {
    d.intent = "unclear";
    d.action = { kind: "none", reason: "That didn't sound like it was for me" };
    d.needsConfirmation = false;
    d.clarify = null;
  }
  return d;
}

/** Pure: the browser part of Jev's answers -> Decision (route still to be applied). */
function interpretBrowserAnswers(answers: Answers, parsed: ParsedCommand, snapshot: PageSnapshot): Decision {
  const intentAns = choiceOf(answers, "intent");
  let intent = (intentAns?.choice ?? "unclear") as Intent;
  const intentConfidence = intentAns?.confidence ?? 0;
  if (!(intent in INTENTS) || intentConfidence < THRESHOLDS.intent) intent = "unclear";

  const target = choiceOf(answers, "target");
  const alternatives = target ? topAlternatives(target.probabilities, snapshot.elements) : [];
  const pickedElement = target && target.choice !== NONE_OPTION ? snapshot.elements.find((e) => e.id === target.choice) ?? null : null;
  const targetConfident = !!target && target.confidence >= THRESHOLDS.target;

  const finish = (action: Action): Decision => {
    const d = base(parsed, intent, intentConfidence, "jev", action);
    d.riskProbability = noulOf(answers, "risky");
    d.needsConfirmation = GATED_KINDS.has(action.kind) && d.riskProbability >= THRESHOLDS.risk;
    d.targetConfidence = target?.confidence ?? null;
    d.alternatives = alternatives;
    return d;
  };

  switch (intent) {
    case "open_url": {
      const picked = choiceOf(answers, "url_pick")?.choice;
      const url = (picked && parsed.urls.includes(picked) ? picked : parsed.urls[0]) ?? parsed.siteGuess;
      if (url) return finish({ kind: "navigate", url });
      const q = parsed.navTarget ?? parsed.searchQuery ?? textAfterVerb(parsed);
      return finish({ kind: "search", query: q, url: searchUrl(q) });
    }
    case "search_web": {
      const q = parsed.searchQuery ?? parsed.navTarget ?? textAfterVerb(parsed);
      return finish({ kind: "search", query: q, url: searchUrl(q) });
    }
    case "click": {
      if (pickedElement && targetConfident) {
        return finish({ kind: "click", elementId: pickedElement.id, label: describeElement(pickedElement) });
      }
      const d = finish({ kind: "none", reason: `I couldn't find "${parsed.clickLabel ?? parsed.text}" on this page` });
      if (alternatives.length > 0) {
        d.clarify = { question: `Which one did you mean${parsed.clickLabel ? ` by "${parsed.clickLabel}"` : ""}?`, options: alternatives };
      }
      return d;
    }
    case "type_text": {
      const text = parsed.typed?.text ?? textAfterVerb(parsed);
      if (!text) return finish({ kind: "none", reason: "I didn't catch what to type" });
      const submit = parsed.typed?.submit || noulOf(answers, "submit_after_typing") >= THRESHOLDS.submit;
      const el = pickedElement && targetConfident ? pickedElement : null;
      return finish({ kind: "type", elementId: el?.id ?? null, label: el ? describeElement(el) : null, text, submit });
    }
    case "press_enter":
      return finish({ kind: "press", key: "Enter" });
    case "scroll": {
      const dir = (parsed.scroll ?? (choiceOf(answers, "scroll_direction")?.choice as ScrollDirection | undefined) ?? "down") as ScrollDirection;
      return finish({ kind: "scroll", direction: dir });
    }
    case "go_back":
      return finish({ kind: "back" });
    case "go_forward":
      return finish({ kind: "forward" });
    case "reload":
      return finish({ kind: "reload" });
    case "stop":
      return finish({ kind: "stop" });
    case "unclear":
    default:
      return finish({ kind: "none", reason: "That didn't sound like a browser command" });
  }
}

// ---------------------------------------------------------------------------
// Heuristic fallback (no API key, or Jev unreachable)
// ---------------------------------------------------------------------------

const RISKY_WORDS = /\b(?:buy|purchase|pay|checkout|order|delete|remove|send|post|publish|submit|confirm|log ?out|sign ?out|unsubscribe|transfer)\b/;

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9@.]+/).filter((t) => t.length > 1 && !["the", "on", "in", "to", "of", "and", "a", "an"].includes(t));
}

/** Score page elements against a spoken label: token overlap plus substring bonus. */
export function matchElements(label: string, elements: PageElement[], fieldsOnly = false): Alternative[] {
  const want = tokens(label);
  if (want.length === 0) return [];
  const scored: Alternative[] = [];
  for (const e of elements) {
    const isField = ["input", "textarea", "select"].includes(e.tag) || ["textbox", "combobox", "searchbox"].includes(e.role);
    if (fieldsOnly && !isField) continue;
    const hay = `${e.text} ${e.label} ${e.placeholder} ${e.name} ${e.hrefShort ?? ""} ${describeElement(e)}`.toLowerCase();
    const have = new Set(tokens(hay));
    let hits = 0;
    for (const w of want) if (have.has(w) || hay.includes(w)) hits++;
    if (hits === 0) continue;
    let score = hits / want.length;
    if (hay.includes(label.toLowerCase())) score += 0.5;
    if (e.inViewport) score += 0.05;
    scored.push({ elementId: e.id, label: describeElement(e), probability: score });
  }
  scored.sort((a, b) => b.probability - a.probability);
  const total = scored.reduce((s, a) => s + a.probability, 0) || 1;
  return scored.slice(0, 3).map((a) => ({ ...a, probability: Math.min(1, a.probability / total) }));
}

export function decideHeuristically(parsed: ParsedCommand, snapshot: PageSnapshot): Decision {
  const direct = explicitNavigation(parsed);
  if (direct) return navigateTo(parsed, direct);
  const d = decideBrowserHeuristically(parsed, snapshot);
  const r = routeHeuristically(parsed.text, d.intent !== "unclear" && d.intent !== "stop");
  // "open the documentation" with a Documentation link in front is that link, not a file search
  if (r.route === "computer" && !appRequest(parsed.text) && d.action.kind === "click") return applyRoute(d, "browser_now", r.confidence, parsed);
  return applyRoute(d, r.route, r.confidence, parsed);
}

function decideBrowserHeuristically(parsed: ParsedCommand, snapshot: PageSnapshot): Decision {
  const t = parsed.text;
  const mk = (intent: Intent, action: Action, conf = 0.7): Decision => {
    const d = base(parsed, intent, conf, "heuristic", action);
    d.riskProbability = RISKY_WORDS.test(t) ? 0.8 : 0.05;
    d.needsConfirmation = GATED_KINDS.has(action.kind) && d.riskProbability >= THRESHOLDS.risk;
    return d;
  };
  const fields = snapshot.elements.filter((e) => ["input", "textarea"].includes(e.tag) || ["textbox", "combobox", "searchbox"].includes(e.role));
  const searchBox = fields.find((e) => /search/i.test(`${e.type} ${e.placeholder} ${e.label} ${e.name} ${e.role}`));

  if (/^(?:stop|cancel|halt|wait|never ?mind|abort)(?:\s+(?:that|it|this))?$/.test(t)) return mk("stop", { kind: "stop" }, 0.95);
  if (/^(?:go\s+)?back(?:wards?)?(?:\s+(?:a\s+)?page)?$|^previous page$/.test(t)) return mk("go_back", { kind: "back" }, 0.95);
  if (/^(?:go\s+)?forwards?$/.test(t)) return mk("go_forward", { kind: "forward" }, 0.95);
  if (/^(?:reload|refresh)(?:\s+(?:the\s+)?page)?$/.test(t)) return mk("reload", { kind: "reload" }, 0.95);
  if (/\bscroll\b|^page (?:up|down)$|^(?:go|move) (?:up|down)\b/.test(t)) return mk("scroll", { kind: "scroll", direction: parsed.scroll ?? "down" }, 0.9);
  if (/^(?:press|hit|push)\s+(?:the\s+)?(?:enter|return)(?:\s+key)?$|^submit(?:\s+(?:the\s+)?form)?$/.test(t)) return mk("press_enter", { kind: "press", key: "Enter" }, 0.95);

  if (parsed.typed && /^(?:type|enter|write|input|fill|put|insert|paste|key in)\b/.test(t)) {
    const cands = parsed.typed.targetHint ? matchElements(parsed.typed.targetHint, fields, true) : [];
    const el = cands[0] ? snapshot.elements.find((e) => e.id === cands[0]!.elementId) ?? null : null;
    return mk("type_text", { kind: "type", elementId: el?.id ?? null, label: el ? describeElement(el) : null, text: parsed.typed.text, submit: parsed.typed.submit });
  }
  if (parsed.searchQuery !== null && /^(?:search|google|look ?up|find)\b/.test(t)) {
    if (searchBox && !/\b(?:web|internet|google|online)\b/.test(t)) {
      return mk("type_text", { kind: "type", elementId: searchBox.id, label: describeElement(searchBox), text: parsed.searchQuery, submit: true });
    }
    return mk("search_web", { kind: "search", query: parsed.searchQuery, url: searchUrl(parsed.searchQuery) });
  }
  if (parsed.urls[0]) return mk("open_url", { kind: "navigate", url: parsed.urls[0] }, 0.9);
  if (parsed.navTarget) {
    // "open pricing" on a page that has a Pricing link means click, not navigate
    const onPage = matchElements(parsed.navTarget, snapshot.elements);
    if (onPage[0] && onPage[0].probability >= 0.5 && !knownSiteUrl(parsed.navTarget)) {
      const el = snapshot.elements.find((e) => e.id === onPage[0]!.elementId)!;
      return mk("click", { kind: "click", elementId: el.id, label: describeElement(el) }, 0.6);
    }
    if (parsed.siteGuess) return mk("open_url", { kind: "navigate", url: parsed.siteGuess }, 0.6);
    if (onPage[0]) {
      const el = snapshot.elements.find((e) => e.id === onPage[0]!.elementId)!;
      return mk("click", { kind: "click", elementId: el.id, label: describeElement(el) }, 0.5);
    }
    return mk("search_web", { kind: "search", query: parsed.navTarget, url: searchUrl(parsed.navTarget) }, 0.5);
  }
  if (parsed.clickLabel) {
    const cands = matchElements(parsed.clickLabel, snapshot.elements);
    const d = mk("click", { kind: "none", reason: `I couldn't find "${parsed.clickLabel}" on this page` }, 0.6);
    d.alternatives = cands;
    if (cands[0] && (cands[0].probability >= 0.5 || cands.length === 1)) {
      const el = snapshot.elements.find((e) => e.id === cands[0]!.elementId)!;
      d.action = { kind: "click", elementId: el.id, label: describeElement(el) };
      d.needsConfirmation = GATED_KINDS.has("click") && d.riskProbability >= THRESHOLDS.risk;
      d.targetConfidence = cands[0].probability;
    } else if (cands.length > 1) {
      d.clarify = { question: `Which one did you mean by "${parsed.clickLabel}"?`, options: cands };
    }
    return d;
  }
  return mk("unclear", { kind: "none", reason: "That didn't sound like a browser command" }, 0.3);
}

// ---------------------------------------------------------------------------
// Decider: Jev when configured, heuristics otherwise (and as a safety net)
// ---------------------------------------------------------------------------

export type ReplyKind = "confirm" | "cancel" | "other";

export interface Decider {
  readonly enabled: boolean;
  readonly model: string | null;
  decide(raw: string, snapshot: PageSnapshot, signal?: AbortSignal): Promise<Decision>;
  classifyReply(raw: string, pendingActionLabel: string): Promise<ReplyKind>;
  /** Did the action achieve the step? Code decides the obvious cases; Jev the rest. */
  verify(input: VerifyInput, signal?: AbortSignal): Promise<VerifyResult>;
}

export class HeuristicDecider implements Decider {
  readonly enabled = false;
  readonly model = null;
  async decide(raw: string, snapshot: PageSnapshot): Promise<Decision> {
    const t0 = performance.now();
    const d = decideHeuristically(parseCommand(raw), snapshot);
    d.meta.latencyMs = Math.round(performance.now() - t0);
    return d;
  }
  async classifyReply(raw: string): Promise<ReplyKind> {
    const yn = parseYesNo(raw);
    return yn === null ? "other" : yn ? "confirm" : "cancel";
  }
  async verify(input: VerifyInput): Promise<VerifyResult> {
    const state = buildVerifyState(input);
    return quickVerdict(state, input.action) ?? heuristicVerdict(state);
  }
}

export class JevDecider implements Decider {
  readonly enabled = true;
  readonly model: string;
  private readonly fallback = new HeuristicDecider();

  constructor(private readonly client: TypeSafeClient) {
    this.model = client.defaultModel;
  }

  async decide(raw: string, snapshot: PageSnapshot, signal?: AbortSignal): Promise<Decision> {
    const parsed = parseCommand(raw);
    const direct = explicitNavigation(parsed);
    if (direct) return navigateTo(parsed, direct);
    const t0 = performance.now();
    try {
      const res = await this.client.systemOne({ state: buildState(parsed, snapshot), questions: buildQuestions(parsed, snapshot) }, { signal, timeout: 8000 });
      const d = interpretAnswers(res.answers, parsed, snapshot);
      d.meta = { model: res.model, latencyMs: Math.round(performance.now() - t0), inputTokens: res.usage.input_tokens };
      return d;
    } catch (err) {
      if (signal?.aborted) throw err;
      const d = decideHeuristically(parsed, snapshot);
      d.meta.latencyMs = Math.round(performance.now() - t0);
      d.meta.fallbackReason = err instanceof Error ? err.message : String(err);
      return d;
    }
  }

  async verify(input: VerifyInput, signal?: AbortSignal): Promise<VerifyResult> {
    const state = buildVerifyState(input);
    const quick = quickVerdict(state, input.action);
    if (quick) return quick;
    const t0 = performance.now();
    try {
      const res = await this.client.systemOne({ state, questions: buildVerifyQuestions(state) }, { signal, timeout: 6000 });
      const v = interpretVerifyAnswers(res.answers);
      v.meta = { latencyMs: Math.round(performance.now() - t0), inputTokens: res.usage.input_tokens };
      return v;
    } catch (err) {
      if (signal?.aborted) throw err;
      const v = heuristicVerdict(state);
      v.meta = { latencyMs: Math.round(performance.now() - t0), fallbackReason: err instanceof Error ? err.message : String(err) };
      return v;
    }
  }

  /** Fast regex first; Jev only for replies like "go ahead and do it" the regex misses. */
  async classifyReply(raw: string, pendingActionLabel: string): Promise<ReplyKind> {
    const yn = parseYesNo(raw);
    if (yn !== null) return yn ? "confirm" : "cancel";
    try {
      const res = await this.client.systemOne(
        {
          state: { pending_action: pendingActionLabel, user_reply: raw },
          questions: {
            reply: choice("The browser asked the user to confirm the pending action. How does the user's reply answer that?", {
              confirm: "Agrees: go ahead with the pending action",
              cancel: "Declines: do not do the pending action",
              other: "Neither: it is a new, unrelated command or not an answer",
            }),
          },
        },
        { timeout: 5000 },
      );
      const a = res.answers.reply;
      return a.confidence >= 0.4 ? a.choice : "other";
    } catch {
      return "other";
    }
  }
}

export function createDecider(env: NodeJS.ProcessEnv = process.env): Decider {
  if (!env.TYPESAFE_API_KEY?.trim()) return new HeuristicDecider();
  return new JevDecider(new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY, logLevel: "warn" }));
}

export { describeAction };
