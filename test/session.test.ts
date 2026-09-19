import { describe, expect, it } from "vitest";
import type { Action } from "../core/actions.js";
import { HeuristicDecider } from "../core/decide.js";
import type { PageElement, PageSnapshot } from "../core/elements.js";
import type { Executor, ExecutorCapabilities } from "../core/executor.js";
import type { ServerMessage } from "../core/protocol.js";
import { Session } from "../core/session.js";

const el = (id: string, over: Partial<PageElement>): PageElement => ({
  id, tag: "a", role: "", type: "", text: "", label: "", placeholder: "", name: "", hrefShort: null, inViewport: true, ...over,
});

/** Records every call; `pages` is a queue of snapshots so multi-step flows can see a changing surface. */
class FakeExecutor implements Executor {
  readonly id = "fake";
  readonly kind = "playwright" as const;
  readonly capabilities: ExecutorCapabilities = { screenshot: false, viewport: true, clickAt: true };
  viewport = { width: 1280, height: 800 };
  url = "https://example.test/";
  snapshots = 0;
  executed: Action[] = [];
  failNext: string | null = null;
  constructor(public elements: PageElement[] = []) {}
  async start() {}
  async title() { return "Example"; }
  async snapshot(): Promise<PageSnapshot> { this.snapshots++; return { url: this.url, title: "Example", elements: this.elements }; }
  async screenshot() { return null; }
  async execute(action: Action): Promise<string> {
    if (this.failNext) { const m = this.failNext; this.failNext = null; throw new Error(m); }
    this.executed.push(action);
    if (action.kind === "navigate") this.url = action.url;
    return `did ${action.kind}`;
  }
  async setViewport(w: number, h: number) { if (w === this.viewport.width) return false; this.viewport = { width: w, height: h }; return true; }
  onChange() { return () => {}; }
  async close() {}
}

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
    expect(executor.snapshots).toBe(1);
    expect(executor.executed).toEqual([{ kind: "navigate", url: "https://wikipedia.org" }]);
    expect(r.ok).toBe(true);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.decision?.intent).toBe("open_url");
    expect(r.steps[0]!.result).toEqual({ text: "did navigate", level: "ok" });
    expect(r.page.url).toBe("https://wikipedia.org");
    expect(types()).toEqual(["transcript_ack", "status", "decision", "status", "status"]);
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
