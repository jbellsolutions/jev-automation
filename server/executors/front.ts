/** "What's in front": one surface that stands for whatever the user is looking at. A browser
 *  in front means the Chrome bridge (the tab, with its DOM); any other app means the Mac
 *  executor (its accessibility tree); nothing usable in front falls back to the bridge, then
 *  to the built-in browser. The choice is made once per snapshot and held for the actions
 *  that follow, so element ids always belong to the surface they came from. */
import type { Action } from "../../core/actions.js";
import type { PageSnapshot } from "../../core/elements.js";
import type { Executor, ExecutorCapabilities, ExecutorKind } from "../../core/executor.js";
import { BROWSER_APPS } from "../../core/mac.js";
import type { MacExecutor } from "./mac.js";

export interface FrontExecutorOptions {
  mac: MacExecutor;
  /** The user's Chrome through the bridge; used when a browser is in front and it is connected. */
  chrome?: Executor | null;
  /** The built-in browser, always ready. */
  fallback: Executor;
}

export class FrontExecutor implements Executor {
  readonly viewport = { width: 1280, height: 800 };
  private current: Executor;
  private readonly changeListeners = new Set<() => void>();
  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    private readonly opts: FrontExecutorOptions,
    readonly id = "front",
  ) {
    this.current = opts.chrome?.ready ? opts.chrome : opts.fallback;
    for (const e of [opts.mac, opts.chrome, opts.fallback]) if (e) this.unsubscribe.push(e.onChange(() => this.changed()));
  }

  /** Reports the surface behind the last snapshot, so UIs label it chrome / mac / playwright. */
  get kind(): ExecutorKind {
    return this.current.kind;
  }

  get capabilities(): ExecutorCapabilities {
    return this.current.capabilities;
  }

  get ready(): boolean {
    return true; // the fallback always is
  }

  get url(): string {
    return this.current.url;
  }

  /** Which executor is answering right now. */
  get surface(): Executor {
    return this.current;
  }

  async start(): Promise<void> {
    await this.opts.mac.start();
  }

  title(): Promise<string> {
    return this.current.title();
  }

  /** Look at what is in front, pick the surface for this turn, and snapshot it. */
  async snapshot(): Promise<PageSnapshot> {
    const next = await this.pick();
    if (next !== this.current) {
      this.current = next;
      this.changed();
    }
    return next === this.opts.mac ? this.opts.mac.snapshot(this.lastWindow) : next.snapshot();
  }

  private lastWindow: Awaited<ReturnType<MacExecutor["front"]>> = null;

  private async pick(): Promise<Executor> {
    const { mac, chrome, fallback } = this.opts;
    const browser = chrome?.ready ? chrome : fallback;
    if (!mac.ready) return browser;
    try {
      this.lastWindow = await mac.front();
    } catch {
      return browser;
    }
    const w = this.lastWindow;
    if (!w) return browser;
    if (BROWSER_APPS.has(w.app_name)) return browser;
    return mac;
  }

  screenshot(): Promise<Uint8Array | null> {
    return this.current.screenshot();
  }

  execute(action: Action): Promise<string> {
    return this.current.execute(action);
  }

  async setViewport(): Promise<boolean> {
    return false;
  }

  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  private changed(): void {
    for (const cb of this.changeListeners) cb();
  }

  async close(): Promise<void> {
    for (const u of this.unsubscribe) u();
    // the delegates are registered surfaces of their own and are closed by their owner
  }
}
