import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { type Browser, type BrowserContext, type Page, chromium } from "playwright";
import type { Action } from "../../core/actions.js";
import { type PageSnapshot, extractElements } from "../../core/elements.js";
import type { Executor, ExecutorCapabilities } from "../../core/executor.js";
import { createGuard } from "../../core/scope.js";

export interface PlaywrightOptions {
  headless: boolean;
  executablePath?: string;
  /** Extra Chromium command-line switches (e.g. proxy or trust settings). */
  args?: string[];
  startUrl: string;
  /** Local page to show when the start URL cannot be reached (offline, blocked). */
  fallbackUrl?: string;
  viewport: { width: number; height: number };
  /** Device pixels per CSS pixel for screenshots; 2 keeps text crisp on HiDPI displays. */
  deviceScaleFactor: number;
  /** JPEG quality of the streamed frames (1–100). */
  jpegQuality: number;
  /** Attach to an already-running Chromium over CDP (e.g. a Steel browser server) instead of
   *  launching one. That browser is not ours: we open our own tab in its default context, so
   *  its cookies and profile apply, and close() only closes that tab and disconnects. */
  cdpUrl?: string;
  /** Refuse every request that is not the public web — loopback, private ranges, link-local,
   *  cloud metadata, and names that resolve to any of those. For a browser on a server next to
   *  other services. Off by default: a desktop companion legitimately opens localhost pages. */
  blockPrivateNetwork?: boolean;
}

export const VIEWPORT_LIMITS = { minWidth: 640, maxWidth: 1920, minHeight: 400, maxHeight: 1200 };

/** Chromium's DevTools endpoint refuses a Host header that is neither an IP address nor
 *  localhost (its DNS-rebinding guard), and Steel passes ours through. So a compose service name
 *  like ws://steel:3000/ is dialled by its address, looked up afresh on every attach. */
async function dialable(cdpUrl: string): Promise<string> {
  const url = new URL(cdpUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) || host === "localhost") return cdpUrl;
  const { address, family } = await lookup(host);
  url.hostname = family === 6 ? `[${address}]` : address;
  return url.toString();
}

/** One Chromium controlled through Playwright. Single-user by design: one page at a
 *  time, switching to popups/new tabs automatically so "open in new tab" links work. */
export class PlaywrightExecutor implements Executor {
  readonly id: string;
  readonly kind = "playwright" as const;
  readonly capabilities: ExecutorCapabilities = { screenshot: true, viewport: true, clickAt: true };
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private changeListeners = new Set<() => void>();
  /** Dialogs seen since the last snapshot; drained by snapshot(). */
  private dialogs: string[] = [];
  private readonly adopted = new WeakSet<Page>();
  private closing = false;
  /** True when attached over CDP: the browser belongs to someone else and must outlive us. */
  private attached = false;

  constructor(readonly options: PlaywrightOptions, id = "playwright") {
    this.id = id;
  }

  async start(): Promise<void> {
    if (this.options.cdpUrl) await this.ensureAttached();
    else await this.launch();
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
    // the context's "page" event also fires for pages we created ourselves
    if (this.adopted.has(p)) return;
    this.adopted.add(p);
    void this.shield(p).catch(() => {});
    const notify = () => this.emitChange();
    p.on("load", notify);
    p.on("domcontentloaded", notify);
    p.on("framenavigated", (f) => f === p.mainFrame() && notify());
    // Alerts vanish without a trace in the DOM; record them so verification can see the effect.
    // Accept alerts and beforeunload; cancel confirm/prompt, the safe default for "are you sure?".
    p.on("dialog", (d) => {
      this.dialogs.push(`${d.type()}: ${d.message()}`);
      void (d.type() === "alert" || d.type() === "beforeunload" ? d.accept() : d.dismiss()).catch(() => {});
      notify();
    });
    p.on("close", () => {
      if (this.page !== p || this.closing) return;
      const rest = this.context?.pages().filter((x) => !x.isClosed()) ?? [];
      const next = rest[rest.length - 1];
      if (next) this.page = next;
      else void this.context?.newPage().then((np) => this.adopt(np)).catch(() => {});
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

  private async launch(): Promise<void> {
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
    this.context = await this.browser.newContext({ viewport: this.options.viewport, deviceScaleFactor: this.options.deviceScaleFactor });
    this.context.on("page", (p) => this.adopt(p));
    const page = await this.context.newPage();
    await this.shield(page);
    this.adopt(page);
  }

  /** The one attach in flight, shared by start() and every reconnect, so a command that
   *  arrives mid-attach waits for it instead of opening a second tab. */
  private connecting: Promise<void> | null = null;

  /** Attached, the browser can vanish under us: Steel relaunches Chromium whenever a session
   *  is created or released, dropping every CDP client (verified 2026-09-23). Reattach on the
   *  next use rather than failing every command from then on. The new tab starts blank. */
  private async ensureAttached(): Promise<void> {
    const cdpUrl = this.options.cdpUrl;
    if (!cdpUrl || this.closing) return;
    if (this.connecting) return this.connecting;
    if (this.browser?.isConnected()) return;
    if (this.browser) console.warn(`lost the browser at ${cdpUrl} (it was restarted); reattaching`);
    this.connecting = (async () => {
      try {
        await this.attach(cdpUrl);
      } catch {
        // a relaunch takes a moment; one more try before the command fails
        await new Promise((r) => setTimeout(r, 1500));
        await this.attach(cdpUrl);
      }
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /** Drive a browser someone else runs. One Chromium on the host instead of two is the whole
   *  point: a second resident browser is what OOM-killed a 2 GB box before. */
  private async attach(cdpUrl: string): Promise<void> {
    try {
      this.browser = await chromium.connectOverCDP(await dialable(cdpUrl));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not attach to the browser at ${cdpUrl}. Is it running?\n${msg}`);
    }
    this.attached = true;
    // The default context carries the remote session's cookies and profile; a fresh context
    // would throw those away, and with them any login done through that session.
    this.context = this.browser.contexts()[0] ?? (await this.browser.newContext());
    this.context.on("page", (p) => this.adopt(p));
    // Our own tab, so other clients of the same browser (a REST scrape) never share it.
    const page = await this.context.newPage();
    await page.setViewportSize(this.options.viewport);
    await this.shield(page); // before its first navigation, so nothing can race it
    this.adopt(page);
  }

  /** Requests this guard refused, newest last; surfaced so a blocked click is explained. */
  readonly blocked: string[] = [];

  /** Guard each page with its own CDP Fetch interceptor, and why not Playwright's route():
   *  route() lets redirect hops through without consulting its handler, so a public URL that
   *  302s to 127.0.0.1 walked straight past it and read Steel's own session list (verified
   *  2026-09-23). Chrome's Fetch domain pauses EVERY hop, redirects included. */
  private readonly shielded = new WeakSet<Page>();
  private check: ReturnType<typeof createGuard> | null = null;

  private noteBlocked(url: string, reason?: string): void {
    this.blocked.push(`${url} — ${reason ?? "not the public web"}`);
    if (this.blocked.length > 20) this.blocked.shift();
  }

  private async shield(p: Page): Promise<void> {
    if (!this.options.blockPrivateNetwork || !this.context || this.shielded.has(p)) return;
    this.shielded.add(p);
    const check = (this.check ??= createGuard());
    const cdp = await this.context.newCDPSession(p);
    cdp.on("Fetch.requestPaused", (e) => {
      void check(e.request.url)
        .then((verdict) => {
          if (verdict.allowed) return cdp.send("Fetch.continueRequest", { requestId: e.requestId });
          this.noteBlocked(e.request.url, verdict.reason);
          return cdp.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "BlockedByClient" });
        })
        .catch(() => {});
    });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    // Backstop for the one race left: a popup can start loading before its interceptor is up.
    // A main frame that lands anywhere private is taken off it at once, so nothing it shows is
    // ever read back through this executor.
    p.on("framenavigated", (f) => {
      if (f !== p.mainFrame()) return;
      const url = f.url();
      if (!/^https?:/i.test(url)) return;
      void check(url).then((verdict) => {
        if (verdict.allowed) return;
        this.noteBlocked(url, verdict.reason);
        void p.goto("about:blank").catch(() => {});
      });
    });
  }

  private get active(): Page {
    if (!this.page || this.page.isClosed()) throw new Error("Browser page is not available");
    return this.page;
  }

  get viewport(): { width: number; height: number } {
    return this.options.viewport;
  }

  /** Resize the page to match the space the UI has, so frames are never scaled in CSS. */
  async setViewport(width: number, height: number): Promise<boolean> {
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
    const next = {
      width: clamp(width, VIEWPORT_LIMITS.minWidth, VIEWPORT_LIMITS.maxWidth),
      height: clamp(height, VIEWPORT_LIMITS.minHeight, VIEWPORT_LIMITS.maxHeight),
    };
    if (next.width === this.options.viewport.width && next.height === this.options.viewport.height) return false;
    this.options.viewport = next;
    await this.active.setViewportSize(next);
    return true;
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
    await this.ensureAttached();
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
    const snapshot: PageSnapshot = { url: page.url(), title: await this.title(), elements };
    if (this.dialogs.length > 0) {
      snapshot.dialogs = this.dialogs;
      this.dialogs = [];
    }
    return snapshot;
  }

  /** Suffix for a status line when the action popped a dialog. */
  private dialogNote(): string {
    return this.dialogs.length ? ` — ${this.dialogs.map((d) => d.replace(/^(\w+): (.*)$/, '$1 "$2"')).join(", ")}` : "";
  }

  async screenshot(): Promise<Buffer | null> {
    try {
      await this.ensureAttached();
      return await this.active.screenshot({ type: "jpeg", quality: this.options.jpegQuality, timeout: 3000 });
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
    await this.ensureAttached();
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
        return `Clicked ${action.label}${this.dialogNote()}`;
      }
      case "click_at":
        await page.mouse.click(action.x, action.y);
        await this.settle();
        return `Clicked at (${action.x}, ${action.y})${this.dialogNote()}`;
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
        return `Typed "${action.text}"${action.submit ? " and pressed Enter" : ""}${this.dialogNote()}`;
      }
      case "press":
        await page.keyboard.press(action.key);
        await this.settle();
        return `Pressed ${action.key}${this.dialogNote()}`;
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
      case "open_app":
        throw new Error(`The browser can't open ${action.app}`);
      case "open_path":
        throw new Error(`The browser can't open files (${action.query})`);
      case "none":
        return action.reason;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    // Attached: never close tabs, only disconnect. Closing a tab mid-navigation makes Steel's
    // instrumentation reject unhandled, which kills the whole Steel server unless it runs with
    // --unhandled-rejections=warn (reproduced 4/5, 2026-09-23). For a connected browser,
    // Playwright's close() only clears contexts WE created and disconnects.
    await this.browser?.close().catch(() => {});
    this.browser = this.context = this.page = null;
  }
}
