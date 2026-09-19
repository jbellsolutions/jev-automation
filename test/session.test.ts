import { describe, expect, it } from "vitest";
import { HeuristicDecider } from "../core/decide.js";
import type { PageElement } from "../core/elements.js";
import type { ServerMessage } from "../core/protocol.js";
import { Session } from "../core/session.js";
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
    expect(executor.snapshots).toBe(6); // one before and one after each step
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
    expect(messages[0]).toEqual({ type: "transcript_ack", text: "open a.com" });
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
    expect(executor.snapshots).toBe(2);
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
