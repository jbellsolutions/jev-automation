/** Which lane handles an utterance. Answered by Jev in the same fan-out as the browser intent
 *  (see decide.ts) and mirrored by keywords when Jev is off. The route is decided on the whole
 *  utterance before it is split into browser steps, so "find 20 dentists and put them in a
 *  sheet" reaches the brain in one piece. */
import { knownSiteUrl } from "./commands.js";

export const ROUTES = {
  browser_now: {
    what: "One direct action on the web page that is open right now, or a plain web search: open a site, click or press something on the page, type into a field, scroll, go back, reload",
    examples: ["click the pricing link", "open wikipedia and search for cats", "scroll down", "type hello in the search box"],
  },
  computer: {
    what: "Open, launch or switch to an application on this Mac — not a website",
    examples: ["open slack", "switch to finder", "launch textedit"],
  },
  hermes: {
    what: "Anything that needs thinking, memory, tools or several steps: a question, a request for information, research, writing, files, calendar, email, messages, a task to carry out end to end",
    examples: ["what did I ask you yesterday", "find me 20 dentists in austin and put them in a sheet", "what's on my calendar today", "summarize this page for me"],
  },
  stop: { what: "Stop, cancel, wait, or never mind whatever is going on", examples: ["stop", "cancel that", "never mind"] },
  unclear: {
    what: "Background speech or noise, someone else talking, or words not addressed to the assistant",
    examples: ["um so anyway", "yeah I'll call you back"],
  },
} as const;

export type Route = keyof typeof ROUTES;

/** Applications people open by voice. Names that are also websites ("spotify", "maps") are
 *  left to the browser lane on purpose. */
export const MAC_APPS = [
  "finder", "slack", "safari", "chrome", "google chrome", "firefox", "arc", "mail", "messages", "notes", "textedit", "terminal", "iterm",
  "calendar", "reminders", "music", "photos", "preview", "xcode", "vs code", "visual studio code", "cursor", "obsidian", "zoom", "discord",
  "figma", "system settings", "system preferences", "activity monitor", "calculator", "notion", "keynote", "pages", "numbers", "word", "excel",
  "powerpoint", "outlook", "teams", "whatsapp", "telegram", "signal", "1password", "docker", "postman", "warp", "claude", "chatgpt",
];

const APP_VERB = /^(?:open(?: up)?|launch|start|switch to|go to|bring up|show me|focus)\s+(?:the\s+)?(?:app\s+)?(.+?)(?:\s+app)?$/;

/** "open slack" -> "slack"; null unless the target is a known Mac application. */
export function appRequest(text: string): string | null {
  const m = APP_VERB.exec(text.trim().toLowerCase());
  if (!m) return null;
  const name = m[1]!.trim();
  if (!MAC_APPS.includes(name) || knownSiteUrl(name)) return null;
  return name;
}

const STOP = /^(?:stop|cancel|halt|wait|never ?mind|abort|hold on)(?:\s+(?:that|it|this|everything))?$/;
const QUESTION = /^(?:what|what's|whats|who|who's|when|where|why|how|which|is|are|am|do|does|did|can|could|would|should|will|tell me|remind me|explain|summarize|summarise|help me|remember|recall)\b/;
const TASK_VERB = /^(?:find me|research|write|draft|compose|email|message|text|send|schedule|book|plan|create|make|build|check|look into|compare|list|get me|read|delete|move|copy|rename|run|install|update|download)\b/;

/** Keyword mirror of the route question, for when Jev is off or unreachable. `browserIntent`
 *  is whether the heuristic browser decider recognised a page command in the text. */
export function routeHeuristically(text: string, browserIntent: boolean): { route: Route; confidence: number } {
  const t = text.trim().toLowerCase();
  if (!t) return { route: "unclear", confidence: 0.9 };
  if (STOP.test(t)) return { route: "stop", confidence: 0.95 };
  if (appRequest(t)) return { route: "computer", confidence: 0.85 };
  if (QUESTION.test(t) || TASK_VERB.test(t)) return { route: "hermes", confidence: 0.8 };
  if (browserIntent) return { route: "browser_now", confidence: 0.75 };
  if (t.split(/\s+/).length >= 6) return { route: "hermes", confidence: 0.7 };
  return { route: "hermes", confidence: 0.45 };
}

export const ROUTE_THRESHOLD = 0.4;

/** Reconcile Jev's route answer with its browser-intent answer: below the threshold a confident
 *  page verb keeps the fast lane, anything else goes to the brain (which can ask back). A
 *  browser route without a recognisable browser intent is not actionable, so it goes to the
 *  brain too. */
export function reconcileRoute(
  answer: { choice: string; confidence: number } | null,
  browserIntentConfident: boolean,
  hasBrowserIntent: boolean,
): { route: Route; confidence: number } {
  const picked = answer && answer.choice in ROUTES && answer.confidence >= ROUTE_THRESHOLD ? (answer.choice as Route) : null;
  if (picked === "browser_now" && !hasBrowserIntent) return { route: "hermes", confidence: answer!.confidence };
  if (picked) return { route: picked, confidence: answer!.confidence };
  if (browserIntentConfident) return { route: "browser_now", confidence: answer?.confidence ?? 0 };
  return { route: "hermes", confidence: answer?.confidence ?? 0 };
}
