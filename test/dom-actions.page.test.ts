import { build } from "esbuild";
import { type Browser, type Page, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Action } from "../core/actions.js";
import { extractElements } from "../core/elements.js";

/** The bridge's in-page half, bundled the way the extension bundles it, run in real Chromium. */
let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const out = await build({ entryPoints: ["extension/dom-actions.ts"], bundle: true, write: false, format: "iife", globalName: "jevDom", platform: "browser", target: "chrome120" });
  bundle = out.outputFiles[0]!.text;
  browser = await chromium.launch();
}, 30000);
afterAll(async () => {
  await browser?.close();
});

async function load(html: string): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
  await page.addScriptTag({ content: bundle });
  await extractElements(page); // writes data-jev-id
  return page;
}
const perform = (page: Page, action: Action) => page.evaluate((a) => (window as unknown as { jevDom: { performInPage: (a: Action) => string } }).jevDom.performInPage(a), action);

describe("dom-actions in Chromium", () => {
  it("clicks by element id with a real pointer sequence, and reports a stale id", async () => {
    const page = await load(`<button id="b" onclick="window.hits=(window.hits||0)+1">Go</button><a href="#there" id="l">There</a>`);
    const els = await extractElements(page);
    const button = els.find((e) => e.text === "Go")!;
    expect(await perform(page, { kind: "click", elementId: button.id, label: "Go" })).toBe("Clicked Go");
    expect(await page.evaluate(() => (window as unknown as { hits: number }).hits)).toBe(1);
    await expect(perform(page, { kind: "click", elementId: "e99", label: "Nope" })).rejects.toThrow("Nope is no longer on the page");
    await expect(perform(page, { kind: "click", elementId: "bad", label: "x" })).rejects.toThrow("Bad element id");
    await page.close();
  });

  it("types into inputs through the native setter so framework listeners see it, and submits forms on Enter", async () => {
    const page = await load(`
      <form id="f" onsubmit="event.preventDefault(); window.submitted = document.getElementById('q').value">
        <input id="q" name="q" placeholder="Search">
      </form>
      <script>document.getElementById('q').addEventListener('input', e => window.seen = e.target.value)</script>
    `);
    const els = await extractElements(page);
    const field = els.find((e) => e.placeholder === "Search")!;
    expect(await perform(page, { kind: "type", elementId: field.id, label: "Search", text: "lofi beats", submit: true })).toBe('Typed "lofi beats" and pressed Enter');
    expect(await page.evaluate(() => (window as unknown as { seen: string; submitted: string }).seen)).toBe("lofi beats");
    expect(await page.evaluate(() => (window as unknown as { submitted: string }).submitted)).toBe("lofi beats");
    // no element id: the first visible field
    expect(await perform(page, { kind: "type", elementId: null, label: null, text: "again", submit: false })).toBe('Typed "again"');
    expect(await page.inputValue("#q")).toBe("again");
    await page.close();
  });

  it("types into a rich editor (contenteditable) and its input event fires", async () => {
    const page = await load(`<div id="ed" contenteditable="true" role="textbox" aria-label="Message">old</div>
      <script>document.getElementById('ed').addEventListener('input', () => window.edited = document.getElementById('ed').textContent)</script>`);
    const els = await extractElements(page);
    const editor = els.find((e) => e.label === "Message")!;
    await perform(page, { kind: "type", elementId: editor.id, label: "Message", text: "hi Xander, the intro video is approved", submit: false });
    expect(await page.textContent("#ed")).toBe("hi Xander, the intro video is approved");
    expect(await page.evaluate(() => (window as unknown as { edited: string }).edited)).toBe("hi Xander, the intro video is approved");
    await page.close();
  });

  it("presses keys the page's handlers can see, and scrolls", async () => {
    const page = await load(`<textarea id="t"></textarea><div style="height:5000px"></div>
      <script>document.addEventListener('keydown', e => { if (e.key === 'Enter') window.enter = (window.enter||0)+1 })</script>`);
    await page.focus("#t");
    expect(await perform(page, { kind: "press", key: "Enter" })).toBe("Pressed Enter");
    expect(await page.evaluate(() => (window as unknown as { enter: number }).enter)).toBe(1);
    await perform(page, { kind: "scroll", direction: "down" });
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
    await perform(page, { kind: "scroll", direction: "top" });
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(perform(page, { kind: "type", elementId: null, label: null, text: "x", submit: false })).resolves.toBe('Typed "x"');
    await page.close();
  });

  it("refuses non-page actions and an empty page for typing", async () => {
    const page = await load(`<p>nothing here</p>`);
    await expect(perform(page, { kind: "navigate", url: "https://a.com" })).rejects.toThrow("navigate is not a page action");
    await expect(perform(page, { kind: "type", elementId: null, label: null, text: "x", submit: false })).rejects.toThrow("There's no text field");
    await page.close();
  });
});
