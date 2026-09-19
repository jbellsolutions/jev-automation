import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { HeuristicDecider } from "../core/decide.js";
import type { ServerMessage } from "../core/protocol.js";
import type { CommandResult } from "../core/results.js";
import { Session } from "../core/session.js";
import { type Speaker, speakableText, spokenSummary } from "../core/speak.js";
import { SaySpeaker } from "../server/speak/say.js";
import { FakeExecutor, el } from "./helpers/fake-executor.js";

const base = (over: Partial<CommandResult>): CommandResult => ({ ok: true, steps: [], page: { url: "https://a.com", title: "" }, pending: null, ...over });
const step = (text: string, level: "ok" | "warn" | "error" = "ok", stepId = 1) => ({ stepId, command: "c", decision: null, result: { text, level } });

describe("speakableText", () => {
  it("reads URLs as their host", () => {
    expect(speakableText("Opened https://www.wikipedia.org/wiki/Cat?x=1")).toBe("Opened wikipedia.org");
    expect(speakableText("Searched for \"cats\"")).toBe('Searched for "cats"');
  });
});

describe("spokenSummary", () => {
  it("speaks the outcome of a single step", () => {
    expect(spokenSummary(base({ steps: [step("Opened https://wikipedia.org")] }))).toBe("Opened wikipedia.org");
  });

  it("prefixes multi-step successes with Done and speaks the last outcome", () => {
    expect(spokenSummary(base({ steps: [step("Opened https://a.com"), step('Typed "cats" and pressed Enter', "ok", 2)] }))).toBe('Done. Typed "cats" and pressed Enter');
  });

  it("speaks failures and stuck checks plainly", () => {
    expect(spokenSummary(base({ ok: false, steps: [step("Opened https://a.com"), step("boom", "error", 2)], stoppedAt: 1 }))).toBe("boom");
    const stuck = { ...step("Clicked Next"), verify: { done: false, stuck: true, doneProbability: 0, blocker: "login_wall" as const, source: "jev" as const, latencyMs: 1, text: "stuck: login wall" } };
    expect(spokenSummary(base({ ok: false, steps: [stuck] }))).toBe("Clicked Next, but it looks stuck: stuck: login wall");
  });

  it("asks the pending question", () => {
    expect(spokenSummary(base({ ok: false, pending: { kind: "confirm", actionLabel: "Click Delete account", reason: 'This looks hard to undo. Say "yes" or "no".' } }))).toBe('Click Delete account? This looks hard to undo. Say "yes" or "no".');
    const options = [
      { elementId: "e1", label: "Pro plan", probability: 0.4 },
      { elementId: "e2", label: "Pro trial", probability: 0.3 },
      { elementId: "e3", label: "Pro docs", probability: 0.2 },
    ];
    expect(spokenSummary(base({ ok: false, pending: { kind: "clarify", question: "Which one did you mean?", options } }))).toBe("Which one did you mean? Pro plan, Pro trial, or Pro docs");
  });

  it("clips long text", () => {
    const long = spokenSummary(base({ steps: [step(`Typed "${"word ".repeat(60)}"`)] }));
    expect(long.length).toBeLessThanOrEqual(161);
    expect(long.endsWith("…")).toBe(true);
  });
});

class FakeSpeaker implements Speaker {
  spoken: string[] = [];
  stops = 0;
  resolve: (() => void) | null = null;
  speak(text: string) {
    this.spoken.push(text);
    return new Promise<void>((r) => (this.resolve = r));
  }
  stop() {
    this.stops++;
  }
}

describe("Session speech", () => {
  function make() {
    const executor = new FakeExecutor([el("e0", { tag: "button", text: "Delete account" })]);
    const speaker = new FakeSpeaker();
    const messages: ServerMessage[] = [];
    const session = new Session("fake", { executor, decider: new HeuristicDecider(), speaker });
    session.subscribe((m) => messages.push(m));
    return { session, speaker, messages };
  }

  it("speaks voice commands and brackets them with speaking messages; typed commands stay silent", async () => {
    const { session, speaker, messages } = make();
    await session.command("open a.com");
    expect(speaker.spoken).toEqual([]);
    await session.command("open b.com", { speak: true });
    expect(speaker.spoken).toEqual(["did navigate"]);
    expect(messages.at(-1)).toEqual({ type: "speaking", active: true });
    speaker.resolve!();
    await new Promise((r) => setTimeout(r, 0));
    expect(messages.at(-1)).toEqual({ type: "speaking", active: false });
  });

  it("waits for the outcome check before speaking, so a stuck click is reported aloud", async () => {
    const executor = new FakeExecutor([el("e0", { tag: "button", text: "Next" })]);
    executor.clickChangesPage = false;
    const speaker = new FakeSpeaker();
    const session = new Session("fake", { executor, decider: new HeuristicDecider(), speaker });
    const r = await session.command("click next", { speak: true });
    expect(r.steps[0]!.verify?.stuck).toBe(true);
    expect(speaker.spoken).toEqual(["did click, but it looks stuck: stuck: no change"]);
    // typed commands keep verifying in the background
    const r2 = await session.command("click next");
    expect(r2.steps[0]!.verify).toBeUndefined();
  });

  it("speaks the confirmation question and stops talking on cancel", async () => {
    const { session, speaker } = make();
    await session.command("click delete account", { speak: true });
    expect(speaker.spoken[0]).toMatch(/^Click button "Delete account"\? This looks hard to undo/);
    session.cancel();
    expect(speaker.stops).toBe(1);
  });
});

describe("SaySpeaker", () => {
  function fakeSpawn() {
    const calls: Array<{ cmd: string; args: string[]; child: FakeChild }> = [];
    class FakeChild extends EventEmitter {
      stdin = new PassThrough();
      exitCode: number | null = null;
      killed = false;
      input = "";
      constructor() {
        super();
        this.stdin.on("data", (d: Buffer) => (this.input += d.toString()));
      }
      kill() {
        this.killed = true;
        this.exitCode = 143;
        queueMicrotask(() => this.emit("exit", 143));
        return true;
      }
    }
    const spawn = ((cmd: string, args: string[]) => {
      const child = new FakeChild();
      calls.push({ cmd, args, child });
      return child;
    }) as never;
    return { calls, spawn };
  }

  it("pipes the text to say and resolves on exit", async () => {
    const { calls, spawn } = fakeSpawn();
    const s = new SaySpeaker({ voice: "Samantha", rate: 190, spawn });
    const p = s.speak("Opened wikipedia.org");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls[0]!.cmd).toBe("say");
    expect(calls[0]!.args).toEqual(["-v", "Samantha", "-r", "190"]);
    expect(calls[0]!.child.input).toBe("Opened wikipedia.org");
    calls[0]!.child.exitCode = 0;
    calls[0]!.child.emit("exit", 0);
    await p;
  });

  it("a new utterance interrupts the previous one; empty text is a no-op", async () => {
    const { calls, spawn } = fakeSpawn();
    const s = new SaySpeaker({ spawn });
    const first = s.speak("one");
    void s.speak("two");
    expect(calls[0]!.child.killed).toBe(true);
    await first;
    expect(calls).toHaveLength(2);
    await s.speak("   ");
    expect(calls).toHaveLength(2);
  });
});
