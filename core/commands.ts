/** Pure text pre-processing for spoken commands.
 *
 *  Jev cannot generate strings, so anything that has to be copied verbatim into the
 *  browser — a URL, a search query, text to type — is found here with plain code and
 *  handed to Jev as candidates to pick from (the "pre-parsed value extraction" pattern
 *  from the TypeSafe cookbooks). */

const FILLER =
  /^(?:(?:hey|hi|ok|okay|please|can you|could you|would you|will you|now|then|and|um|uh|so|just|jev|browser|computer)[\s,]+)+/i;

const TLDS = "com|org|net|io|ai|dev|co|edu|gov|app|xyz|me|info|tv|uk|in|de|fr|us|ca|au|nl|es|it|jp|ch|se|no|eu";

/** Well-known sites people name without a TLD. */
const SITE_ALIASES: Record<string, string> = {
  google: "https://www.google.com",
  youtube: "https://www.youtube.com",
  wikipedia: "https://www.wikipedia.org",
  github: "https://github.com",
  reddit: "https://www.reddit.com",
  twitter: "https://x.com",
  x: "https://x.com",
  amazon: "https://www.amazon.com",
  gmail: "https://mail.google.com",
  "google maps": "https://maps.google.com",
  maps: "https://maps.google.com",
  "hacker news": "https://news.ycombinator.com",
  hackernews: "https://news.ycombinator.com",
  "stack overflow": "https://stackoverflow.com",
  stackoverflow: "https://stackoverflow.com",
  chatgpt: "https://chatgpt.com",
  claude: "https://claude.ai",
  linkedin: "https://www.linkedin.com",
  facebook: "https://www.facebook.com",
  instagram: "https://www.instagram.com",
  netflix: "https://www.netflix.com",
  typesafe: "https://typesafe.ai",
  "type safe": "https://typesafe.ai",
  bbc: "https://www.bbc.com",
  cnn: "https://www.cnn.com",
  "new york times": "https://www.nytimes.com",
  ebay: "https://www.ebay.com",
  spotify: "https://open.spotify.com",
  "duck duck go": "https://duckduckgo.com",
  duckduckgo: "https://duckduckgo.com",
};

/** Lower-case, strip filler, and turn spoken URL pieces ("google dot com") into text. */
export function normalizeSpeech(raw: string): string {
  let t = raw.trim().toLowerCase();
  t = t.replace(/[.!?,;:]+$/g, "");
  t = t.replace(FILLER, "");
  t = t.replace(/[\s,]+please$/, "");
  t = t.replace(/\bwww\s+dot\s+/g, "www.");
  t = t.replace(new RegExp(`\\s*\\bdot\\s+(?=(?:${TLDS})\\b)`, "g"), ".");
  t = t.replace(new RegExp(`\\b(${TLDS})\\s+slash\\s+`, "g"), "$1/");
  // "john at example.com" -> "john@example.com"
  t = t.replace(/\b([a-z0-9._-]+)\s+at\s+([a-z0-9-]+\.[a-z.]{2,})/g, "$1@$2");
  return t.replace(/\s+/g, " ").trim();
}

const URL_RE = new RegExp(
  `(?:https?:\\/\\/[^\\s"']+|\\blocalhost(?::\\d+)?(?:\\/[^\\s"']*)?|\\b(?:[a-z0-9-]+\\.)+(?:${TLDS})\\b(?::\\d+)?(?:\\/[^\\s"']*)?)`,
  "gi",
);

/** Every URL-looking span in the text, in order, deduped, without emails. */
export function findUrlCandidates(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const span = m[0].replace(/[.,;:)]+$/, "");
    // skip the domain half of an email address
    const before = text.charAt(m.index - 1);
    if (before === "@") continue;
    if (!seen.has(span)) {
      seen.add(span);
      out.push(span);
    }
  }
  return out;
}

export function toUrl(candidate: string): string {
  if (/^https?:\/\//i.test(candidate)) return candidate;
  if (/^localhost/i.test(candidate)) return `http://${candidate}`;
  return `https://${candidate}`;
}

/** normalizeSpeech lowercases everything, but a URL's path and query are case-sensitive (a
 *  YouTube id, a signed link). Take the URL back from the raw text when it is there verbatim,
 *  as it is whenever it was typed rather than spoken. */
function withRawCase(span: string, raw: string): string {
  const at = raw.toLowerCase().indexOf(span);
  const original = at >= 0 ? raw.slice(at, at + span.length) : "";
  return original.toLowerCase() === span ? original : span;
}

const NAV_VERB =
  /^(?:go to|goto|go on|go on to|open up|open|navigate to|visit|launch|take me to|show me|bring up|head to|head over to|load|pull up|switch to)\s+(?:the\s+)?(?:website|site|web page|webpage|page|url|homepage|home page)?\s*(?:of\s+|for\s+|called\s+|at\s+)?(.+)$/i;

/** The thing after "open" / "go to", if the command is phrased as navigation. */
export function navigationTarget(text: string): string | null {
  const m = NAV_VERB.exec(text);
  if (!m?.[1]) return null;
  return m[1]
    .replace(/^the\s+/, "")
    .replace(/\s+(?:website|site|web page|webpage|homepage|home page|page)$/, "")
    .trim();
}

/** Turn a spoken site name into a URL without inventing anything clever:
 *  known aliases, or a single word -> word.com. Anything else is a web search. */
/** URL of a well-known site named without its TLD ("youtube", "hacker news"), else null. */
export function knownSiteUrl(name: string): string | null {
  const key = name.replace(/[^a-z0-9 ]/g, "").trim();
  return SITE_ALIASES[key] ?? SITE_ALIASES[key.replace(/\s+/g, "")] ?? null;
}

export function guessSiteUrl(name: string): string | null {
  const key = name.replace(/[^a-z0-9 ]/g, "").trim();
  if (!key) return null;
  const alias = knownSiteUrl(key);
  if (alias) return alias;
  if (/^[a-z0-9-]{2,}$/.test(key) && !/^(?:it|this|that|there|here|back|up|down)$/.test(key)) {
    return `https://${key}.com`;
  }
  return null;
}

const SEARCH_VERB =
  /^(?:search(?: the (?:web|internet))?(?: online)?(?: for)?|google(?: for)?|look up|lookup|find(?: me)?|web search(?: for)?|search google for|search for)\s+(.+)$/i;

export function extractSearchQuery(text: string): string | null {
  const m = SEARCH_VERB.exec(text);
  if (!m?.[1]) return null;
  return m[1].replace(/\s+(?:on|in|using|with)\s+(?:google|the web|the internet|duckduckgo|bing)$/, "").trim() || null;
}

export interface TypedText {
  /** Verbatim text to type. */
  text: string;
  /** Spoken description of the field, e.g. "the search box"; null when none was given. */
  targetHint: string | null;
  /** True when the user also said "and press enter" / "and search". */
  submit: boolean;
}

const TYPE_VERB =
  /^(?:type|enter|write|input|fill(?: in| out)?|put|insert|paste|key in|search for|search)\s+(?:in\s+)?(.+)$/i;
const SUBMIT_TAIL = /\s*(?:,|and|then)?\s*(?:(?:hit|press|push)\s+(?:enter|return|go|search)|(?:and\s+)?(?:submit|search)(?: it)?)$/i;
const TARGET_CLAUSE =
  /\s+(?:in|into|inside|on|to|at)\s+((?:the\s+)?(?:[a-z0-9' -]{0,40}?)(?:search\s*(?:box|bar|field|input)|text\s*box|textbox|box|field|input|bar|form|email|password|username|name|address|comment|message|query|prompt|composer)(?:\s+(?:box|field|input|bar))?)$/i;

export function extractTypedText(text: string): TypedText | null {
  const m = TYPE_VERB.exec(text);
  if (!m?.[1]) return null;
  let body = m[1].trim();
  let submit = false;
  const tail = SUBMIT_TAIL.exec(body);
  if (tail && tail.index > 0) {
    body = body.slice(0, tail.index).trim();
    submit = true;
  }
  let targetHint: string | null = null;
  const tc = TARGET_CLAUSE.exec(body);
  if (tc && tc.index > 0 && tc[1]) {
    targetHint = tc[1].replace(/^the\s+/, "").trim();
    body = body.slice(0, tc.index).trim();
  }
  body = body.replace(/^(?:the (?:text|words?|phrase|following)\s+)/, "").replace(/^["'“‘]|["'”’]$/g, "").trim();
  if (!body) return null;
  return { text: body, targetHint, submit };
}

const CLICK_VERB =
  /^(?:click(?: on)?|press(?: on)?|tap(?: on)?|select|choose|hit|push|toggle|check|uncheck|open|go to|follow|activate|expand|pick)\s+(?:the\s+|on the\s+)?(.+?)(?:\s+(?:link|button|tab|option|menu|item|icon|checkbox|box|field|element))?$/i;

/** The spoken label of the thing to click: "click on the pricing link" -> "pricing". */
export function clickTarget(text: string): string | null {
  const m = CLICK_VERB.exec(text);
  return m?.[1]?.trim() || null;
}

export function parseScrollDirection(text: string): "up" | "down" | "top" | "bottom" | null {
  if (/\b(?:top|beginning|start)\b/.test(text)) return "top";
  if (/\b(?:bottom|end)\b/.test(text)) return "bottom";
  if (/\b(?:up|upwards|back up)\b/.test(text)) return "up";
  if (/\b(?:down|downwards|further|more)\b/.test(text)) return "down";
  return null;
}

/** true = yes/confirm, false = no/cancel, null = neither. */
export function parseYesNo(text: string): boolean | null {
  const t = normalizeSpeech(text);
  if (/^(?:yes|yeah|yep|yup|sure|confirm|confirmed|do it|go ahead|go for it|proceed|correct|right|affirmative|ok|okay|absolutely|please do)\b/.test(t)) return true;
  if (/^(?:no|nope|nah|cancel|stop|don't|do not|never mind|nevermind|abort|negative|wait|hold on)\b/.test(t)) return false;
  return null;
}

/** "the second one" -> 1; null when no ordinal is present. */
export function parseOrdinal(text: string): number | null {
  const t = normalizeSpeech(text);
  const words: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, one: 0, two: 1, three: 2, four: 3, five: 4 };
  // bare number words only count after "number"/"option" ("that one" is not an ordinal)
  const m = /\b(first|second|third|fourth|fifth)\b|\b(?:number|option|choice)\s+(one|two|three|four|five|[1-5])\b|\b([1-5])\b/.exec(t);
  if (!m) return null;
  const w = m[1] ?? m[2] ?? m[3] ?? "";
  return /^[1-5]$/.test(w) ? Number(w) - 1 : (words[w] ?? null);
}

export interface ParsedCommand {
  raw: string;
  text: string;
  urls: string[];
  navTarget: string | null;
  siteGuess: string | null;
  searchQuery: string | null;
  typed: TypedText | null;
  clickLabel: string | null;
  scroll: "up" | "down" | "top" | "bottom" | null;
}

export function parseCommand(raw: string): ParsedCommand {
  const text = normalizeSpeech(raw);
  const urls = findUrlCandidates(text).map((span) => toUrl(withRawCase(span, raw)));
  const navTarget = navigationTarget(text);
  const siteGuess = navTarget && urls.length === 0 ? guessSiteUrl(navTarget) : null;
  return {
    raw,
    text,
    urls,
    navTarget,
    siteGuess,
    searchQuery: extractSearchQuery(text),
    typed: extractTypedText(text),
    clickLabel: clickTarget(text),
    scroll: parseScrollDirection(text),
  };
}

// ---------------------------------------------------------------------------
// Multi-step commands: "open wikipedia and search for cats"
// ---------------------------------------------------------------------------

/** Verb phrases that can begin a step. Arg-taking verbs must be followed by something. */
const STEP_START = new RegExp(
  "^(?:" +
    // no-argument commands
    "(?:go\\s+)?back(?:wards?)?|(?:go\\s+)?forwards?|reload|refresh|stop|cancel|scroll\\b|page (?:up|down)|submit|" +
    // navigation / click / type / search verbs, each needing an argument
    "(?:go to|goto|go on to|open(?: up)?|navigate to|visit|launch|take me to|show me|bring up|head (?:to|over to)|load|pull up|switch to" +
    "|click(?: on)?|press(?: on)?|tap(?: on)?|select|choose|hit|push|toggle|check|uncheck|follow|activate|expand|pick" +
    "|type|enter|write|input|fill(?: in| out)?|put|insert|paste|key in" +
    "|search(?: the (?:web|internet))?(?: for)?|google|look ?up|find(?: me)?)\\s+\\S" +
    ")",
  "i",
);

/** Connectives between steps: ", then", " and then", " then", " after that", " and", or a bare comma. */
const CONNECTIVE = /,\s*(?:and then|then|after that|and)?\s*|\s+(?:and then|then|after that|and)\s+/g;

const TYPING_VERB = /^(?:type|enter|write|input|fill(?: in| out)?|put|insert|paste|key in)\b/;
const SEARCH_VERB_START = /^(?:search|google|look ?up|find)\b/;
/** A segment that is only "press enter" / "submit" / "search": belongs to the typing step before it. */
const TAIL_ONLY = /^(?:(?:hit|press|push)\s+(?:enter|return|go|search)|submit(?: it)?|search(?: it)?)$/;

/** Stands in for spaces inside quoted spans while splitting (U+E000, private use). */
const MASK = "";

/** Split one utterance into sequential single-step commands. Splits only where the right-hand
 *  side starts with a known verb, so "search for cats and dogs" stays whole; quoted spans are
 *  never split. A trailing "press enter" is folded back into the typing command before it so
 *  extractTypedText's SUBMIT_TAIL keeps working. */
export function splitSteps(raw: string, max = 4): string[] {
  const text = normalizeSpeech(raw);
  if (!text) return [];
  // protect quoted spans: swap their spaces for a placeholder that no regex above matches
  const masked = text.replace(/(["'“‘])(.+?)(["'”’])/g, (_m, open: string, inner: string, close: string) => open + inner.replace(/\s/g, MASK) + close);

  const segments: string[] = [];
  let start = 0;
  for (const m of masked.matchAll(CONNECTIVE)) {
    const idx = m.index ?? 0;
    if (idx <= start) continue;
    const right = masked.slice(idx + m[0].length);
    if (!STEP_START.test(right)) continue;
    segments.push(masked.slice(start, idx));
    start = idx + m[0].length;
  }
  segments.push(masked.slice(start));

  const out: string[] = [];
  for (const seg of segments.map((s) => s.trim()).filter(Boolean)) {
    const prev = out[out.length - 1];
    if (prev && TAIL_ONLY.test(seg)) {
      if (TYPING_VERB.test(prev)) {
        out[out.length - 1] = `${prev} and ${seg}`;
        continue;
      }
      if (SEARCH_VERB_START.test(prev)) continue; // searching already submits
    }
    out.push(seg);
  }
  if (out.length > max) out.splice(max - 1, out.length, out.slice(max - 1).join(" and "));
  // each step is decided from its own (lowercased) text, so put the URLs' case back here
  return out.map((s) => s.replaceAll(MASK, " ").replace(URL_RE, (span) => withRawCase(span, raw)));
}
