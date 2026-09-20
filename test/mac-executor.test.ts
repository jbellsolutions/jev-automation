import { describe, expect, it } from "vitest";
import type { Action } from "../core/actions.js";
import type { Executor, ExecutorKind } from "../core/executor.js";
import type { MacWindow } from "../core/mac.js";
import { FrontExecutor } from "../server/executors/front.js";
import { type Driver, MacExecutor, NOT_AVAILABLE, NO_WINDOW } from "../server/executors/mac.js";
import { el } from "./helpers/fake-executor.js";

/** A browser surface with a switchable readiness (the bridge comes and goes). */
class Surface implements Executor {
  readonly capabilities = { screenshot: false, viewport: false, clickAt: true };
  readonly viewport = { width: 1280, height: 800 };
  url = "https://example.test/";
  executed: Action[] = [];
  constructor(readonly kind: ExecutorKind, public ready: boolean, readonly id = kind) {}
  async start() {}
  async title() { return this.kind; }
  async snapshot() { return { url: this.url, title: this.kind, elements: [el("e0", { text: "Compose" })] }; }
  async screenshot() { return null; }
  async execute(action: Action) { this.executed.push(action); return `did ${action.kind}`; }
  async setViewport() { return false; }
  onChange() { return () => {}; }
  async close() {}
}

const slack: MacWindow = { app_name: "Slack", pid: 100, window_id: 15, title: "general - Acme", layer: 0, is_on_screen: true, bounds: { x: 0, y: 0, width: 1200, height: 800 } };
const chrome: MacWindow = { ...slack, app_name: "Google Chrome", pid: 60, window_id: 16, title: "Inbox - Gmail" };

/** A scripted cua-driver: records every call, answers from `answers`, and can be told which
 *  windows are on screen and which snapshot id the next tree carries. */
function fakeDriver(state: { windows: MacWindow[]; snapshotId?: string; stale?: boolean; down?: boolean; accessibility?: boolean }) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const driver: Driver = async (tool, args = {}) => {
    calls.push({ tool, args });
    if (state.down) throw new Error("Cua Driver daemon is not running. Start it first with: cua-driver serve");
    switch (tool) {
      case "check_permissions":
        return { accessibility: state.accessibility ?? true, screen_recording: true };
      case "list_windows":
        return { windows: state.windows };
      case "get_window_state":
        return {
          snapshot_id: state.snapshotId ?? "s00000001",
          window_title: "general - Acme",
          elements: [
            { element_index: 3, role: "AXRow", label: "general", actions: ["AXPress"], element_token: `${state.snapshotId ?? "s00000001"}:3` },
            { element_index: 6, role: "AXTextArea", label: "Message #general", element_token: `${state.snapshotId ?? "s00000001"}:6` },
          ],
        };
      case "click":
      case "type_text":
        if (state.stale) throw new Error(`element_token ${args.element_token} is stale: superseded by a newer snapshot`);
        return { ok: true, effect: "unverifiable" };
      default:
        return { ok: true };
    }
  };
  return { driver, calls };
}

describe("MacExecutor over cua-driver", () => {
  it("snapshots the app in front (skipping our own windows) and addresses elements by token", async () => {
    let now = 1000;
    const { driver, calls } = fakeDriver({ windows: [{ ...slack, app_name: "Jev", pid: 7, window_id: 1 }, slack] });
    const mac = new MacExecutor({ driver, ownPids: () => [7], now: () => now });
    await mac.start();
    expect(mac.ready).toBe(true);
    const snap = await mac.snapshot();
    expect(snap.url).toBe("app://Slack");
    expect(snap.title).toBe("general - Acme");
    expect(snap.elements.map((e) => e.id)).toEqual(["e0", "e1"]);
    const walk = calls.find((c) => c.tool === "get_window_state")!;
    expect(walk.args).toMatchObject({ pid: 100, window_id: 15, include_screenshot: false, max_elements: 600 });

    expect(await mac.execute({ kind: "click", elementId: "e0", label: "general" })).toBe("Clicked general");
    expect(calls.at(-1)).toEqual({ tool: "click", args: { pid: 100, element_token: "s00000001:3", action: "press" } });

    // the tree is stale after an action: the next snapshot walks again even inside the TTL
    now += 100;
    await mac.snapshot();
    expect(calls.filter((c) => c.tool === "get_window_state")).toHaveLength(2);
    // and within the TTL with nothing done, it is reused
    now += 100;
    await mac.snapshot();
    expect(calls.filter((c) => c.tool === "get_window_state")).toHaveLength(2);
  });

  it("types into the chosen field, presses Enter to submit, and maps spoken keys", async () => {
    const { driver, calls } = fakeDriver({ windows: [slack] });
    const mac = new MacExecutor({ driver });
    await mac.snapshot();
    expect(await mac.execute({ kind: "type", elementId: "e1", label: "Message #general", text: "hello", submit: true })).toBe('Typed "hello" into Message #general and pressed Enter');
    // keys are delivered to the exact window as real input (background posts to Cocoa text views are dropped)
    const win = { pid: 100, window_id: 15, delivery_mode: "foreground" };
    expect(calls.slice(-2)).toEqual([
      { tool: "type_text", args: { pid: 100, element_token: "s00000001:6", text: "hello" } },
      { tool: "press_key", args: { ...win, key: "return" } },
    ]);
    await mac.snapshot();
    expect(await mac.execute({ kind: "type", elementId: null, label: null, text: "hi", submit: false })).toBe('Typed "hi"');
    // background, not foreground: fronting for the caret write too let a fast queue of typed
    // instructions restore focus to the wrong app between one and the next (M5 follow-up)
    expect(calls.at(-1)).toEqual({ tool: "type_text", args: { pid: 100, text: "hi" } });
    expect(await mac.execute({ kind: "press", key: "cmd+enter" })).toBe("Pressed cmd+enter");
    expect(calls.at(-1)).toEqual({ tool: "press_key", args: { ...win, key: "return", modifiers: ["cmd"] } });
    expect(await mac.execute({ kind: "scroll", direction: "down" })).toBe("Scrolled down");
    expect(calls.at(-1)).toMatchObject({ tool: "scroll", args: { ...win, direction: "down" } });
  });

  it("reports a superseded token the way every surface does, so the loop re-snapshots", async () => {
    const state = { windows: [slack], stale: false };
    const { driver } = fakeDriver(state);
    const mac = new MacExecutor({ driver });
    await mac.snapshot();
    state.stale = true;
    await expect(mac.execute({ kind: "click", elementId: "e0", label: "general" })).rejects.toThrow("general is no longer on the page");
    await expect(mac.execute({ kind: "click", elementId: "e9", label: "nothing" })).rejects.toThrow("nothing is no longer on the page");
  });

  it("opens URLs in the default browser instead of pretending to be one", async () => {
    const opened: string[] = [];
    const { driver } = fakeDriver({ windows: [slack] });
    const mac = new MacExecutor({ driver, open: async (u) => void opened.push(u) });
    expect(await mac.execute({ kind: "navigate", url: "https://mail.google.com" })).toBe("Opened https://mail.google.com in your browser");
    expect(opened).toEqual(["https://mail.google.com"]);
  });

  it("is not ready without the daemon or its grants, launches it once, and says so on actions", async () => {
    const state = { windows: [slack], down: true };
    let launched = 0;
    const { driver } = fakeDriver(state);
    const mac = new MacExecutor({
      driver,
      launchDaemon: async () => {
        launched++;
        state.down = false;
      },
    });
    await mac.start();
    expect(launched).toBe(1);
    expect(mac.ready).toBe(true);
    state.down = true;
    await expect(mac.snapshot()).rejects.toThrow(NOT_AVAILABLE);
    expect(mac.ready).toBe(false);

    const noGrant = new MacExecutor({ driver: fakeDriver({ windows: [], accessibility: false }).driver });
    await noGrant.start();
    expect(noGrant.ready).toBe(false);
  });

  it("has nothing to act on when no ordinary window is in front", async () => {
    const { driver } = fakeDriver({ windows: [] });
    const mac = new MacExecutor({ driver });
    expect(await mac.snapshot()).toEqual({ url: "app://", title: "", elements: [] });
    await expect(mac.execute({ kind: "press", key: "enter" })).rejects.toThrow(NO_WINDOW);
  });
});

describe("FrontExecutor: whatever is in front", () => {
  function setup(windows: MacWindow[], bridgeReady: boolean, macReady = true) {
    const state = { windows, down: !macReady };
    const { driver } = fakeDriver(state);
    const mac = new MacExecutor({ driver });
    const bridge = new Surface("chrome", bridgeReady);
    const fallback = new Surface("playwright", true);
    const front = new FrontExecutor({ mac, chrome: bridge, fallback });
    return { state, mac, bridge, fallback, front };
  }

  it("uses the Mac tree when a native app is in front, and the Chrome bridge when Chrome is", async () => {
    const { state, front, mac, bridge } = setup([slack], true);
    await front.start();
    expect((await front.snapshot()).url).toBe("app://Slack");
    expect(front.kind).toBe("mac");
    expect(front.surface).toBe(mac);
    state.windows = [chrome];
    await front.snapshot();
    expect(front.surface).toBe(bridge);
    expect(front.kind).toBe("chrome");
    await front.execute({ kind: "click", elementId: "e0", label: "Compose" });
    expect(bridge.executed.map((a) => a.kind)).toEqual(["click"]);
  });

  it("falls back to the built-in browser when Chrome is in front but the bridge is not connected, and when the driver is down", async () => {
    const a = setup([chrome], false);
    await a.front.start();
    await a.front.snapshot();
    expect(a.front.surface).toBe(a.fallback);
    const b = setup([slack], true, false);
    await b.front.start();
    await b.front.snapshot();
    expect(b.front.surface).toBe(b.bridge);
    const c = setup([], true);
    await c.front.start();
    await c.front.snapshot();
    expect(c.front.surface).toBe(c.bridge); // nothing native in front: the browser it is
  });

  it("tells listeners when the surface behind it changes", async () => {
    const { state, front } = setup([slack], true);
    let changes = 0;
    front.onChange(() => changes++);
    await front.start();
    await front.snapshot();
    const after = changes;
    state.windows = [chrome];
    await front.snapshot();
    expect(changes).toBeGreaterThan(after);
  });
});
