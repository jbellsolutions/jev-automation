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
    const s = run([{ type: "socket", connected: true }, { type: "hello", jev: { enabled: true, model: "jev-latest" }, viewport: { width: 1000, height: 600 } }]);
    expect(s.connected).toBe(true);
    expect(s.jev?.model).toBe("jev-latest");
    expect(s.viewport).toEqual({ width: 1000, height: 600 });
  });

  it("builds a log entry from transcript → decision → outcome", () => {
    const s = run([
      { type: "transcript_ack", text: "click on pricing" },
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
      { type: "transcript_ack", text: "go back" },
      { type: "status", text: "Went back", level: "ok" },
      { type: "status", text: "Something else", level: "warn" },
    ]);
    expect(s.entries[0]?.result?.text).toBe("Went back");
  });

  it("opens a confirmation and closes it on the next outcome", () => {
    let s = run([{ type: "transcript_ack", text: "click delete" }, { type: "confirm", actionLabel: "Click Delete", reason: "risky" }]);
    expect(s.pending).toMatchObject({ kind: "confirm", actionLabel: "Click Delete" });
    s = reducer(s, { type: "status", text: "Cancelled: Click Delete", level: "warn" });
    expect(s.pending).toBeNull();
  });

  it("opens a clarification and drops it when a new command arrives", () => {
    const options = [{ elementId: "e1", label: "a", probability: 0.5 }];
    let s = run([{ type: "transcript_ack", text: "click choose" }, { type: "clarify", question: "Which one?", options }]);
    expect(s.pending).toMatchObject({ kind: "clarify", options });
    s = reducer(s, { type: "transcript_ack", text: "the second one" });
    expect(s.pending).toBeNull();
    expect(s.entries).toHaveLength(2);
  });

  it("caps the log and clears it", () => {
    let s = initialState;
    for (let i = 0; i < 50; i++) s = reducer(s, { type: "transcript_ack", text: `cmd ${i}` });
    expect(s.entries).toHaveLength(40);
    expect(s.entries[0]?.said).toBe("cmd 49");
    expect(reducer(s, { type: "clear_log" }).entries).toEqual([]);
  });
});
