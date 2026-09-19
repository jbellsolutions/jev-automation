import type { Action } from "../../core/actions.js";
import type { PageElement, PageSnapshot } from "../../core/elements.js";
import type { Executor, ExecutorCapabilities } from "../../core/executor.js";

export const el = (id: string, over: Partial<PageElement>): PageElement => ({
  id, tag: "a", role: "", type: "", text: "", label: "", placeholder: "", name: "", hrefShort: null, inViewport: true, ...over,
});

/** Records every call so tests can assert exactly what the loop asked of the surface. */
export class FakeExecutor implements Executor {
  readonly kind = "playwright" as const;
  readonly capabilities: ExecutorCapabilities = { screenshot: false, viewport: true, clickAt: true };
  viewport = { width: 1280, height: 800 };
  url = "https://example.test/";
  snapshots = 0;
  executed: Action[] = [];
  failNext: string | null = null;
  constructor(public elements: PageElement[] = [], readonly id = "fake") {}
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
