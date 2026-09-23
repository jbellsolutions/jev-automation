// Attacks a Jev executor attached to a real Steel browser: every private-network route a page
// or a click can take must be refused, and ordinary browsing must still work. Deterministic —
// it drives the executor directly, no Jev decisions. Needs Steel on CDP_URL (default below).
//   npx tsx scripts/steel-shield-check.ts
// JEV_SHIELD=off turns this executor's own guard off, to prove that a browser-wide guard
// (browser-box's gateway) refuses every case on its own. GUARD_SETTLE_MS then gives that guard
// time to reattach after the Steel relaunches this script causes; the gateway itself holds its
// lane until it has.
import { chromium } from "playwright";
import { PlaywrightExecutor, dialable } from "../server/executors/playwright.js";

const cdp = process.env.CDP_URL ?? "ws://127.0.0.1:3000/";

const ex = new PlaywrightExecutor({
  headless: true,
  startUrl: "about:blank",
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  jpegQuality: 60,
  cdpUrl: cdp,
  blockPrivateNetwork: process.env.JEV_SHIELD !== "off",
});

const results: { name: string; pass: boolean; detail: string }[] = [];
const page = () => (ex as unknown as { page: import("playwright").Page }).page;

async function nav(url: string): Promise<string> {
  try {
    return await ex.execute({ kind: "navigate", url });
  } catch (err) {
    return `THREW ${err instanceof Error ? err.message.split("\n")[0] : err}`;
  }
}

async function bodyText(): Promise<string> {
  try {
    return (await page().evaluate(() => document.body?.innerText ?? "")).slice(0, 200);
  } catch (e) {
    return `evaluate failed: ${e instanceof Error ? e.message.split("\n")[0] : e}`;
  }
}

async function blockedCase(name: string, url: string) {
  const before = ex.blocked.length;
  const t0 = Date.now();
  const out = await nav(url);
  await page().waitForTimeout(500);
  const text = await bodyText();
  const landed = page().url();
  const leaked = /"sessions"|websocketUrl|inspector/.test(text);
  const pass = !leaked && !/127\.0\.0\.1|169\.254|gateway:8080/.test(landed);
  results.push({ name, pass, detail: `${Date.now() - t0}ms out=${out.slice(0, 90)} | landed=${landed} | newBlocks=${ex.blocked.slice(before).join(" ; ").slice(0, 160)} | text=${JSON.stringify(text.slice(0, 80))}` });
}

async function allowedCase(name: string, url: string, expectHost: RegExp) {
  const t0 = Date.now();
  const out = await nav(url);
  const landed = page().url();
  const pass = expectHost.test(landed) && !out.startsWith("THREW");
  results.push({ name, pass, detail: `${Date.now() - t0}ms out=${out.slice(0, 90)} | landed=${landed}` });
}

const steel = process.env.STEEL_URL ?? "http://127.0.0.1:3000";
const settle = () => new Promise((r) => setTimeout(r, Number(process.env.GUARD_SETTLE_MS ?? 0)));
// Start from a fresh Chromium: creating and releasing a session relaunches it, dropping tabs
// that earlier runs left behind (an attached close() never closes tabs).
{
  const s = (await (await fetch(`${steel}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as { id: string };
  await fetch(`${steel}/v1/sessions/${s.id}/release`, { method: "POST" });
  await settle();
}
await ex.start();
console.log("attached; start url:", page().url());

// Paths the Fetch interceptor may not see. Chromium's own Local Network Access check is expected
// to stop these; the point is that nothing reaches Steel, whichever layer stops it. Runs first,
// in one worker: under Steel only the first dedicated worker of a CDP connection gets network,
// later ones hang even with no guard at all (bare Playwright client, 2026-09-23).
{
  await nav("https://example.com");
  const got = (await page().evaluate(`(async () => {
    const ws = await new Promise((res) => {
      const s = new WebSocket("ws://127.0.0.1:3000/");
      s.onopen = () => { s.close(); res("OPEN"); }; s.onerror = () => res("error"); setTimeout(() => res("timeout"), 4000);
    });
    const code = "fetch('https://example.com/', { mode: 'no-cors' }).then(() => 'sent', () => 'failed')" +
      ".then(pub => fetch('http://127.0.0.1:3000/v1/sessions').then(r => r.text()).then(t => 'READ ' + t.slice(0, 40), () => 'failed')" +
      ".then(loop => postMessage({ pub, loop })))";
    const worker = await new Promise((res) => {
      const w = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
      w.onmessage = (m) => res(m.data); w.onerror = () => res({ pub: "worker error" }); setTimeout(() => res({ pub: "timeout" }), 8000);
    });
    return { ws, worker };
  })()`)) as { ws: string; worker: { pub: string; loop?: string } };
  results.push({ name: "WebSocket to Steel's CDP proxy", pass: got.ws !== "OPEN", detail: got.ws });
  results.push({ name: "worker fetch to loopback (and the worker's own network works)", pass: got.worker.pub === "sent" && got.worker.loop !== undefined && !got.worker.loop.startsWith("READ"), detail: JSON.stringify(got.worker) });
}

await blockedCase("redirect → Steel API (the proven exploit)", "https://httpbin.org/redirect-to?url=http%3A%2F%2F127.0.0.1%3A3000%2Fv1%2Fsessions");
await blockedCase("redirect → metadata", "https://httpbin.org/redirect-to?url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F");
await blockedCase("direct loopback", "http://127.0.0.1:3000/v1/sessions");
await blockedCase("obfuscated loopback", "http://0x7f000001:3000/v1/sessions");
await blockedCase("compose service name", "http://gateway:8080/mcp");
await allowedCase("http://github.com still works", "http://github.com", /^https:\/\/github\.com/);
await allowedCase("example.com", "https://example.com", /example\.com/);

// A click on the page, the thing Jev actually does.
{
  const t0 = Date.now();
  let out: string;
  try {
    await page().getByRole("link", { name: /learn more/i }).click({ timeout: 5000 });
    await page().waitForLoadState("domcontentloaded", { timeout: 10000 });
    out = "clicked";
  } catch (e) {
    out = `THREW ${e instanceof Error ? e.message.split("\n")[0] : e}`;
  }
  results.push({ name: "click Learn more", pass: /iana\.org/.test(page().url()), detail: `${Date.now() - t0}ms ${out} | landed=${page().url()}` });
}

// A sub-resource from a public page.
{
  await nav("https://example.com");
  const before = ex.blocked.length;
  const got = await page()
    .evaluate(async () => {
      try {
        const r = await fetch("http://127.0.0.1:3000/v1/sessions");
        return `fetched ${r.status} ${(await r.text()).slice(0, 60)}`;
      } catch (e) {
        return `fetch failed: ${e}`;
      }
    })
    .catch((e) => `evaluate threw ${e}`);
  results.push({ name: "page fetch() to loopback", pass: got.startsWith("fetch failed"), detail: `${got} | blocks=${ex.blocked.slice(before).join(" ; ").slice(0, 120)}` });
}

// A popup that redirects inward: it starts loading before its own interceptor is up.
{
  const before = ex.blocked.length;
  await page().evaluate(() => {
    window.open("https://httpbin.org/redirect-to?url=http%3A%2F%2F127.0.0.1%3A3000%2Fv1%2Fsessions", "_blank");
  });
  await page().waitForTimeout(3000);
  const text = await bodyText();
  results.push({ name: "popup redirect → Steel API", pass: !/"sessions"|websocketUrl/.test(text), detail: `active=${page().url()} | text=${JSON.stringify(text.slice(0, 80))} | blocks=${ex.blocked.slice(before).join(" ; ").slice(0, 160)}` });
}

// Steel relaunches Chromium when a session is created, which drops every CDP client. The
// executor must come back on its own — shielded before its first navigation — and a burst of
// commands during the reattach must share one attach, not open a tab each.
{
  const attach = (ex as unknown as { attach: (u: string) => Promise<void> }).attach.bind(ex);
  let attaches = 0;
  (ex as unknown as { attach: (u: string) => Promise<void> }).attach = (u) => (attaches++, attach(u));
  const created = (await (await fetch(`${steel}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as { id: string };
  await new Promise((r) => setTimeout(r, 1500));
  await settle();
  const t0 = Date.now();
  await Promise.all([ex.snapshot(), ex.snapshot(), ex.snapshot()]);
  results.push({ name: "reattach after Steel relaunch, one tab for a burst", pass: attaches === 1, detail: `${Date.now() - t0}ms, ${attaches} attach(es), now on ${page().url()}` });
  await blockedCase("redirect → Steel API, after reattach", "https://httpbin.org/redirect-to?url=http%3A%2F%2F127.0.0.1%3A3000%2Fv1%2Fsessions");
  await allowedCase("example.com, after reattach", "https://example.com", /example\.com/);
  await fetch(`${steel}/v1/sessions/${created.id}/release`, { method: "POST" });
  await settle();
}

// The default context is shared with every other client of this browser. Their tabs are not
// ours: never switched to, never closed. Ours all go when the executor closes, or each restart
// would leave one behind in a memory-capped browser.
{
  await ex.snapshot(); // reattach: the release above relaunched Chromium too
  await nav("https://example.com");
  const other = await chromium.connectOverCDP(await dialable(cdp));
  const ctx = other.contexts()[0]!;
  const mine = page();
  const theirs = await ctx.newPage();
  await theirs.goto("https://example.com").catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  results.push({ name: "another client's tab is never adopted", pass: page() === mine, detail: `active=${page().url()}` });
  const before = ctx.pages().length;
  await ex.close();
  await new Promise((r) => setTimeout(r, 1000));
  const after = ctx.pages().length;
  results.push({ name: "close() takes our tab and leaves theirs", pass: after === before - 1 && !theirs.isClosed(), detail: `${before} → ${after} tabs, theirs still open: ${!theirs.isClosed()}` });
  await theirs.close().catch(() => {});
  await other.close();
}

for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}`);
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed`);
await ex.close();
process.exit(results.every((r) => r.pass) ? 0 : 1);
