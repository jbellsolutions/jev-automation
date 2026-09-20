/** Which lane handles an utterance. Answered by Jev in the same fan-out as the browser intent
 *  (see decide.ts) and mirrored by keywords when Jev is off. The route is decided on the whole
 *  utterance before it is split into browser steps, so "find 20 dentists and put them in a
 *  sheet" reaches the brain in one piece.
 *
 *  The brain is the person the user talks to; the other lanes exist only for the
 *  obvious cases where a round trip through it would be a waste: one plain action on the page
 *  that is open, or opening a named Mac app. Anything else — greetings, questions, half
 *  sentences, every to-do — is conversation. */
import { knownSiteUrl } from "./commands.js";

export const ROUTES = {
  browser_now: {
    what: "An obvious, single, immediate action on the web page or Mac app that is open in front right now, or a plain web search: open a named site, click or press something visible, type into a field, scroll, go back, reload. Nothing that needs judgement, memory, an account, or more than one tool",
    examples: ["click the pricing link", "open wikipedia and search for cats", "scroll down", "type hello in the search box", "google the weather in paris", "click general"],
  },
  computer: {
    what: "Launch or switch to a named application on this Mac, or open one of the user's files or folders by name (not a website, not a task inside the app)",
    examples: ["open slack", "switch to finder", "launch textedit", "open my resume", "open the q3 budget spreadsheet"],
  },
  hermes: {
    what: "Everything else, said to the assistant as a person: greetings and chit-chat, questions, anything about the user or their day, reminders, email, messages, calendar, files, research, writing, a to-do to carry out, anything needing judgement or memory, or anything not covered by the two lanes above",
    examples: ["yo can you hear me", "what did I ask you yesterday", "find me 20 dentists in austin and put them in a sheet", "what's on my calendar today", "open slack and leave a note for xander in the content channel", "check my email for anything new"],
  },
  stop: { what: "Stop, cancel, wait, or never mind whatever is going on", examples: ["stop", "cancel that", "never mind"] },
  unclear: {
    what: "Only an empty or unintelligible fragment with no words the assistant could act on or answer",
    examples: ["uh", "the the"],
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

const APP_VERB = /^(?:open(?: up)?|launch|start|switch to|go to|bring up|show me|focus),?\s+(?:the\s+)?(?:app\s+)?(.+?)(?:\s+app)?$/;
/** Trailing words a real request often carries that aren't part of the app's name — stripped
 *  before the MAC_APPS lookup so "open slack for me"/"...real quick" still resolve. */
const APP_TRAILING_FILLER = /\s+(?:for me|real quick|real fast|quickly|now)$/;

/** "open slack" -> "slack"; null unless the target is a known Mac application. Tolerant of a
 *  comma after the verb, trailing filler, and a plural mis-hear ("slacks" -> "slack") — all
 *  ordinary speech-to-text artifacts, not different requests. */
export function appRequest(text: string): string | null {
  const m = APP_VERB.exec(text.trim().toLowerCase());
  if (!m) return null;
  const name = m[1]!.trim().replace(APP_TRAILING_FILLER, "").trim();
  if (MAC_APPS.includes(name) && !knownSiteUrl(name)) return name;
  const singular = name.replace(/s$/, "");
  if (singular !== name && MAC_APPS.includes(singular) && !knownSiteUrl(singular)) return singular;
  return null;
}

const FILE_VERB = /^(?:open(?: up)?|show me|pull up|bring up|find)\s+(?:my|the|our)\s+(.+?)(?:\s+(?:file|document|doc|pdf|spreadsheet|sheet|presentation|deck|folder|directory|image|photo|picture|video|note))?$/;
const NOT_A_FILE = /^(?:calendar|email|e-mail|mail|inbox|messages?|slack|browser|settings|desktop|screen|day|schedule|tasks?|todos?|to-dos?|notes app)$|\b(?:page|site|website|tab|link|section|menu|button|channel|thread|app)$/;

/** "open my resume" -> "resume"; "open the q3 budget spreadsheet" -> "q3 budget". Null for apps,
 *  sites and things that are not files ("open my calendar" is a task for the brain). */
export function fileRequest(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/[.!?,]+$/, "");
  if (appRequest(t)) return null;
  const m = FILE_VERB.exec(t);
  if (!m) return null;
  const name = m[1]!.trim();
  if (!name || NOT_A_FILE.test(name) || MAC_APPS.includes(name) || knownSiteUrl(name)) return null;
  return name;
}

const STOP = /^(?:stop|cancel|halt|wait|never ?mind|abort|hold on)(?:\s+(?:that|it|this|everything))?$/;
const RESET = /^(?:(?:start|begin)\s+(?:a\s+)?(?:new|fresh)\s+(?:conversation|chat|session|thread)|(?:new|fresh)\s+(?:conversation|chat|session|thread|start)|start\s+over|reset\s+(?:the\s+)?(?:conversation|chat|session|thread)|forget\s+(?:all\s+)?(?:that|this|the\s+conversation))(?:\s+please)?$/;

const SLEEP = /^(?:go to sleep|(?:go )?(?:to )?sleep(?: now)?|pause|turn (?:yourself )?off|shut (?:up|down)|that's (?:all|it)(?: for now)?|(?:good ?night|goodnight))(?:\s+(?:jev|jarvis|hermes))?(?:\s+please)?$/;

/** "go to sleep", "pause", "turn off", "that's all for now": switch the assistant off. */
export function isSleepCommand(text: string): boolean {
  return SLEEP.test(text.trim().toLowerCase().replace(/[.!?,]+$/, ""));
}

/** "new conversation", "start over", "fresh start": the brain forgets this thread and begins another. */
export function isResetCommand(text: string): boolean {
  return RESET.test(text.trim().toLowerCase().replace(/[.!?,]+$/, ""));
}

/** "stop", "cancel that", "never mind": halts everything, never counts as an answer. */
export function isStopWord(text: string): boolean {
  return STOP.test(text.trim().toLowerCase().replace(/[.!?,]+$/, ""));
}
const QUESTION = /^(?:what|what's|whats|who|who's|when|where|why|how|which|is|are|am|do|does|did|can|could|would|should|will|tell me|remind me|explain|summarize|summarise|help me|remember|recall)\b/;
const GREETING = /^(?:yo|hey|hi|hello|hiya|howdy|sup|what's up|whats up|good (?:morning|afternoon|evening)|thanks|thank you|okay|ok|cool|nice|great|yes|no|yeah|nope)\b/;
const PERSONAL = /\b(?:my|me|i|i'm|i've|i'd|we|our)\b/;
const TASK_VERB = /^(?:find me|research|write|draft|compose|email|message|text|send|schedule|book|plan|create|make|build|check|look into|compare|list|get me|read|delete|move|copy|rename|run|install|update|download|leave|post|reply|call|order)\b/;
/** Anywhere in the utterance, these mean a message, a person or a judgement is involved — a
 *  to-do for the brain even when it starts like a page command ("open slack and leave a note"). */
const TASK_ANYWHERE = /\b(?:note|message|email|e-mail|mail|inbox|text|remind|reminder|schedule|meeting|calendar|slack|tell|ask|leave|send|write|draft|reply|post|call|order|research|summari[sz]e|compare|plan)\b/;

/** Keyword mirror of the route question, for when Jev is off or unreachable. `browserIntent`
 *  is whether the heuristic browser decider recognised a page command in the text. The bar for
 *  the browser lane is high on purpose: a page verb with a concrete target and nothing personal
 *  or conversational around it. */
export function routeHeuristically(text: string, browserIntent: boolean): { route: Route; confidence: number } {
  const t = text.trim().toLowerCase();
  if (!t) return { route: "unclear", confidence: 0.9 };
  if (STOP.test(t)) return { route: "stop", confidence: 0.95 };
  if (appRequest(t) || fileRequest(t)) return { route: "computer", confidence: 0.85 };
  if (GREETING.test(t) || QUESTION.test(t) || TASK_VERB.test(t)) return { route: "hermes", confidence: 0.85 };
  if (browserIntent && !PERSONAL.test(t) && !TASK_ANYWHERE.test(t)) return { route: "browser_now", confidence: 0.75 };
  return { route: "hermes", confidence: 0.7 };
}

/** Below this the route answer is ignored altogether. */
export const ROUTE_THRESHOLD = 0.4;
/** The fast lanes need to be this sure; anything less is conversation for the brain. */
export const FAST_LANE_THRESHOLD = 0.6;

/** Reconcile Jev's route answer with its browser-intent answer. The brain is the default: the
 *  browser lane needs a confident route *and* a confident, actionable browser intent; the
 *  computer lane a confident route (and, later, a parsed app name); stop and unclear are taken
 *  at the lower threshold. */
export function reconcileRoute(
  answer: { choice: string; confidence: number } | null,
  browserIntentConfident: boolean,
  hasBrowserIntent: boolean,
): { route: Route; confidence: number } {
  const conf = answer?.confidence ?? 0;
  const picked = answer && answer.choice in ROUTES && conf >= ROUTE_THRESHOLD ? (answer.choice as Route) : null;
  if (picked === "browser_now") return { route: conf >= FAST_LANE_THRESHOLD && hasBrowserIntent && browserIntentConfident ? "browser_now" : "hermes", confidence: conf };
  if (picked === "computer") return { route: conf >= FAST_LANE_THRESHOLD ? "computer" : "hermes", confidence: conf };
  if (picked === "stop" || picked === "unclear") return { route: picked, confidence: conf };
  return { route: "hermes", confidence: conf };
}
