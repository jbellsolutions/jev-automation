/** The Mac's frontmost app as a surface, through Cua's `cua-driver` (the same daemon Hermes'
 *  computer_use tool drives, so the Accessibility and Screen Recording grants belong to
 *  CuaDriver.app and never to us). One call per verb: list_windows to find the window the user
 *  is in, get_window_state for its accessibility tree, click / type_text / press_key / scroll
 *  by element token. Actions go through the accessibility path by default — no cursor moves,
 *  no focus stealing — so the user keeps typing while Jev works. */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Action } from "../../core/actions.js";
import { MAX_ELEMENTS, type PageSnapshot } from "../../core/elements.js";
import type { Executor, ExecutorCapabilities } from "../../core/executor.js";
import { type AxElement, BROWSER_APPS, type MacWindow, appUrl, driverKey, frontWindow, isStaleTokenError, macSnapshot } from "../../core/mac.js";

/** One driver round trip: tool name + JSON arguments -> parsed JSON result. */
export type Driver = (tool: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface MacExecutorOptions {
  driver?: Driver;
  /** Processes whose windows are never the user's target (the floating panel itself). */
  ownPids?: () => number[];
  /** Accessibility elements walked per snapshot; Electron apps have thousands. */
  maxElements?: number;
  maxDepth?: number;
  /** `snapshot()` reuses the last tree for this long (the loop snapshots before every step). */
  snapshotTtlMs?: number;
  timeoutMs?: number;
  /** Launch the driver daemon when it is not answering (`open -g -a CuaDriver --args serve`). */
  launchDaemon?: () => Promise<void>;
  /** Open a URL in the default browser (tests stub it). */
  open?: (url: string) => Promise<void>;
  /** The frontmost application's pid — the app the keyboard belongs to (default: `lsappinfo front`). */
  frontPid?: () => Promise<number | null>;
  now?: () => number;
}

export const DRIVER_BIN = process.env.CUA_DRIVER ?? join(process.env.HOME ?? "", ".local/bin/cua-driver");

export const NOT_AVAILABLE = "The Mac isn't reachable: cua-driver is not answering (run `hermes computer-use doctor`)";
export const NO_WINDOW = "Nothing is in front to act on: bring the app forward first";

interface Held {
  window: MacWindow;
  snapshotId: string | null;
  tokens: Map<string, AxElement>;
  snapshot: PageSnapshot;
  at: number;
  /** Set after any action: the tree must be walked again before the next decision. */
  stale: boolean;
}

/** `cua-driver call <tool> '<json>'`: the CLI talks to the daemon over its socket and prints the
 *  structured result as JSON. ~30 ms of process overhead per call. */
export function cliDriver(bin = DRIVER_BIN, timeoutMs = 30_000): Driver {
  return (tool, args = {}) =>
    new Promise((resolve, reject) => {
      execFile(bin, ["call", tool, JSON.stringify(args)], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        const text = String(stdout ?? "").trim();
        if (err && !text) return reject(new Error(String(stderr || err.message).trim()));
        let parsed: unknown;
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          // the driver prints a bare sentence for refusals ("permissions_pending: …")
          return reject(new Error(text || String(stderr || err?.message || "no output").trim()));
        }
        if (parsed && typeof parsed === "object" && "error" in parsed && (parsed as { error?: unknown }).error) {
          const e = (parsed as { error: unknown }).error;
          return reject(new Error(typeof e === "string" ? e : JSON.stringify(e)));
        }
        resolve(parsed);
      });
    });
}

/** The Mac surface for this host: macOS, not switched off, driver installed. */
export function selectMac(opts: Omit<MacExecutorOptions, "launchDaemon"> = {}, env: NodeJS.ProcessEnv = process.env, platform = process.platform): MacExecutor | null {
  if (platform !== "darwin" || env.JEV_MAC === "off") return null;
  if (!existsSync(env.CUA_DRIVER ?? DRIVER_BIN)) return null;
  return new MacExecutor({ launchDaemon, ...opts });
}

export function launchDaemon(): Promise<void> {
  return new Promise((resolve) => execFile("open", ["-g", "-a", "CuaDriver", "--args", "serve"], () => setTimeout(resolve, 1500)));
}

export class MacExecutor implements Executor {
  readonly kind = "mac" as const;
  // no live frames: a per-tick window capture through the driver + sips would be far too heavy
  // for the panel's refresh rate. The panel shows app://<name>; a Mac picture-in-picture is roadmap.
  readonly capabilities: ExecutorCapabilities = { screenshot: false, viewport: false, clickAt: false };
  readonly viewport = { width: 1280, height: 800 };
  private readonly driver: Driver;
  private held: Held | null = null;
  private available = false;
  private readonly changeListeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(
    private readonly opts: MacExecutorOptions = {},
    readonly id = "mac",
  ) {
    this.driver = opts.driver ?? cliDriver(DRIVER_BIN, opts.timeoutMs);
    this.now = opts.now ?? Date.now;
  }

  /** The driver answered and holds its permissions. Re-checked by start() and after failures. */
  get ready(): boolean {
    return this.available;
  }

  get url(): string {
    return this.held ? appUrl(this.held.window.app_name) : "app://";
  }

  /** The window the last snapshot was taken of. */
  get window(): MacWindow | null {
    return this.held?.window ?? null;
  }

  async start(): Promise<void> {
    this.available = await this.probe();
    if (!this.available && this.opts.launchDaemon) {
      await this.opts.launchDaemon();
      this.available = await this.probe();
    }
  }

  /** `check_permissions` is the one call that answers only when the daemon is up *and* trusted. */
  async probe(): Promise<boolean> {
    try {
      const r = (await this.driver("check_permissions", {})) as { accessibility?: boolean };
      return r?.accessibility === true;
    } catch {
      return false;
    }
  }

  async title(): Promise<string> {
    return this.held?.snapshot.title ?? "";
  }

  /** Which app is in front right now. `lsappinfo front` (~10 ms, no TCC) names the frontmost
   *  application; the window comes from list_windows. Null when nothing ordinary is in front. */
  async front(): Promise<MacWindow | null> {
    const [r, pid] = await Promise.all([this.call("list_windows", {}) as Promise<{ windows?: MacWindow[] }>, this.frontPid()]);
    return frontWindow(r.windows ?? [], this.opts.ownPids?.() ?? [], pid);
  }

  private frontPid(): Promise<number | null> {
    if (this.opts.frontPid) return this.opts.frontPid();
    return new Promise((resolve) =>
      execFile("/bin/sh", ["-c", 'lsappinfo info -only pid "$(lsappinfo front)"'], { timeout: 3000 }, (_e, out) => {
        const m = /"pid"\s*=\s*(\d+)/.exec(String(out));
        resolve(m ? Number(m[1]) : null);
      }),
    );
  }

  /** Is a browser the front app? The hub then prefers the Chrome bridge for this turn. */
  async browserInFront(): Promise<boolean> {
    const w = await this.front();
    return w !== null && BROWSER_APPS.has(w.app_name);
  }

  /** `win`: a window the caller already looked up this turn (saves the list_windows call). */
  async snapshot(win?: MacWindow | null): Promise<PageSnapshot> {
    const ttl = this.opts.snapshotTtlMs ?? 1200;
    if (this.held && !this.held.stale && this.now() - this.held.at < ttl && (!win || win.window_id === this.held.window.window_id)) return this.held.snapshot;
    if (win === undefined) win = await this.front();
    if (!win) {
      this.held = null;
      return { url: "app://", title: "", elements: [] };
    }
    const r = (await this.call("get_window_state", {
      pid: win.pid,
      window_id: win.window_id,
      include_screenshot: false,
      max_elements: this.opts.maxElements ?? 600,
      max_depth: this.opts.maxDepth ?? 16,
    })) as { snapshot_id?: string; elements?: AxElement[]; window_title?: string };
    const { snapshot, tokens } = macSnapshot({ ...win, title: r.window_title || win.title }, r.elements ?? [], MAX_ELEMENTS);
    this.held = { window: win, snapshotId: r.snapshot_id ?? null, tokens, snapshot, at: this.now(), stale: false };
    return snapshot;
  }

  async screenshot(): Promise<Uint8Array | null> {
    return null; // capabilities.screenshot is false; the hub never asks
  }

  async execute(action: Action): Promise<string> {
    switch (action.kind) {
      case "navigate":
        // a URL said while a Mac app is in front: the default browser, brought forward
        await this.open(action.url);
        this.invalidate();
        return `Opened ${action.url} in your browser`;
      case "search":
        await this.open(action.url);
        this.invalidate();
        return `Searched for "${action.query}" in your browser`;
      case "click": {
        const { pid, element } = this.locate(action.elementId, action.label);
        await this.byToken(action.label, () => this.call("click", { pid, element_token: element.element_token, action: "press" }));
        this.invalidate();
        return `Clicked ${action.label}`;
      }
      case "type": {
        if (action.elementId) {
          const { pid, element } = this.locate(action.elementId, action.label ?? action.elementId);
          await this.byToken(action.label ?? action.elementId, () => this.call("type_text", { pid, element_token: element.element_token, text: action.text }));
        } else {
          await this.call("type_text", { ...this.target(), text: action.text });
        }
        if (action.submit) await this.call("press_key", { ...this.target(), key: "return" });
        this.invalidate();
        return `Typed "${action.text}"${action.label ? ` into ${action.label}` : ""}${action.submit ? " and pressed Enter" : ""}`;
      }
      case "press": {
        const { key, modifiers } = driverKey(action.key);
        await this.call("press_key", { ...this.target(), key, ...(modifiers.length ? { modifiers } : {}) });
        this.invalidate();
        return `Pressed ${action.key}`;
      }
      case "scroll": {
        const toEdge = action.direction === "top" || action.direction === "bottom";
        await this.call("scroll", { ...this.target(), direction: action.direction === "top" ? "up" : action.direction === "bottom" ? "down" : action.direction, by: "page", amount: toEdge ? 20 : 3 });
        this.invalidate();
        return toEdge ? `Scrolled to ${action.direction}` : `Scrolled ${action.direction}`;
      }
      case "back":
        await this.call("press_key", { ...this.target(), key: "left", modifiers: ["cmd"] });
        this.invalidate();
        return "Went back";
      case "forward":
        await this.call("press_key", { ...this.target(), key: "right", modifiers: ["cmd"] });
        this.invalidate();
        return "Went forward";
      case "reload":
        await this.call("press_key", { ...this.target(), key: "r", modifiers: ["cmd"] });
        this.invalidate();
        return "Reloaded";
      case "click_at":
        throw new Error("Clicking by coordinates isn't available on the Mac surface");
      case "open_app":
      case "open_path":
        throw new Error("Opening apps and files is the computer lane's job, not the surface's");
      case "stop":
      case "none":
        return "";
    }
  }

  async setViewport(): Promise<boolean> {
    return false; // the user's windows are theirs
  }

  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  async close(): Promise<void> {
    this.held = null;
  }

  /** The last snapshot is stale after any action; the next snapshot() walks the tree again. */
  private invalidate(): void {
    if (this.held) this.held.stale = true;
    for (const cb of this.changeListeners) cb();
  }

  private pidFor(): number {
    if (!this.held) throw new Error(NO_WINDOW);
    return this.held.window.pid;
  }

  /** Keys and scrolls go to the exact window, delivered as real input while it is briefly
   *  fronted: the window is the one in front anyway, and background posts to a Cocoa text
   *  view are silently dropped (the driver answers with a list of candidate windows). */
  private target(): { pid: number; window_id: number; delivery_mode: "foreground" } {
    if (!this.held) throw new Error(NO_WINDOW);
    return { pid: this.held.window.pid, window_id: this.held.window.window_id, delivery_mode: "foreground" };
  }

  private locate(elementId: string, label: string): { pid: number; element: AxElement } {
    const element = this.held?.tokens.get(elementId);
    if (!this.held || !element?.element_token) throw new Error(`${label} is no longer on the page`);
    return { pid: this.held.window.pid, element };
  }

  /** The driver refuses tokens from a superseded snapshot: report that in the words every
   *  executor uses, so the loop re-snapshots and retries the way it does for web pages. */
  private async byToken<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isStaleTokenError(msg)) throw new Error(`${label} is no longer on the page`);
      throw err;
    }
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      const r = await this.driver(tool, args);
      this.available = true;
      return r;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not running|Start it first|ECONNREFUSED|ENOENT|permissions_pending|daemon/i.test(msg)) {
        this.available = false;
        throw new Error(NOT_AVAILABLE);
      }
      throw err;
    }
  }

  private open(url: string): Promise<void> {
    return this.opts.open ? this.opts.open(url) : new Promise((resolve, reject) => execFile("open", [url], (err) => (err ? reject(err) : resolve())));
  }
}
