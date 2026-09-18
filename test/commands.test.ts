import { describe, expect, it } from "vitest";
import {
  clickTarget,
  extractSearchQuery,
  extractTypedText,
  findUrlCandidates,
  guessSiteUrl,
  navigationTarget,
  normalizeSpeech,
  parseCommand,
  parseOrdinal,
  parseYesNo,
} from "../server/commands.js";

describe("normalizeSpeech", () => {
  it("strips filler and punctuation and lower-cases", () => {
    expect(normalizeSpeech("Hey, please open Google.")).toBe("open google");
    expect(normalizeSpeech("Can you scroll down please?")).toBe("scroll down");
  });
  it("turns spoken URL parts into text", () => {
    expect(normalizeSpeech("open google dot com")).toBe("open google.com");
    expect(normalizeSpeech("go to www dot wikipedia dot org slash wiki")).toBe("go to www.wikipedia.org/wiki");
    expect(normalizeSpeech("type john at example dot com in the email field")).toBe("type john@example.com in the email field");
  });
  it("leaves ordinary 'dot' alone", () => {
    expect(normalizeSpeech("click the dot")).toBe("click the dot");
  });
});

describe("findUrlCandidates", () => {
  it("finds bare domains, paths, ports and full urls", () => {
    expect(findUrlCandidates("open news.ycombinator.com/newest")).toEqual(["news.ycombinator.com/newest"]);
    expect(findUrlCandidates("go to https://typesafe.ai/blog now")).toEqual(["https://typesafe.ai/blog"]);
    expect(findUrlCandidates("open localhost:3000/demo")).toEqual(["localhost:3000/demo"]);
  });
  it("ignores email addresses and abbreviations", () => {
    expect(findUrlCandidates("type john@example.com")).toEqual([]);
    expect(findUrlCandidates("click e.g. this")).toEqual([]);
  });
});

describe("navigation", () => {
  it("extracts the target after a navigation verb", () => {
    expect(navigationTarget("open the youtube website")).toBe("youtube");
    expect(navigationTarget("take me to hacker news")).toBe("hacker news");
    expect(navigationTarget("click the login button")).toBeNull();
  });
  it("guesses URLs conservatively", () => {
    expect(guessSiteUrl("youtube")).toBe("https://www.youtube.com");
    expect(guessSiteUrl("hacker news")).toBe("https://news.ycombinator.com");
    expect(guessSiteUrl("example")).toBe("https://example.com");
    expect(guessSiteUrl("cheap flights to lisbon")).toBeNull();
  });
});

describe("extractTypedText", () => {
  it("separates text from the field description and submit tail", () => {
    expect(extractTypedText("type hello world in the search box and press enter")).toEqual({ text: "hello world", targetHint: "search box", submit: true });
    expect(extractTypedText("enter ada lovelace into the name field")).toEqual({ text: "ada lovelace", targetHint: "name field", submit: false });
    expect(extractTypedText('write "see you soon"')).toEqual({ text: "see you soon", targetHint: null, submit: false });
  });
  it("treats 'search for' as typing when interpreted on-page", () => {
    expect(extractTypedText("search for cats")).toEqual({ text: "cats", targetHint: null, submit: false });
  });
  it("returns null for non-typing commands", () => {
    expect(extractTypedText("scroll down")).toBeNull();
  });
});

describe("extractSearchQuery / clickTarget", () => {
  it("extracts search queries", () => {
    expect(extractSearchQuery("search for cheap flights to lisbon on google")).toBe("cheap flights to lisbon");
    expect(extractSearchQuery("google the weather in paris")).toBe("the weather in paris");
    expect(extractSearchQuery("open pricing")).toBeNull();
  });
  it("extracts the spoken click label", () => {
    expect(clickTarget("click on the pricing link")).toBe("pricing");
    expect(clickTarget("press sign in")).toBe("sign in");
    expect(clickTarget("scroll down")).toBeNull();
  });
});

describe("replies", () => {
  it("parses yes/no", () => {
    expect(parseYesNo("Yes, go ahead")).toBe(true);
    expect(parseYesNo("nope")).toBe(false);
    expect(parseYesNo("open google")).toBeNull();
  });
  it("parses ordinals", () => {
    expect(parseOrdinal("the second one")).toBe(1);
    expect(parseOrdinal("number 3")).toBe(2);
    expect(parseOrdinal("that one")).toBeNull();
  });
});

describe("parseCommand", () => {
  it("bundles every pre-parsed candidate", () => {
    const p = parseCommand("Open google dot com");
    expect(p.text).toBe("open google.com");
    expect(p.urls).toEqual(["https://google.com"]);
    expect(p.navTarget).toBe("google.com");
    expect(p.siteGuess).toBeNull();
  });
  it("guesses a site only when no URL was spoken", () => {
    expect(parseCommand("go to reddit").siteGuess).toBe("https://www.reddit.com");
  });
});
