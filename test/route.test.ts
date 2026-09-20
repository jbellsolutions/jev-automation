import { describe, expect, it } from "vitest";
import { approvalChoice } from "../core/brain.js";
import { parseCommand } from "../core/commands.js";
import { THRESHOLDS, decideHeuristically, interpretAnswers } from "../core/decide.js";
import type { PageSnapshot } from "../core/elements.js";
import { ROUTES, appRequest, fileRequest, reconcileRoute, routeHeuristically } from "../core/route.js";
import { el } from "./helpers/fake-executor.js";

const page: PageSnapshot = { url: "https://example.test/", title: "Example", elements: [el("e0", { text: "Pricing", hrefShort: "/pricing" })] };
const decide = (text: string) => decideHeuristically(parseCommand(text), page);

describe("route: keyword mirror", () => {
  it.each([
    ["click the pricing link", "browser_now"],
    ["open wikipedia and search for cats", "browser_now"],
    ["scroll down", "browser_now"],
    ["search for cheap flights to lisbon", "browser_now"],
    ["open slack", "computer"],
    ["switch to finder", "computer"],
    ["open my resume", "computer"],
    ["open the q3 budget spreadsheet", "computer"],
    ["open my calendar", "hermes"],
    ["open spotify", "browser_now"], // a site alias, not the app
    ["find me 20 dentists in austin and put them in a sheet", "hermes"],
    ["what's on my calendar today", "hermes"],
    ["what did I ask you yesterday on telegram", "hermes"],
    ["remind me to call mom at five", "hermes"],
    ["yo can you hear me", "hermes"],
    ["hey what's up", "hermes"],
    ["can you check my email", "hermes"],
    ["open slack and leave a note for xander in the content channel", "hermes"],
    ["google the weather in paris", "browser_now"],
    ["stop", "stop"],
    ["never mind", "stop"],
  ])("%s → %s", (text, route) => {
    expect(decide(text).route).toBe(route);
  });

  it("gives the computer lane an open_app or open_path action and the stop lane a stop", () => {
    const d = decide("open slack");
    expect(d.action).toEqual({ kind: "open_app", app: "slack" });
    expect(d.intent).toBe("open_app");
    const f = decide("open my resume");
    expect(f.action).toEqual({ kind: "open_path", query: "resume" });
    expect(f.intent).toBe("open_path");
    expect(decide("cancel that").action).toEqual({ kind: "stop" });
  });

  it("fileRequest names the file, never an app, a site or a thing that is not a file", () => {
    expect(fileRequest("open my resume")).toBe("resume");
    expect(fileRequest("Open the Q3 budget spreadsheet.")).toBe("q3 budget");
    expect(fileRequest("pull up our pitch deck")).toBe("pitch");
    expect(fileRequest("show me the invoice pdf")).toBe("invoice");
    expect(fileRequest("open my calendar")).toBeNull();
    expect(fileRequest("open my email")).toBeNull();
    expect(fileRequest("open the slack")).toBeNull();
    expect(fileRequest("open slack")).toBeNull();
    expect(fileRequest("open youtube")).toBeNull();
    expect(fileRequest("open resume")).toBeNull(); // no "my"/"the": too easily a site or an app
  });

  it("keeps the browser action alongside a hermes route so brain-less hosts still act", () => {
    const d = decide("what is the capital of france");
    expect(d.route).toBe("hermes");
    expect(d.action.kind).toBe("none");
    const s = decide("find me 20 dentists in austin");
    expect(s.route).toBe("hermes");
    expect(s.action.kind).toBe("search");
  });

  it("appRequest only matches known Mac apps that are not also sites", () => {
    expect(appRequest("open slack")).toBe("slack");
    expect(appRequest("launch the vs code app")).toBe("vs code");
    expect(appRequest("open youtube")).toBeNull();
    expect(appRequest("open my resume")).toBeNull();
  });

  it("routeHeuristically prefers a page verb over the length rule", () => {
    expect(routeHeuristically("type hello world in the search box and press enter", true).route).toBe("browser_now");
    expect(routeHeuristically("um so anyway", false).route).toBe("hermes"); // unknown speech goes to the brain, which can ask back
    expect(routeHeuristically("", false).route).toBe("unclear");
  });
});

describe("route: Jev answers", () => {
  const answers = (route: string, routeConf: number, intent: string, intentConf: number) => ({
    route: { type: "choice" as const, choice: route, confidence: routeConf, probabilities: { [route]: routeConf } },
    intent: { type: "choice" as const, choice: intent, confidence: intentConf, probabilities: { [intent]: intentConf } },
    target: { type: "choice" as const, choice: "e0", confidence: 0.9, probabilities: { e0: 0.9 } },
    risky: { type: "noul" as const, noul: 0.1 },
  });
  const interpret = (text: string, a: ReturnType<typeof answers>) => interpretAnswers(a as never, parseCommand(text), page);

  it("takes a confident route answer", () => {
    expect(interpret("what's on my calendar", answers("hermes", 0.9, "unclear", 0.5))).toMatchObject({ route: "hermes", routeConfidence: 0.9 });
    expect(interpret("click pricing", answers("browser_now", 0.8, "click", 0.9))).toMatchObject({ route: "browser_now", action: { kind: "click", elementId: "e0" } });
  });

  it("the brain is the default: an unsure route goes to it even with a confident page verb", () => {
    expect(THRESHOLDS.route).toBe(0.4);
    expect(THRESHOLDS.fastLane).toBe(0.6);
    expect(interpret("click pricing", answers("hermes", 0.3, "click", 0.9)).route).toBe("hermes");
    expect(interpret("click pricing", answers("browser_now", 0.5, "click", 0.9)).route).toBe("hermes");
    expect(interpret("click pricing", answers("browser_now", 0.6, "click", 0.9)).route).toBe("browser_now");
    expect(interpret("tell me about pricing", answers("hermes", 0.3, "click", 0.4)).route).toBe("hermes");
  });

  it("the fast lanes need the confident browser intent too, the computer lane its own threshold", () => {
    expect(interpret("click pricing", answers("browser_now", 0.9, "click", 0.5)).route).toBe("hermes");
    expect(interpret("open slack", answers("computer", 0.5, "open_url", 0.5)).route).toBe("hermes");
  });

  it("a browser route without a browser intent is not actionable: brain", () => {
    expect(interpret("hmm what now", answers("browser_now", 0.7, "unclear", 0.2)).route).toBe("hermes");
  });

  it("a computer route needs a recognisable app or file, else the brain takes it", () => {
    expect(interpret("open slack", answers("computer", 0.8, "open_url", 0.5))).toMatchObject({ route: "computer", action: { kind: "open_app", app: "slack" } });
    expect(interpret("open my tax return", answers("computer", 0.8, "unclear", 0.3))).toMatchObject({ route: "computer", action: { kind: "open_path", query: "tax return" } });
    expect(interpret("open my calendar", answers("computer", 0.8, "unclear", 0.3)).route).toBe("hermes");
    expect(interpret("get the thing ready", answers("computer", 0.8, "unclear", 0.3)).route).toBe("hermes");
  });

  it("stop and unclear override the browser intent", () => {
    expect(interpret("stop", answers("stop", 0.9, "click", 0.5))).toMatchObject({ route: "stop", action: { kind: "stop" } });
    expect(interpret("yeah I'll call you back", answers("unclear", 0.9, "click", 0.5))).toMatchObject({ route: "unclear", intent: "unclear", action: { kind: "none" } });
  });

  it("reconcileRoute ignores unknown choices", () => {
    expect(reconcileRoute({ choice: "bogus", confidence: 0.9 }, true, true).route).toBe("hermes");
    expect(reconcileRoute({ choice: "browser_now", confidence: 0.9 }, true, true).route).toBe("browser_now");
    expect(reconcileRoute(null, false, false).route).toBe("hermes");
    expect(Object.keys(ROUTES)).toEqual(["browser_now", "computer", "hermes", "stop", "unclear"]);
  });
});

describe("approvalChoice", () => {
  it("maps yes/no onto what the request offers", () => {
    expect(approvalChoice("confirm", "yes", ["once", "session", "always", "deny"])).toBe("once");
    expect(approvalChoice("confirm", "yes always allow that", ["once", "session", "always", "deny"])).toBe("always");
    expect(approvalChoice("confirm", "yes always", ["once", "deny"])).toBe("once");
    expect(approvalChoice("confirm", "sure for this session", ["once", "session", "deny"])).toBe("session");
    expect(approvalChoice("cancel", "no", ["once", "deny"])).toBe("deny");
  });
});
