// Attacks a Jev executor attached to a real Steel browser: every private-network route a page
// or a click can take must be refused, and ordinary browsing must still work. Deterministic —
// it drives the executor directly, no Jev decisions. Needs Steel on CDP_URL (default below).
//   npx tsx scripts/steel-shield-check.ts
import { PlaywrightExecutor } from "../server/executors/playwright.js";

const ex = new PlaywrightExecutor({
  headless: true,
  startUrl: "about:blank",
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  jpegQuality: 60,
  cdpUrl: process.env.CDP_URL ?? "ws://127.0.0.1:3000/",
  blockPrivateNetwork: true,
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

await ex.start();
console.log("attached; start url:", page().url());

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

// Sub-resource from a public page, and a popup that redirects inward.
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
{
  const before = ex.blocked.length;
  await page().evaluate(() => {
    window.open("https://httpbin.org/redirect-to?url=http%3A%2F%2F127.0.0.1%3A3000%2Fv1%2Fsessions", "_blank");
  });
  await page().waitForTimeout(3000);
  const text = await bodyText();
  results.push({ name: "popup redirect → Steel API", pass: !/"sessions"|websocketUrl/.test(text), detail: `active=${page().url()} | text=${JSON.stringify(text.slice(0, 80))} | blocks=${ex.blocked.slice(before).join(" ; ").slice(0, 160)}` });
}

for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}`);
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed`);
await ex.close();
process.exit(results.every((r) => r.pass) ? 0 : 1);
