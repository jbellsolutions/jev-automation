import { describe, expect, it } from "vitest";
import type { DecisionSummary } from "../../core/protocol.ts";
import { type Event, type State, initialState, reducer } from "./state.ts";

const run = (events: Event[], from: State = initialState) => events.reduce(reducer, from);

const decision: DecisionSummary = {
  command: "click on pricing", intent: "click", intentConfidence: 0.9, action: { kind: "click", elementId: "e2", label: 'link "Pricing"' },
  actionLabel: 'Click link "Pricing"', source: "jev", model: "jev-1.13.0", latencyMs: 120, inputTokens: 300,
};

describe("reducer", () => {
  it("tracks connection and hello", () => {
    const s = run([{ type: "socket", connected: true }, { type: "hello", jev: { enabled: true, model: "jev-latest" }, viewport: { width: 1000, height: 600 }, stt: { provider: "deepgram" } }]);
    expect(s.connected).toBe(true);
    expect(s.jev?.model).toBe("jev-latest");
    expect(s.stt).toBe("deepgram");
    expect(reducer(s, { type: "speaking", active: true }).speaking).toBe(true);
    expect(s.viewport).toEqual({ width: 1000, height: 600 });
  });

  it("builds a log entry from transcript → decision → outcome", () => {
    const s = run([
      { type: "transcript_ack", text: "click on pricing", stepId: 1 },
      { type: "decision", decision },
      { type: "status", text: "Clicking…", level: "busy" },
      { type: "status", text: 'Clicked link "Pricing"', level: "ok" },
    ]);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]).toMatchObject({ said: "click on pricing", decision, result: { text: 'Clicked link "Pricing"', level: "ok" } });
    expect(s.status.level).toBe("ok");
  });

  it("does not overwrite an entry's outcome with later statuses", () => {
    const s = run([
      { type: "transcript_ack", text: "go back", stepId: 2 },
      { type: "status", text: "Went back", level: "ok" },
      { type: "status", text: "Something else", level: "warn" },
    ]);
    expect(s.entries[0]?.result?.text).toBe("Went back");
  });

  it("opens a confirmation and closes it on the next outcome", () => {
    let s = run([{ type: "transcript_ack", text: "click delete", stepId: 3 }, { type: "confirm", actionLabel: "Click Delete", reason: "risky" }]);
    expect(s.pending).toMatchObject({ kind: "confirm", actionLabel: "Click Delete" });
    s = reducer(s, { type: "status", text: "Cancelled: Click Delete", level: "warn" });
    expect(s.pending).toBeNull();
  });

  it("opens a clarification and drops it when a new command arrives", () => {
    const options = [{ elementId: "e1", label: "a", probability: 0.5 }];
    let s = run([{ type: "transcript_ack", text: "click choose", stepId: 4 }, { type: "clarify", question: "Which one?", options }]);
    expect(s.pending).toMatchObject({ kind: "clarify", options });
    s = reducer(s, { type: "transcript_ack", text: "the second one", stepId: 5 });
    expect(s.pending).toBeNull();
    expect(s.entries).toHaveLength(2);
  });

  it("caps the log and clears it", () => {
    let s = initialState;
    for (let i = 0; i < 50; i++) s = reducer(s, { type: "transcript_ack", text: `cmd ${i}`, stepId: i + 1 });
    expect(s.entries).toHaveLength(40);
    expect(s.entries[0]?.said).toBe("cmd 49");
    expect(reducer(s, { type: "clear_log" }).entries).toEqual([]);
  });
});

describe("multi-step utterances", () => {
  it("makes one entry per step, each carrying its step info, and applies outcomes to the latest", () => {
    let s = initialState;
    const original = "open a.com and open b.com";
    s = reducer(s, { type: "steps", original, commands: ["open a.com", "open b.com"] });
    s = reducer(s, { type: "transcript_ack", text: "open a.com", stepId: 7, step: { index: 0, total: 2, original } });
    s = reducer(s, { type: "status", text: "Opened https://a.com", level: "ok" });
    s = reducer(s, { type: "transcript_ack", text: "open b.com", stepId: 8, step: { index: 1, total: 2, original } });
    s = reducer(s, { type: "status", text: "Opened https://b.com", level: "ok" });
    expect(s.entries.map((e) => e.said)).toEqual(["open b.com", "open a.com"]);
    expect(s.entries[0]!.step).toEqual({ index: 1, total: 2, original });
    expect(s.entries[0]!.result?.text).toBe("Opened https://b.com");
    expect(s.entries[1]!.result?.text).toBe("Opened https://a.com");
  });

  it("attaches a late verify to the step it belongs to, not the newest entry with that text", () => {
    let s = initialState;
    const verify = { done: false, stuck: true, doneProbability: 0, blocker: "no_change", source: "heuristic", latencyMs: 0, text: "stuck: no change" } as const;
    s = reducer(s, { type: "transcript_ack", text: "scroll down", stepId: 1 });
    s = reducer(s, { type: "transcript_ack", text: "scroll down", stepId: 2 });
    s = reducer(s, { type: "verify", stepId: 1, command: "scroll down", verify });
    expect(s.entries[1]!.verify).toEqual(verify);
    expect(s.entries[0]!.verify).toBeUndefined();
  });
});
