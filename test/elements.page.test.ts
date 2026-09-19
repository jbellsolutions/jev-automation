import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeElement, extractElements } from "../core/elements.js";

/** Runs the real in-page script in headless Chromium against small HTML fixtures. */
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 30000);
afterAll(async () => {
  await browser?.close();
});

async function extractFrom(html: string) {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
  const out = await extractElements(page);
  await page.close();
  return out;
}

describe("PAGE_SCRIPT in a real DOM", () => {
  it("reads the value of <input type=submit|button|reset> as its text (Hacker News 'add comment')", async () => {
    const els = await extractFrom(`
      <textarea name="text"></textarea>
      <input type="submit" value="add comment">
      <input type="button" value="Cancel">
      <input type="reset" value="Clear">
    `);
    const byName = Object.fromEntries(els.map((e) => [describeElement(e), e]));
    expect(Object.keys(byName)).toEqual(expect.arrayContaining(['button "add comment"', 'button "Cancel"', 'button "Clear"', 'text area "text"']));
    expect(els.find((e) => e.type === "submit")?.text).toBe("add comment");
  }, 15000);

  it("keeps unlabeled submit/reset inputs with their default caption and never drops a button input", async () => {
    const els = await extractFrom(`
      <input type="submit">
      <input type="reset">
      <input type="button" aria-label="Go">
      <input type="image" alt="Search" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="20" height="20">
    `);
    const descs = els.map(describeElement);
    expect(descs).toEqual(expect.arrayContaining(['button "Submit"', 'button "Reset"', 'button "Go"', 'button "Search"']));
    expect(els).toHaveLength(4);
  }, 15000);

  it("still leaves text empty for real fields and keeps placeholder/label", async () => {
    const els = await extractFrom(`
      <label for="q">Search</label><input id="q" type="search" placeholder="Search the site">
      <button>Go</button>
    `);
    const search = els.find((e) => e.type === "search")!;
    expect(search.text).toBe("");
    expect(search.label).toBe("Search");
    expect(search.placeholder).toBe("Search the site");
    expect(els.find((e) => e.tag === "button")?.text).toBe("Go");
  }, 15000);
});
