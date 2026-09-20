import { describe, expect, it } from "vitest";
import type { CommandResult } from "../core/results.js";
import { resultSummary } from "../core/summary.js";

const base = (over: Partial<CommandResult>): CommandResult => ({ ok: true, steps: [], page: { url: "https://a.com", title: "" }, pending: null, ...over });
const step = (text: string, level: "ok" | "warn" | "error" = "ok", stepId = 1) => ({ stepId, command: "c", decision: null, result: { text, level } });

describe("resultSummary", () => {
  it("reports the outcome of a single step, with URLs read as their host", () => {
    expect(resultSummary(base({ steps: [step("Opened https://wikipedia.org")] }))).toBe("Opened wikipedia.org");
  });

  it("prefixes multi-step successes with Done and reports the last outcome", () => {
    expect(resultSummary(base({ steps: [step("Opened https://a.com"), step('Typed "cats" and pressed Enter', "ok", 2)] }))).toBe('Done. Typed "cats" and pressed Enter');
  });

  it("reports failures and stuck checks plainly", () => {
    expect(resultSummary(base({ ok: false, steps: [step("Opened https://a.com"), step("boom", "error", 2)], stoppedAt: 1 }))).toBe("boom");
    const stuck = { ...step("Clicked Next"), verify: { done: false, stuck: true, doneProbability: 0, blocker: "login_wall" as const, source: "jev" as const, latencyMs: 1, text: "stuck: login wall" } };
    expect(resultSummary(base({ ok: false, steps: [stuck] }))).toBe("Clicked Next, but it looks stuck: stuck: login wall");
  });

  it("reports the pending question", () => {
    expect(resultSummary(base({ ok: false, pending: { kind: "confirm", actionLabel: "Click Delete account", reason: 'This looks hard to undo. Say "yes" or "no".' } }))).toBe('Click Delete account? This looks hard to undo. Say "yes" or "no".');
    const options = [
      { elementId: "e1", label: "Pro plan", probability: 0.4 },
      { elementId: "e2", label: "Pro trial", probability: 0.3 },
      { elementId: "e3", label: "Pro docs", probability: 0.2 },
    ];
    expect(resultSummary(base({ ok: false, pending: { kind: "clarify", question: "Which one did you mean?", options } }))).toBe("Which one did you mean? Pro plan, Pro trial, or Pro docs");
  });

  it("clips long text", () => {
    const long = resultSummary(base({ steps: [step(`Typed "${"word ".repeat(60)}"`)] }));
    expect(long.length).toBeLessThanOrEqual(161);
    expect(long.endsWith("…")).toBe(true);
  });
});
