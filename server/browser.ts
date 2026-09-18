import { type Browser, type BrowserContext, type Page, chromium } from "playwright";
import type { Action } from "./actions.js";
import { type PageSnapshot, extractElements } from "./elements.js";

export interface BrowserOptions {
  headless: boolean;
  executablePath?: string;
  /** Extra Chromium command-line switches (e.g. proxy or trust settings). */
  args?: string[];
  startUrl: string;
  /** Local page to show when the start URL cannot be reached (offline, blocked). */
  fallbackUrl?: string;
  viewport: { width: number; height: number };
}

/** One Chromium controlled through Playwright. Single-user by design: one page at a
 *  time, switching to popups/new tabs automatically so "open in new tab" links work. */
export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private changeListeners = new Set<() => void>();

  constructor(readonly options: BrowserOptions) {}

  async start(): Promise<void> {
    try {
      this.browser = await chromium.launch({
        headless: this.options.headless,
        executablePath: this.options.executablePath || undefined,
        args: this.options.args ?? [],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not launch Chromium. Run "npx playwright install chromium" or set CHROMIUM_EXECUTABLE_PATH.\n${msg}`);
    }
    this.context = await this.browser.newContext({ viewport: this.options.viewport });
    this.context.on("page", (p) => this.adopt(p));
    this.adopt(await this.context.newPage());
    try {
      await this.goto(this.options.startUrl);
    } catch (err) {
      if (!this.options.fallbackUrl) throw err;
      console.warn(`${err instanceof Error ? err.message : err}\nFalling back to ${this.options.fallbackUrl}`);
      // Chromium is still swapping in its error page; give it a beat, then retry once.
      for (let attempt = 0; attempt < 2; attempt++) {
        await this.active.waitForTimeout(400);
        try {
          await this.goto(this.options.fallbackUrl);
          return;
        } catch (fallbackErr) {
          if (attempt === 1) console.warn(fallbackErr instanceof Error ? fallbackErr.message : fallbackErr);
        }
      }
    }
  }

  private adopt(p: Page): void {
    this.page = p;
    const notify = () => this.emitChange();
    p.on("load", notify);
    p.on("domcontentloaded", notify);
    p.on("framenavigated", (f) => f === p.mainFrame() && notify());
    p.on("close", () => {
      if (this.page !== p) return;
      const rest = this.context?.pages().filter((x) => !x.isClosed()) ?? [];
      const next = rest[rest.length - 1];
      if (next) this.page = next;
      else void this.context?.newPage().then((np) => this.adopt(np));
      this.emitChange();
    });
    notify();
  }

  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  private emitChange(): void {
    for (const cb of this.changeListeners) cb();
  }

  private get active(): Page {
    if (!this.page || this.page.isClosed()) throw new Error("Browser page is not available");
    return this.page;
  }

  get url(): string {
    return this.page?.url() ?? "about:blank";
  }

  async title(): Promise<string> {
    try {
      return await this.active.title();
    } catch {
      return "";
    }
  }

  async snapshot(): Promise<PageSnapshot> {
    const page = this.active;
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 2000 });
    } catch {
      /* still loading: snapshot whatever is there */
    }
    let elements: PageSnapshot["elements"] = [];
    try {
      elements = await extractElements(page);
    } catch (err) {
      // usually a navigation mid-evaluate; log so a broken script is never silent
      console.warn("element extraction failed:", err instanceof Error ? err.message.split("\n")[0] : err);
    }
    return { url: page.url(), title: await this.title(), elements };
  }

  async screenshot(): Promise<Buffer | null> {
    try {
      return await this.active.screenshot({ type: "jpeg", quality: 60, timeout: 3000 });
    } catch {
      return null;
    }
  }

  private locate(elementId: string) {
    if (!/^e\d+$/.test(elementId)) throw new Error(`Bad element id ${elementId}`);
    return this.active.locator(`[data-jev-id="${elementId}"]`).first();
  }

  private async goto(url: string): Promise<void> {
    try {
      await this.active.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      throw new Error(`Couldn't open ${url}: ${msg}`);
    }
  }

  private async settle(): Promise<void> {
    await this.active.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
    await this.active.waitForTimeout(250);
  }

  /** Perform an action and return a short status line for the UI. */
  async execute(action: Action): Promise<string> {
    const page = this.active;
    switch (action.kind) {
      case "navigate":
        await this.goto(action.url);
        return `Opened ${action.url}`;
      case "search":
        await this.goto(action.url);
        return `Searched for "${action.query}"`;
      case "click": {
        const loc = this.locate(action.elementId);
        if ((await loc.count()) === 0) throw new Error(`${action.label} is no longer on the page`);
        await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await loc.click({ timeout: 5000 });
        await this.settle();
        return `Clicked ${action.label}`;
      }
      case "click_at":
        await page.mouse.click(action.x, action.y);
        await this.settle();
        return `Clicked at (${action.x}, ${action.y})`;
      case "type": {
        const loc = action.elementId
          ? this.locate(action.elementId)
          : page
              .locator(
                'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):visible, textarea:visible, [contenteditable="true"]:visible, [role="textbox"]:visible, [role="combobox"]:visible, [role="searchbox"]:visible',
              )
              .first();
        if ((await loc.count()) === 0) throw new Error("There's no text field to type into on this page");
        await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await loc.click({ timeout: 5000 });
        const tag = await loc.evaluate((el) => el.tagName.toLowerCase());
        if (tag === "input" || tag === "textarea") {
          await loc.fill(action.text);
        } else {
          await page.keyboard.press("ControlOrMeta+A");
          await page.keyboard.type(action.text);
        }
        if (action.submit) {
          await page.keyboard.press("Enter");
          await this.settle();
        }
        return `Typed "${action.text}"${action.submit ? " and pressed Enter" : ""}`;
      }
      case "press":
        await page.keyboard.press(action.key);
        await this.settle();
        return `Pressed ${action.key}`;
      case "scroll": {
        const h = this.options.viewport.height;
        await page.evaluate(
          ([dir, step]) => {
            if (dir === "top") window.scrollTo({ top: 0, behavior: "instant" });
            else if (dir === "bottom") window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
            else window.scrollBy({ top: dir === "up" ? -step : step, behavior: "instant" });
          },
          [action.direction, Math.round(h * 0.75)] as const,
        );
        await page.waitForTimeout(150);
        return `Scrolled ${action.direction}`;
      }
      case "back":
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
        return "Went back";
      case "forward":
        await page.goForward({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
        return "Went forward";
      case "reload":
        await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
        return "Reloaded";
      case "stop":
        return "Stopped";
      case "none":
        return action.reason;
    }
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = this.context = this.page = null;
  }
}
