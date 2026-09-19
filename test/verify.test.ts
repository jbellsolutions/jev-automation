import { TypeSafeClient } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import type { Action } from "../core/actions.js";
import { HeuristicDecider, JevDecider } from "../core/decide.js";
import type { PageSnapshot } from "../core/elements.js";
import { VERIFY_THRESHOLDS, buildVerifyQuestions, buildVerifyState, defaultExpectation, describeVerify, elementKey, heuristicVerdict, interpretVerifyAnswers, quickVerdict } from "../core/verify.js";
import { el } from "./helpers/fake-executor.js";

const page = (url: string, elements: PageSnapshot["elements"] = [], title = "T"): PageSnapshot => ({ url, title, elements });
const click: Action = { kind: "click", elementId: "e0", label: 'button "Next"' };

describe("buildVerifyState", () => {
  it("diffs elements by identity, not by id or position, and caps the lists", () => {
    const before = page("https://a.test/", [el("e0", { text: "Home" }), el("e1", { text: "Login" })]);
    const after = page("https://a.test/", [el("e5", { text: "Login" }), el("e6", { tag: "button", text: "Close" }), ...Array.from({ length: 12 }, (_, i) => el(`n${i}`, { text: `New ${i}` }))]);
    const s = buildVerifyState({ command: "click home", expectation: null, action: click, before, after, error: null });
    expect(s.url_changed).toBe(false);
    expect(s.gone_elements).toEqual(['link "Home"']);
    expect(s.new_elements).toHaveLength(8);
    expect(s.new_elements[0]).toBe('button "Close"');
    expect(s.expectation).toBe(defaultExpectation(click));
    expect(s.action_taken).toBe('Click button "Next"');
  });

  it("elementKey ignores id and viewport", () => {
    expect(elementKey(el("e1", { text: "X", inViewport: false }))).toBe(elementKey(el("e9", { text: "X", inViewport: true })));
  });
});

describe("quickVerdict", () => {
  const s = (over: Partial<ReturnType<typeof buildVerifyState>>) => ({ ...buildVerifyState({ command: "c", expectation: null, action: click, before: page("https://a.test/"), after: page("https://a.test/"), error: null }), ...over });

  it("an executor error is stuck", () => {
    expect(quickVerdict(s({ error: "boom" }), click)).toMatchObject({ done: false, stuck: true, source: "code" });
  });
  it("navigate/search are done when the host matches, otherwise undecided", () => {
    const nav: Action = { kind: "navigate", url: "https://www.wikipedia.org" };
    expect(quickVerdict(s({ after: { url: "https://en.wikipedia.org/wiki/Main", title: "" } }), nav)).toBeNull();
    expect(quickVerdict(s({ after: { url: "https://wikipedia.org/", title: "" } }), nav)).toMatchObject({ done: true });
    expect(quickVerdict(s({ after: { url: "https://accounts.google.com/", title: "" } }), nav)).toBeNull();
  });
  it("back/forward need a URL change", () => {
    expect(quickVerdict(s({ url_changed: true }), { kind: "back" })).toMatchObject({ done: true });
    expect(quickVerdict(s({ url_changed: false }), { kind: "back" })).toMatchObject({ stuck: true, blocker: "no_change" });
  });
  it("scroll, reload and plain typing are done; click, press and submit-typing ask Jev", () => {
    expect(quickVerdict(s({}), { kind: "scroll", direction: "down" })?.done).toBe(true);
    expect(quickVerdict(s({}), { kind: "type", elementId: null, label: null, text: "x", submit: false })?.done).toBe(true);
    expect(quickVerdict(s({}), { kind: "type", elementId: null, label: null, text: "x", submit: true })).toBeNull();
    expect(quickVerdict(s({}), click)).toBeNull();
    expect(quickVerdict(s({}), { kind: "press", key: "Enter" })).toBeNull();
  });
});

describe("Jev verification", () => {
  it("interprets answers with the thresholds", () => {
    const v = interpretVerifyAnswers({
      step_done: { type: "noul", noul: 0.7 },
      stuck: { type: "noul", noul: 0.2 },
      blocker: { type: "choice", choice: "login_wall", confidence: 0.9, probabilities: { login_wall: 0.9 } },
    } as never);
    expect(v).toMatchObject({ done: true, stuck: false, blocker: "none", source: "jev" }); // blocker only counts when stuck
    const w = interpretVerifyAnswers({ step_done: { type: "noul", noul: 0.1 }, stuck: { type: "noul", noul: 0.8 }, blocker: { type: "choice", choice: "captcha", confidence: 0.8, probabilities: {} } } as never);
    expect(w).toMatchObject({ done: false, stuck: true, blocker: "captcha" });
    expect(describeVerify(w)).toBe("stuck: captcha");
    expect(VERIFY_THRESHOLDS.done).toBe(0.6);
  });

  it("asks exactly three questions with a compact state", () => {
    const q = buildVerifyQuestions(buildVerifyState({ command: "click next", expectation: "page 2 is shown", action: click, before: page("https://a.test/"), after: page("https://a.test/"), error: null }));
    expect(Object.keys(q)).toEqual(["step_done", "stuck", "blocker"]);
  });

  it("JevDecider sends the state and falls back to heuristics on failure", async () => {
    const capture: { body?: { state: Record<string, unknown>; questions: Record<string, unknown> } } = {};
    const good = new TypeSafeClient({
      apiKey: "k",
      retry: { maxRetries: 0 },
      fetch: async (_u, init) => {
        capture.body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { step_done: { type: "noul", noul: 0.9 }, stuck: { type: "noul", noul: 0.1 }, blocker: { type: "choice", choice: "none", confidence: 1, probabilities: {} } }, usage: { input_tokens: 99, output_tokens: 3 } }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const input = { command: "click next", expectation: null, action: click, before: page("https://a.test/", [el("e0", { tag: "button", text: "Next" })]), after: page("https://a.test/", [el("e0", { tag: "button", text: "Next" }), el("e1", { text: "Page 2" })]), error: null };
    const v = await new JevDecider(good).verify(input);
    expect(v).toMatchObject({ done: true, stuck: false, source: "jev", meta: { inputTokens: 99 } });
    expect(capture.body?.state).toMatchObject({ command: "click next", url_changed: false, new_elements: ['link "Page 2"'] });
    expect(Object.keys(capture.body?.questions ?? {})).toEqual(["step_done", "stuck", "blocker"]);

    const bad = new TypeSafeClient({ apiKey: "k", retry: { maxRetries: 0 }, fetch: async () => new Response("nope", { status: 500 }) });
    const f = await new JevDecider(bad).verify(input);
    expect(f.source).toBe("heuristic");
    expect(f.done).toBe(true);
    expect(f.meta.fallbackReason).toBeTruthy();
  });

  it("quick verdicts never call Jev", async () => {
    let calls = 0;
    const client = new TypeSafeClient({ apiKey: "k", fetch: async () => { calls++; return new Response("{}", { status: 500 }); } });
    const v = await new JevDecider(client).verify({ command: "scroll down", expectation: null, action: { kind: "scroll", direction: "down" }, before: page("https://a.test/"), after: page("https://a.test/"), error: null });
    expect(v.source).toBe("code");
    expect(calls).toBe(0);
  });

  it("HeuristicDecider verifies from the diff", async () => {
    const d = new HeuristicDecider();
    const same = await d.verify({ command: "click next", expectation: null, action: click, before: page("https://a.test/"), after: page("https://a.test/"), error: null });
    expect(same).toMatchObject({ stuck: true, blocker: "no_change" });
    expect(heuristicVerdict(buildVerifyState({ command: "c", expectation: null, action: click, before: page("https://a.test/"), after: page("https://a.test/", [], "Other"), error: null })).done).toBe(true);
  });
});
