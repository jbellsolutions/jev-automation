import { TypeSafeClient } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { parseCommand } from "../core/commands.js";
import { HeuristicDecider, JevDecider, THRESHOLDS, buildQuestions, decideHeuristically, interpretAnswers } from "../core/decide.js";
import type { PageElement, PageSnapshot } from "../core/elements.js";

const el = (id: string, over: Partial<PageElement>): PageElement => ({
  id, tag: "a", role: "", type: "", text: "", label: "", placeholder: "", name: "", hrefShort: null, inViewport: true, ...over,
});

const snapshot: PageSnapshot = {
  url: "http://localhost:3000/demo",
  title: "Demo · Home",
  elements: [
    el("e0", { text: "Home", hrefShort: "/demo?page=home" }),
    el("e1", { text: "Documentation", hrefShort: "/demo?page=docs" }),
    el("e2", { text: "Pricing", hrefShort: "/demo?page=pricing" }),
    el("e3", { tag: "input", type: "search", placeholder: "Search the demo site", label: "Search", name: "q" }),
    el("e4", { tag: "button", type: "submit", text: "Search" }),
    el("e5", { tag: "button", text: "Delete account" }),
  ],
};

function choiceAnswer(choice: string, confidence: number, probabilities?: Record<string, number>) {
  return { type: "choice" as const, choice, confidence, probabilities: probabilities ?? { [choice]: 1 } };
}
const noulAnswer = (noul: number) => ({ type: "noul" as const, noul });

describe("buildQuestions", () => {
  it("fans out every question in one request and lists page elements as options", () => {
    const q = buildQuestions(parseCommand("click on pricing"), snapshot);
    expect(Object.keys(q).sort()).toEqual(["intent", "risky", "scroll_direction", "submit_after_typing", "target"]);
    const target = q.target!;
    expect(target.type).toBe("choice");
    if (target.type === "choice") {
      expect(Object.keys(target.criteria)).toEqual(["e0", "e1", "e2", "e3", "e4", "e5", "none"]);
      expect(target.criteria.e2).toBe('link "Pricing" → /demo?page=pricing');
    }
  });
  it("adds a url_pick question only when several URLs were spoken", () => {
    expect(buildQuestions(parseCommand("open a.com"), snapshot).url_pick).toBeUndefined();
    const q = buildQuestions(parseCommand("open a.com or b.org"), snapshot);
    expect(q.url_pick?.type).toBe("choice");
  });
  it("omits the target question on a page with no elements", () => {
    expect(buildQuestions(parseCommand("scroll down"), { ...snapshot, elements: [] }).target).toBeUndefined();
  });
});

describe("interpretAnswers", () => {
  it("clicks the element Jev picked when confident", () => {
    const d = interpretAnswers(
      { intent: choiceAnswer("click", 0.9), target: choiceAnswer("e2", 0.85, { e2: 0.85, e1: 0.1, none: 0.05 }), risky: noulAnswer(0.02) },
      parseCommand("click on pricing"),
      snapshot,
    );
    expect(d.action).toEqual({ kind: "click", elementId: "e2", label: 'link "Pricing" → /demo?page=pricing' });
    expect(d.needsConfirmation).toBe(false);
    expect(d.alternatives[0]?.elementId).toBe("e2");
  });
  it("asks for clarification when the target pick is not confident", () => {
    const d = interpretAnswers(
      { intent: choiceAnswer("click", 0.9), target: choiceAnswer("e1", THRESHOLDS.target - 0.05, { e1: 0.3, e0: 0.28, e2: 0.2, none: 0.22 }), risky: noulAnswer(0) },
      parseCommand("click the page link"),
      snapshot,
    );
    expect(d.action.kind).toBe("none");
    expect(d.clarify?.options.map((o) => o.elementId)).toEqual(["e1", "e0", "e2"]);
  });
  it("uses the spoken URL for open_url and never invents one", () => {
    const d = interpretAnswers({ intent: choiceAnswer("open_url", 0.95), risky: noulAnswer(0) }, parseCommand("open wikipedia dot org"), snapshot);
    expect(d.action).toEqual({ kind: "navigate", url: "https://wikipedia.org" });
  });
  it("falls back to a web search when open_url has nothing URL-like", () => {
    const d = interpretAnswers({ intent: choiceAnswer("open_url", 0.8), risky: noulAnswer(0) }, parseCommand("open the best pizza place near me"), snapshot);
    expect(d.action.kind).toBe("search");
    if (d.action.kind === "search") expect(d.action.query).toBe("best pizza place near me");
  });
  it("types pre-parsed text into the chosen field and submits when Jev says so", () => {
    const d = interpretAnswers(
      { intent: choiceAnswer("type_text", 0.9), target: choiceAnswer("e3", 0.9), submit_after_typing: noulAnswer(0.9), risky: noulAnswer(0.01) },
      parseCommand("search for cats here"),
      snapshot,
    );
    expect(d.action).toMatchObject({ kind: "type", elementId: "e3", text: "cats here", submit: true });
  });
  it("gates risky clicks behind a confirmation", () => {
    const d = interpretAnswers(
      { intent: choiceAnswer("click", 0.9), target: choiceAnswer("e5", 0.95), risky: noulAnswer(0.93) },
      parseCommand("click delete account"),
      snapshot,
    );
    expect(d.action.kind).toBe("click");
    expect(d.needsConfirmation).toBe(true);
    expect(d.riskProbability).toBeCloseTo(0.93);
  });
  it("never gates navigation, even when Jev calls it risky", () => {
    const d = interpretAnswers({ intent: choiceAnswer("open_url", 0.9), risky: noulAnswer(0.99) }, parseCommand("open example.com"), snapshot);
    expect(d.needsConfirmation).toBe(false);
  });
  it("prefers the spoken scroll direction over Jev's guess", () => {
    const d = interpretAnswers({ intent: choiceAnswer("scroll", 0.9), scroll_direction: choiceAnswer("down", 0.6) }, parseCommand("scroll to the top"), snapshot);
    expect(d.action).toEqual({ kind: "scroll", direction: "top" });
  });
  it("treats low-confidence intents as unclear", () => {
    const d = interpretAnswers({ intent: choiceAnswer("click", THRESHOLDS.intent - 0.01) }, parseCommand("um so anyway"), snapshot);
    expect(d.intent).toBe("unclear");
    expect(d.action.kind).toBe("none");
  });
});

describe("decideHeuristically", () => {
  const run = (t: string, s = snapshot) => decideHeuristically(parseCommand(t), s);
  it("handles navigation, history, scrolling", () => {
    expect(run("open github.com").action).toEqual({ kind: "navigate", url: "https://github.com" });
    expect(run("go to youtube").action).toEqual({ kind: "navigate", url: "https://www.youtube.com" });
    expect(run("go back").action).toEqual({ kind: "back" });
    expect(run("refresh the page").action).toEqual({ kind: "reload" });
    expect(run("scroll to the bottom").action).toEqual({ kind: "scroll", direction: "bottom" });
  });
  it("matches spoken labels to page elements", () => {
    expect(run("click on pricing").action).toMatchObject({ kind: "click", elementId: "e2" });
    expect(run("open the documentation page").action).toMatchObject({ kind: "click", elementId: "e1" });
  });
  it("types into a matching field and uses the page's search box for searches", () => {
    expect(run("type hello in the search box and press enter").action).toMatchObject({ kind: "type", elementId: "e3", text: "hello", submit: true });
    expect(run("search for cats").action).toMatchObject({ kind: "type", elementId: "e3", text: "cats", submit: true });
    expect(run("search the web for cats").action).toMatchObject({ kind: "search", query: "cats" });
  });
  it("flags destructive words and reports unknown targets", () => {
    const risky = run("click delete account");
    expect(risky.action.kind).toBe("click");
    expect(risky.needsConfirmation).toBe(true);
    expect(run("click on the unicorn").action.kind).toBe("none");
    expect(run("what's the weather like").intent).toBe("unclear");
  });
});

describe("JevDecider", () => {
  function fakeClient(answers: Record<string, unknown>, capture: { body?: unknown; headers?: Headers }) {
    return new TypeSafeClient({
      apiKey: "test-key",
      retry: { maxRetries: 0 },
      fetch: async (_url, init) => {
        capture.body = JSON.parse(String(init?.body));
        capture.headers = new Headers(init?.headers);
        return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 321, output_tokens: 7 } }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
  }

  it("sends the documented request shape and reads typed answers back", async () => {
    const capture: { body?: any; headers?: Headers } = {};
    const decider = new JevDecider(fakeClient({ intent: choiceAnswer("click", 0.92), target: choiceAnswer("e2", 0.88, { e2: 0.88, e1: 0.1, none: 0.02 }), risky: noulAnswer(0.01) }, capture));
    const d = await decider.decide("click on pricing", snapshot);

    expect(capture.headers?.get("authorization")).toBe("Bearer test-key");
    expect(capture.body.model).toBe("jev-latest");
    expect(capture.body.state).toEqual({ command: "click on pricing", page: { url: snapshot.url, title: snapshot.title } });
    expect(capture.body.questions.intent.type).toBe("choice");
    expect(capture.body.questions.target.criteria.none).toBeDefined();
    expect(capture.body.questions.risky.type).toBe("noul");

    expect(d.source).toBe("jev");
    expect(d.action).toMatchObject({ kind: "click", elementId: "e2" });
    expect(d.meta).toMatchObject({ model: "jev-1.13.0", inputTokens: 321 });
  });

  it("falls back to heuristics when the API fails", async () => {
    const client = new TypeSafeClient({ apiKey: "k", retry: { maxRetries: 0 }, fetch: async () => new Response("{}", { status: 500 }) });
    const d = await new JevDecider(client).decide("open github.com", snapshot);
    expect(d.source).toBe("heuristic");
    expect(d.action).toEqual({ kind: "navigate", url: "https://github.com" });
    expect(d.meta.fallbackReason).toBeTruthy();
  });

  it("classifies confirmation replies with regex first, Jev second", async () => {
    const capture: { body?: any } = {};
    const decider = new JevDecider(fakeClient({ reply: choiceAnswer("confirm", 0.9) }, capture));
    expect(await decider.classifyReply("yes please", "Click Delete")).toBe("confirm");
    expect(capture.body).toBeUndefined();
    expect(await decider.classifyReply("go on then, I'm sure", "Click Delete")).toBe("confirm");
    expect(capture.body.state).toEqual({ pending_action: "Click Delete", user_reply: "go on then, I'm sure" });
  });
});

describe("HeuristicDecider", () => {
  it("reports itself as disabled and answers yes/no", async () => {
    const h = new HeuristicDecider();
    expect(h.enabled).toBe(false);
    expect(await h.classifyReply("cancel")).toBe("cancel");
    expect(await h.classifyReply("open x.com")).toBe("other");
  });
});
