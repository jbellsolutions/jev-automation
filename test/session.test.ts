import { describe, expect, it } from "vitest";
import { HeuristicDecider } from "../core/decide.js";
import type { PageElement } from "../core/elements.js";
import type { ServerMessage } from "../core/protocol.js";
import { Session } from "../core/session.js";
import { FakeBrain, tick } from "./helpers/fake-brain.js";
import { FakeExecutor, el } from "./helpers/fake-executor.js";

function make(elements: PageElement[] = []) {
  const executor = new FakeExecutor(elements);
  const messages: ServerMessage[] = [];
  const session = new Session("fake", { executor, decider: new HeuristicDecider() });
  session.subscribe((m) => messages.push(m));
  const types = () => messages.map((m) => m.type);
  return { executor, session, messages, types };
}

describe("Session: single commands", () => {
  it("decides, executes and reports one step", async () => {
    const { session, executor, messages, types } = make();
    const r = await session.command("open wikipedia.org");
    expect(executor.executed).toEqual([{ kind: "navigate", url: "https://wikipedia.org" }]);
    expect(r.ok).toBe(true);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.decision?.intent).toBe("open_url");
    expect(r.steps[0]!.result).toEqual({ text: "did navigate", level: "ok" });
    expect(r.page.url).toBe("https://wikipedia.org");
    expect(types().slice(0, 5)).toEqual(["transcript_ack", "status", "decision", "status", "status"]);
    await new Promise((r) => setTimeout(r, 0)); // background verification lands after the command resolves
    expect(executor.snapshots).toBe(2);
    expect(messages.at(-1)).toMatchObject({ type: "verify", command: "open wikipedia.org", verify: { done: true, source: "code" } });
    expect(messages.find((m) => m.type === "decision")).toMatchObject({ decision: { intent: "open_url", source: "heuristic" } });
  });

  it("turns an executor error into an error result, never a rejection", async () => {
    const { session, executor } = make();
    executor.failNext = "boom";
    const r = await session.command("open wikipedia.org");
    expect(r.ok).toBe(false);
    expect(r.steps[0]!.result).toEqual({ text: "boom", level: "error" });
  });

  it("reports unrecognised speech as a warning without touching the executor", async () => {
    const { session, executor } = make();
    const r = await session.command("what do you think about that");
    expect(executor.executed).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.steps[0]!.result?.level).toBe("warn");
  });

  it("ignores empty input", async () => {
    const { session, executor, messages } = make();
    const r = await session.command("   ");
    expect(r.steps).toEqual([]);
    expect(executor.snapshots).toBe(0);
    expect(messages).toEqual([]);
  });
});

describe("Session: confirmation gate", () => {
  const risky = [el("e0", { tag: "button", text: "Delete account" })];

  it("holds a risky click until a spoken yes", async () => {
    const { session, executor, types } = make(risky);
    const first = await session.command("click delete account");
    expect(executor.executed).toEqual([]);
    expect(first.pending).toMatchObject({ kind: "confirm", actionLabel: 'Click button "Delete account"' });
    expect(types()).toContain("confirm");
    const second = await session.command("yes");
    expect(executor.executed).toEqual([{ kind: "click", elementId: "e0", label: 'button "Delete account"' }]);
    expect(second.ok).toBe(true);
    expect(second.pending).toBeNull();
  });

  it("cancels on a spoken no and on reply(false)", async () => {
    const a = make(risky);
    await a.session.command("click delete account");
    const r = await a.session.command("no");
    expect(a.executor.executed).toEqual([]);
    expect(r.steps[0]!.result).toMatchObject({ level: "warn", text: expect.stringContaining("Cancelled") });

    const b = make(risky);
    await b.session.command("click delete account");
    const r2 = await b.session.reply(false);
    expect(b.executor.executed).toEqual([]);
    expect(r2.pending).toBeNull();
  });

  it("runs the held action on reply(true)", async () => {
    const { session, executor } = make(risky);
    await session.command("click delete account");
    const r = await session.reply(true);
    expect(executor.executed).toHaveLength(1);
    expect(r.ok).toBe(true);
  });

  it("lets an unrelated command supersede the question", async () => {
    const { session, executor } = make(risky);
    await session.command("click delete account");
    const r = await session.command("scroll down");
    expect(executor.executed).toEqual([{ kind: "scroll", direction: "down" }]);
    expect(r.pending).toBeNull();
    expect(session.pending).toBeNull();
  });

  it("reply() with nothing pending is a no-op", async () => {
    const { session, executor } = make();
    const r = await session.reply(true);
    expect(executor.executed).toEqual([]);
    expect(r.ok).toBe(false);
  });
});

describe("Session: clarification", () => {
  const ambiguous = [el("e0", { text: "Pricing", hrefShort: "/pricing" }), el("e1", { text: "Pricing FAQ", hrefShort: "/faq" }), el("e2", { text: "Pricing plans", hrefShort: "/plans" })];

  it("asks which one and accepts an ordinal", async () => {
    const { session, executor, messages } = make(ambiguous);
    const first = await session.command("click pricing");
    expect(first.pending?.kind).toBe("clarify");
    const clarify = messages.find((m) => m.type === "clarify");
    expect(clarify && clarify.type === "clarify" ? clarify.options.length : 0).toBeGreaterThan(1);
    const second = await session.command("the second one");
    expect(executor.executed).toHaveLength(1);
    expect(executor.executed[0]).toMatchObject({ kind: "click" });
    expect(second.pending).toBeNull();
  });

  it("accepts a picked option id", async () => {
    const { session, executor } = make(ambiguous);
    await session.command("click pricing");
    const r = await session.pick("e1");
    expect(executor.executed).toEqual([{ kind: "click", elementId: "e1", label: 'link "Pricing FAQ" → /faq' }]);
    expect(r.ok).toBe(true);
  });

  it("treats a non-ordinal reply as a new command", async () => {
    const { session, executor } = make(ambiguous);
    await session.command("click pricing");
    await session.command("scroll down");
    expect(executor.executed).toEqual([{ kind: "scroll", direction: "down" }]);
  });
});

describe("Session: control", () => {
  it("cancel() clears a pending question without executing", async () => {
    const { session, executor, types } = make([el("e0", { tag: "button", text: "Delete account" })]);
    await session.command("click delete account");
    session.cancel();
    expect(session.pending).toBeNull();
    expect(types().at(-1)).toBe("status");
    const r = await session.reply(true);
    expect(executor.executed).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it("serializes commands in order", async () => {
    const { session, executor } = make();
    await Promise.all([session.command("open a.com"), session.command("open b.com"), session.command("scroll down")]);
    expect(executor.executed.map((a) => a.kind)).toEqual(["navigate", "navigate", "scroll"]);
  });

  it("setViewport emits the new size and reports whether anything changed", async () => {
    const { session, messages } = make();
    expect(await session.setViewport(1280, 800)).toBe(false);
    expect(await session.setViewport(1000, 700)).toBe(true);
    expect(messages.at(-1)).toEqual({ type: "viewport", width: 1000, height: 700 });
  });

  it("status() describes the session", async () => {
    const { session } = make();
    expect(await session.status()).toMatchObject({ id: "fake", kind: "playwright", url: "https://example.test/", busy: false, pending: null });
  });
});

describe("Session: multi-step utterances", () => {
  const risky = [el("e0", { tag: "button", text: "Delete account" })];
  const ambiguous = [el("e0", { text: "Pricing", hrefShort: "/pricing" }), el("e1", { text: "Pricing FAQ", hrefShort: "/faq" }), el("e2", { text: "Pricing plans", hrefShort: "/plans" })];

  it("runs each step against a fresh snapshot and announces the split", async () => {
    const { session, executor, messages } = make();
    const r = await session.command("open a.com and then open b.com and scroll down");
    expect(executor.snapshots).toBe(7); // one to route the whole utterance, then one before and one after each step
    expect(executor.executed.map((a) => a.kind)).toEqual(["navigate", "navigate", "scroll"]);
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.command)).toEqual(["open a.com", "open b.com", "scroll down"]);
    expect(r.steps.map((s) => s.verify?.text)).toEqual(["done", "done", "done"]);
    expect(r.stoppedAt).toBeUndefined();
    expect(messages[0]).toEqual({ type: "steps", original: "open a.com and then open b.com and scroll down", commands: ["open a.com", "open b.com", "scroll down"] });
    const acks = messages.filter((m) => m.type === "transcript_ack");
    expect(acks).toHaveLength(3);
    expect(acks[1]).toMatchObject({ text: "open b.com", step: { index: 1, total: 3 } });
  });

  it("a single-step utterance carries no step info and no steps message", async () => {
    const { session, messages } = make();
    await session.command("open a.com");
    expect(messages.some((m) => m.type === "steps")).toBe(false);
    expect(messages[0]).toEqual({ type: "transcript_ack", text: "open a.com", stepId: 1 });
  });

  it("stops the sequence when a step fails", async () => {
    const { session, executor, messages } = make();
    executor.failNext = "network down";
    const r = await session.command("open a.com and scroll down");
    expect(executor.executed).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.stoppedAt).toBe(0);
    expect(r.steps).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({ type: "status", level: "warn", text: expect.stringContaining("Stopped after step 1 of 2") });
  });

  it("stops when a step is not a browser command", async () => {
    const { session, executor } = make();
    const r = await session.command("open a.com and what do you think and scroll down");
    // "what do you think" has no verb so it stays glued to step 1; only the scroll splits off
    expect(r.steps.map((s) => s.command)).toEqual(["open a.com and what do you think", "scroll down"]);
    expect(executor.executed.map((a) => a.kind)).toEqual(["navigate", "scroll"]);
  });

  it("parks the remaining steps behind a confirmation and resumes on yes", async () => {
    const { session, executor } = make(risky);
    const first = await session.command("click delete account and scroll down");
    expect(first.pending?.kind).toBe("confirm");
    expect(first.stoppedAt).toBe(0);
    expect(executor.executed).toEqual([]);
    const second = await session.command("yes");
    expect(executor.executed.map((a) => a.kind)).toEqual(["click", "scroll"]);
    expect(second.ok).toBe(true);
    expect(second.steps.map((s) => s.command)).toEqual(["yes", "scroll down"]);
  });

  it("drops the remaining steps on no", async () => {
    const { session, executor } = make(risky);
    await session.command("click delete account and scroll down");
    await session.command("no");
    expect(executor.executed).toEqual([]);
    await session.command("open a.com");
    expect(executor.executed.map((a) => a.kind)).toEqual(["navigate"]);
  });

  it("resumes after reply(true) and after pick()", async () => {
    const a = make(risky);
    await a.session.command("click delete account and scroll down");
    await a.session.reply(true);
    expect(a.executor.executed.map((x) => x.kind)).toEqual(["click", "scroll"]);

    const b = make(ambiguous);
    await b.session.command("click pricing and scroll down");
    await b.session.pick("e2");
    expect(b.executor.executed.map((x) => x.kind)).toEqual(["click", "scroll"]);

    const c = make(ambiguous);
    await c.session.command("click pricing and scroll down");
    await c.session.command("the third one");
    expect(c.executor.executed.map((x) => x.kind)).toEqual(["click", "scroll"]);
  });

  it("an unrelated command while a question is open drops the parked steps too", async () => {
    const { session, executor } = make(risky);
    await session.command("click delete account and scroll down");
    await session.command("open c.com");
    expect(executor.executed).toEqual([{ kind: "navigate", url: "https://c.com" }]);
    expect(session.pending).toBeNull();
  });

  it("cancel() drops parked steps", async () => {
    const { session, executor } = make(risky);
    await session.command("click delete account and scroll down");
    session.cancel();
    await session.reply(true);
    expect(executor.executed).toEqual([]);
  });

  it("'stop' as a step ends the sequence", async () => {
    const { session, executor } = make();
    const r = await session.command("open a.com and stop and open b.com");
    expect(executor.executed.map((a) => a.kind)).toEqual(["navigate"]);
    expect(r.steps).toHaveLength(2);
  });
});

describe("Session: verification in sequences", () => {
  it("stops the sequence when a step is stuck, naming the blocker", async () => {
    const { session, executor, messages } = make([el("e0", { tag: "button", text: "Next" })]);
    executor.clickChangesPage = false; // a dead click: no diff → heuristic says stuck
    const r = await session.command("click next and scroll down");
    expect(executor.executed.map((a) => a.kind)).toEqual(["click"]);
    expect(r.ok).toBe(false);
    expect(r.stoppedAt).toBe(0);
    expect(r.steps[0]!.verify).toMatchObject({ stuck: true, blocker: "no_change", source: "heuristic" });
    expect(messages.at(-1)).toMatchObject({ type: "status", level: "warn", text: "Stopped after step 1 of 2: stuck: no change" });
  });

  it("a single stuck command is reported but not treated as a sequence failure", async () => {
    const { session, executor } = make([el("e0", { tag: "button", text: "Next" })]);
    executor.clickChangesPage = false;
    const r = await session.command("click next");
    expect(executor.executed).toHaveLength(1);
    expect(r.ok).toBe(true);
    expect(r.stoppedAt).toBeUndefined();
  });

  it("verify: off skips the after-snapshot entirely", async () => {
    const executor = new FakeExecutor();
    const session = new Session("fake", { executor, decider: new HeuristicDecider(), verify: "off" });
    const r = await session.command("open a.com and scroll down");
    expect(executor.snapshots).toBe(3); // route + one per step
    expect(r.steps.every((s) => s.verify === undefined)).toBe(true);
  });
});

describe("Session: held actions are verified too", () => {
  it("a resumed sequence stops when the confirmed click turns out to be stuck", async () => {
    const { session, executor } = make([el("e0", { tag: "button", text: "Delete account" })]);
    executor.clickChangesPage = false;
    await session.command("click delete account and scroll down");
    const r = await session.command("yes");
    expect(executor.executed.map((a) => a.kind)).toEqual(["click"]);
    expect(r.ok).toBe(false);
    expect(r.steps[0]!.verify).toMatchObject({ stuck: true });
  });

  it("a confirmed click that changes the page continues the sequence", async () => {
    const { session, executor } = make([el("e0", { tag: "button", text: "Delete account" })]);
    await session.command("click delete account and scroll down");
    const r = await session.reply(true);
    expect(executor.executed.map((a) => a.kind)).toEqual(["click", "scroll"]);
    expect(r.steps[0]!.verify).toMatchObject({ done: true });
  });
});

describe("Session: brain lane (Hermes)", () => {
  class FakeSpeaker {
    said: string[] = [];
    stopped = 0;
    async speak(text: string) { this.said.push(text); }
    stop() { this.stopped++; }
  }
  function withBrain(opts: { speaker?: boolean; computer?: boolean } = {}) {
    const executor = new FakeExecutor([el("e0", { text: "Pricing", hrefShort: "/pricing" })]);
    const brain = new FakeBrain();
    const speaker = opts.speaker ? new FakeSpeaker() : null;
    const opened: string[] = [];
    const computer = opts.computer ? { openApp: async (app: string) => { opened.push(app); return `Opened ${app}`; } } : null;
    const messages: ServerMessage[] = [];
    const session = new Session("fake", { executor, decider: new HeuristicDecider(), brain, speaker, computer });
    session.subscribe((m) => messages.push(m));
    const brainEvents = () => messages.filter((m): m is Extract<ServerMessage, { type: "brain_event" }> => m.type === "brain_event").map((m) => m.event.kind);
    return { executor, brain, speaker, opened, session, messages, brainEvents };
  }

  it("sends a question to the brain in one piece and streams its events outside the queue", async () => {
    const { session, brain, executor, messages, brainEvents } = withBrain();
    const r = await session.command("find me 20 dentists in austin and put them in a sheet");
    expect(brain.sent).toEqual(["find me 20 dentists in austin and put them in a sheet"]);
    expect(executor.executed).toEqual([]);
    expect(messages.some((m) => m.type === "steps")).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.decision).toMatchObject({ route: "hermes", actionLabel: "Ask Hermes" });
    expect(r.steps[0]!.result).toEqual({ text: "Hermes is on it", level: "ok" });
    // the queue is free: a browser command runs while the brain works
    brain.emit("run_1", { kind: "tool_start", tool: "web_search", preview: "dentists austin" });
    const b = await session.command("click pricing");
    expect(executor.executed.map((a) => a.kind)).toEqual(["click"]);
    expect(b.ok).toBe(true);
    brain.emit("run_1", { kind: "tool_end", tool: "web_search", durationMs: 800, error: false }, { kind: "completed", output: "Done: 20 dentists in the sheet." }, null);
    await tick();
    expect(brainEvents()).toEqual(["tool_start", "tool_end", "completed"]);
    const ev = messages.find((m) => m.type === "brain_event")!;
    expect(ev).toMatchObject({ stepId: r.steps[0]!.stepId, runId: "run_1" });
  });

  it("speaks an acknowledgement and the final answer when the command came by voice", async () => {
    const { session, brain, speaker } = withBrain({ speaker: true });
    await session.command("what's on my calendar today", { speak: true });
    expect(speaker!.said).toEqual(["On it."]);
    brain.emit("run_1", { kind: "delta", text: "Two meetings" }, { kind: "completed", output: "**Two meetings**: standup at 9 and lunch with Sam at noon." }, null);
    await tick();
    expect(speaker!.said.at(-1)).toBe("Two meetings: standup at 9 and lunch with Sam at noon.");
  });

  it("asks the human when the brain wants approval, and a spoken yes/no answers it", async () => {
    const { session, brain, speaker, messages } = withBrain({ speaker: true });
    await session.command("clean up my downloads folder", { speak: true });
    brain.emit("run_1", { kind: "approval", requestId: "req1", summary: "run rm -rf ~/Downloads/*", choices: ["once", "session", "always", "deny"] });
    await tick();
    expect(session.pendingSummary()).toEqual({ kind: "approval", question: "Hermes wants to run rm -rf ~/Downloads/*. Allow it?", choices: ["once", "session", "always", "deny"] });
    expect(speaker!.said.at(-1)).toBe("Hermes wants to run rm -rf ~/Downloads/. Allow it?"); // markdown-ish glyphs are not read aloud
    expect((await session.status()).pending?.kind).toBe("approval");
    const r = await session.command("yes, always", { speak: true });
    expect(brain.approvals).toEqual([{ runId: "run_1", choice: "always", requestId: "req1" }]);
    expect(r.steps[0]!.result).toEqual({ text: "Allowed: run rm -rf ~/Downloads/*", level: "ok" });
    await tick();
    expect(session.pendingSummary()).toBeNull();
    expect(messages.filter((m) => m.type === "brain_event").map((m) => (m as { event: { kind: string } }).event.kind)).toEqual(["approval", "approved"]);
  });

  it("a spoken no denies; a UI choice works too; an unrelated command leaves the request open", async () => {
    const { session, brain, executor } = withBrain();
    await session.command("tidy up");
    brain.emit("run_1", { kind: "approval", requestId: null, summary: "delete old logs", choices: ["once", "deny"] });
    await tick();
    const r = await session.command("scroll down");
    expect(executor.executed.map((a) => a.kind)).toEqual(["scroll"]);
    expect(r.pending?.kind).toBe("approval"); // still waiting
    await session.command("no thanks");
    expect(brain.approvals).toEqual([{ runId: "run_1", choice: "deny", requestId: null }]);
    brain.emit("run_1", { kind: "approval", requestId: "r2", summary: "try again", choices: ["once", "deny"] });
    await tick();
    const ui = await session.approve("once");
    expect(ui.steps[0]!.result?.text).toBe("Allowed: try again");
    expect(brain.approvals.at(-1)).toEqual({ runId: "run_1", choice: "once", requestId: "r2" });
  });

  it("stop halts the brain run as well as local work; cancel() too", async () => {
    const { session, brain, speaker } = withBrain({ speaker: true });
    await session.command("research quantum computing for me");
    const r = await session.command("stop", { speak: true });
    expect(r.steps[0]!.result).toEqual({ text: "Stopped", level: "ok" });
    expect(brain.stops).toEqual(["run_1"]);
    await tick();
    await session.command("write me a poem");
    session.cancel();
    expect(brain.stops).toEqual(["run_1", "run_2"]);
    expect(speaker!.stopped).toBeGreaterThan(0);
  });

  it("a second brain-bound utterance while a run is active steers it", async () => {
    const { session, brain } = withBrain();
    await session.command("find me a hotel in paris");
    const r = await session.command("make it one near the louvre");
    expect(brain.sent).toEqual(["find me a hotel in paris"]);
    expect(brain.steers).toEqual([{ runId: "run_1", text: "make it one near the louvre" }]);
    expect(r.steps[0]!.result).toEqual({ text: "Told Hermes: make it one near the louvre", level: "ok" });
    brain.emit("run_1", { kind: "completed", output: "Booked." }, null);
    await tick();
    await session.command("find me a train too");
    expect(brain.sent).toHaveLength(2);
  });

  it("ask() waits for the brain's answer; a failed run is reported", async () => {
    const { session, brain } = withBrain();
    const p = session.ask("what time is it in tokyo");
    await tick();
    brain.emit("run_1", { kind: "completed", output: "It is 9 am in Tokyo." }, null);
    expect(await p).toMatchObject({ ok: true, output: "It is 9 am in Tokyo." });
    const q = session.ask("and in lima");
    await tick();
    brain.emit("run_2", { kind: "failed", error: "model timeout" }, null);
    expect(await q).toMatchObject({ ok: false, output: "model timeout" });
    const local = await session.ask("scroll down");
    expect(local.output).toBe("did scroll");
  });

  it("an unreachable brain is an error, not a hang", async () => {
    const { session, brain } = withBrain();
    brain.failSend = "Hermes API unreachable at http://127.0.0.1:8642";
    const r = await session.command("what did I ask you yesterday");
    expect(r.ok).toBe(false);
    expect(r.steps[0]!.result).toMatchObject({ level: "error", text: /unreachable/ });
  });

  it("opens apps through the computer lane, or hands them to the brain without one", async () => {
    const withMac = withBrain({ computer: true });
    const r = await withMac.session.command("open slack");
    expect(withMac.opened).toEqual(["slack"]);
    expect(r.steps[0]!.result).toEqual({ text: "Opened slack", level: "ok" });
    expect(r.steps[0]!.decision).toMatchObject({ route: "computer", action: { kind: "open_app", app: "slack" } });
    expect(withMac.brain.sent).toEqual([]);
    const noMac = withBrain();
    await noMac.session.command("open slack");
    expect(noMac.brain.sent).toEqual(["open slack"]);
  });

  it("local commands (the brain's own jev_browse) never reach the brain", async () => {
    const { session, brain, executor } = withBrain();
    const r = await session.command("find me 20 dentists in austin and put them in a sheet", { local: true });
    expect(brain.sent).toEqual([]);
    expect(executor.executed.map((a) => a.kind)).toEqual(["search"]); // split into browser steps instead
    expect(r.steps[0]!.command).toBe("find me 20 dentists in austin");
    const w = await session.command("what did I ask you yesterday", { local: true });
    expect(w.steps[0]!.result).toMatchObject({ level: "warn", text: /needs the assistant/ });
    expect(brain.sent).toEqual([]);
    await session.command("what did I ask you yesterday");
    expect(brain.sent).toEqual(["what did I ask you yesterday"]);
  });

  it("without a brain, hermes-routed commands fall back to the browser action or a warning", async () => {
    const { session, executor } = make();
    const r = await session.command("find me 20 dentists in austin");
    expect(executor.executed.map((a) => a.kind)).toEqual(["search"]);
    expect(r.steps[0]!.decision).toMatchObject({ route: "hermes" });
    const w = await session.command("what did I ask you yesterday");
    expect(w.steps[0]!.result?.level).toBe("warn");
    const mac = await session.command("open slack");
    expect(mac.steps[0]!.result).toMatchObject({ level: "warn", text: /can't open apps/ });
  });
});

describe("Session: brain approval beside a browser question", () => {
  class FakeSpeaker {
    said: string[] = [];
    async speak(text: string) { this.said.push(text); }
    stop() {}
  }
  const risky = [el("e0", { tag: "button", text: "Delete account" })];
  function both() {
    const executor = new FakeExecutor(risky);
    const brain = new FakeBrain();
    const speaker = new FakeSpeaker();
    const session = new Session("fake", { executor, decider: new HeuristicDecider(), brain, speaker });
    return { executor, brain, speaker, session };
  }

  it("neither question clobbers the other; a spoken yes answers the browser first, then the approval is read out", async () => {
    const { session, brain, executor, speaker } = both();
    await session.command("summarize my week", { speak: true });
    const c = await session.command("click delete account", { speak: true });
    expect(c.pending?.kind).toBe("confirm");
    brain.emit("run_1", { kind: "approval", requestId: "r1", summary: "read your calendar", choices: ["once", "deny"] });
    await tick();
    expect(session.pending?.kind).toBe("confirm");
    expect(session.approval?.runId).toBe("run_1");
    expect(speaker.said.some((t) => /calendar/.test(t))).toBe(false); // not spoken over the open browser question
    const r = await session.command("yes", { speak: true });
    expect(executor.executed.map((a) => a.kind)).toEqual(["click"]);
    expect(brain.approvals).toEqual([]);
    expect(r.ok).toBe(true); // the parked approval does not fail the command…
    expect(r.pending).toEqual({ kind: "approval", question: "Hermes wants to read your calendar. Allow it?", choices: ["once", "deny"] });
    expect(speaker.said.at(-1)).toBe("did click Hermes wants to read your calendar. Allow it?"); // …but is read out with its outcome
    const a = await session.command("yes", { speak: true });
    expect(brain.approvals).toEqual([{ runId: "run_1", choice: "once", requestId: "r1" }]);
    expect(a.steps[0]!.result?.text).toBe("Allowed: read your calendar");
  });

  it("a browser question arriving while an approval is parked keeps both; the UI can answer each", async () => {
    const { session, brain, executor } = both();
    await session.command("summarize my week");
    brain.emit("run_1", { kind: "approval", requestId: "r1", summary: "read your calendar", choices: ["once", "deny"] });
    await tick();
    await session.command("click delete account");
    expect(session.pending?.kind).toBe("confirm");
    expect(session.approval?.runId).toBe("run_1");
    expect((await session.status()).pending?.kind).toBe("confirm");
    await session.approve("deny");
    expect(brain.approvals).toEqual([{ runId: "run_1", choice: "deny", requestId: "r1" }]);
    expect(session.pending?.kind).toBe("confirm"); // untouched
    await session.reply(true);
    expect(executor.executed.map((a) => a.kind)).toEqual(["click"]);
  });

  it("stop during a pending approval stops the run instead of denying", async () => {
    const { session, brain } = both();
    await session.command("summarize my week");
    brain.emit("run_1", { kind: "approval", requestId: "r1", summary: "read your calendar", choices: ["once", "deny"] });
    await tick();
    const r = await session.command("stop");
    expect(brain.approvals).toEqual([]);
    expect(brain.stops).toEqual(["run_1"]);
    expect(session.approval).toBeNull();
    expect(r.steps[0]!.result).toEqual({ text: "Stopped", level: "ok" });
  });

  it("a stop word inside a browser confirm cancels it and stops the brain too", async () => {
    const { session, brain } = both();
    await session.command("summarize my week");
    await session.command("click delete account");
    await session.command("never mind");
    expect(brain.stops).toEqual(["run_1"]);
    expect(session.pending).toBeNull();
  });
});

describe("Session: spoken feedback in degraded modes", () => {
  class FakeSpeaker {
    said: string[] = [];
    async speak(text: string) { this.said.push(text); }
    stop() {}
  }
  it("without a brain, a hermes-routed command that ran locally is still spoken", async () => {
    const executor = new FakeExecutor();
    const speaker = new FakeSpeaker();
    const session = new Session("fake", { executor, decider: new HeuristicDecider(), speaker });
    await session.command("find me 20 dentists in austin", { speak: true });
    expect(executor.executed.map((a) => a.kind)).toEqual(["search"]);
    expect(speaker.said).toHaveLength(1);
    expect(speaker.said[0]).toMatch(/^did search/); // the fake page never changes, so the check adds a "stuck" note
  });

  it("a brain stream that throws is spoken, and ask() resolves", async () => {
    const executor = new FakeExecutor();
    const speaker = new FakeSpeaker();
    const brain = new FakeBrain();
    const session = new Session("fake", { executor, decider: new HeuristicDecider(), brain, speaker });
    const asked = session.ask("what's the weather", { speak: true });
    await tick();
    brain.throwOn("run_1", new Error("socket hang up"));
    const r = await asked;
    expect(r).toMatchObject({ ok: false, output: "socket hang up" });
    expect(speaker.said.at(-1)).toBe("Hermes dropped out: socket hang up");
  });
});
