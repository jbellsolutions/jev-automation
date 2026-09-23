import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitSteps } from "../core/commands.js";

describe("splitSteps", () => {
  it("keeps each URL's case: the decider sees the step, not the original", () => {
    expect(splitSteps("open https://www.youtube.com/watch?v=dQw4w9WgXcQ and scroll down")).toEqual(["open https://www.youtube.com/watch?v=dQw4w9WgXcQ", "scroll down"]);
    expect(splitSteps("Open https://Example.com/Docs")).toEqual(["open https://Example.com/Docs"]);
  });
  it.each([
    ["open wikipedia and search for cats", ["open wikipedia", "search for cats"]],
    ["open wikipedia and then search for cats", ["open wikipedia", "search for cats"]],
    ["go to youtube, search for lofi, then click the first result", ["go to youtube", "search for lofi", "click the first result"]],
    ["open slack and click general", ["open slack", "click general"]],
    ["scroll down and click the second link", ["scroll down", "click the second link"]],
    ["click login and enter my password", ["click login", "enter my password"]],
    ["check the box and submit", ["check the box", "submit"]],
    ["go back and reload", ["go back", "reload"]],
  ])("splits %j", (input, expected) => {
    expect(splitSteps(input)).toEqual(expected);
  });

  it.each([
    "search for cats and dogs",
    "open barnes and noble",
    "type hello and goodbye in the search box",
    "open a.com or b.org",
    "go on then, i'm sure",
    "type hello, world",
    "click the up and down arrows",
  ])("keeps %j whole", (input) => {
    expect(splitSteps(input)).toEqual([input]);
  });

  it("folds a submit tail back into a typing command so SUBMIT_TAIL still applies", () => {
    expect(splitSteps("type hello in the search box and press enter")).toEqual(["type hello in the search box and press enter"]);
    expect(splitSteps("type hello and press enter and click login")).toEqual(["type hello and press enter", "click login"]);
    expect(splitSteps("enter my name john then hit return")).toEqual(["enter my name john and hit return"]);
  });

  it("drops a submit tail after a search command, which already submits", () => {
    expect(splitSteps("search for cats and press enter")).toEqual(["search for cats"]);
  });

  it("never splits inside quotes", () => {
    expect(splitSteps('type "go home and open the door" in the message box')).toEqual(['type "go home and open the door" in the message box']);
  });

  it("splits on 'and <verb>' inside dictated text when unquoted (documented limit)", () => {
    expect(splitSteps("type go home and open the door")).toEqual(["type go home", "open the door"]);
  });

  it("caps the number of steps, merging the rest into the last one", () => {
    expect(splitSteps("open a.com and open b.com and open c.com and open d.com and open e.com", 3)).toEqual(["open a.com", "open b.com", "open c.com and open d.com and open e.com"]);
  });

  it("normalizes like parseCommand does", () => {
    expect(splitSteps("Hey Jev, open Wikipedia and search for cats.")).toEqual(["open wikipedia", "search for cats"]);
  });

  it("returns a single empty-free segment for blank input", () => {
    expect(splitSteps("   ")).toEqual([]);
  });

  it("keeps every command literal used by the existing test suites as a single step", () => {
    const literals = new Set<string>();
    for (const f of ["test/commands.test.ts", "test/decide.test.ts"]) {
      const src = readFileSync(f, "utf8");
      // string literals passed to parseCommand / normalizeSpeech / decide helpers
      for (const m of src.matchAll(/(?:parseCommand|normalizeSpeech|extractTypedText|extractSearchQuery|navigationTarget|clickTarget|decide|heuristic)\(\s*"([^"]+)"/g)) literals.add(m[1]!);
    }
    expect(literals.size).toBeGreaterThan(5);
    const multi = [...literals].filter((l) => splitSteps(l).length !== 1);
    expect(multi).toEqual([]);
  });
});
