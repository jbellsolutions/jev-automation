/** Proves the Chrome bridge end to end without touching the user's own Chrome: launches a
 *  throwaway headful Chromium with dist/extension loaded, points it at the running companion
 *  (PORT, default 3111) with JEV_TOKEN, then sends one command and prints what happened.
 *  Usage: PORT=3111 node scripts/bridge-smoke.mjs ["open wikipedia and search for cats"] */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { WebSocket } from "ws";
import { loadEnvFile } from "../server/env.ts";

loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
const port = process.env.PORT ?? "3111";
const token = process.env.JEV_TOKEN ?? "";
const text = process.argv[2] ?? "open wikipedia and search for cats";
const ext = fileURLToPath(new URL("../dist/extension", import.meta.url));
const profile = mkdtempSync(path.join(tmpdir(), "jev-bridge-smoke-"));

const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  viewport: { width: 1100, height: 750 },
});
try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(worker.url()).host;
  console.log(`extension ${id} loaded`);
  // configure the bridge the way the options page would (the worker may be restarting: retry);
  // SMOKE_PAIRING=config skips this and relies on the config.json the build wrote
  for (let attempt = 0; process.env.SMOKE_PAIRING !== "config"; attempt++) {
    try {
      worker = context.serviceWorkers().find((w) => w.url().includes(id)) ?? worker;
      await worker.evaluate(async ({ url, token }) => chrome.storage.local.set({ url, token }), { url: `ws://127.0.0.1:${port}/ws/bridge`, token });
      break;
    } catch (err) {
      if (attempt >= 20) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://example.com/");

  // wait until the companion says chrome is the default surface
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${token}` };
  const t0 = Date.now();
  for (;;) {
    const r = await fetch(`${base}/api/sessions`, { headers }).then((r) => r.json()).catch(() => null);
    if (r?.default === "chrome") break;
    if (Date.now() - t0 > 20000) throw new Error(`bridge never connected: ${JSON.stringify(r)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`bridge connected after ${Date.now() - t0} ms; default surface = chrome`);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ type: "command", text, via: "text" }));
  const outcome = await new Promise((resolve) => {
    const seen = [];
    let total = 1;
    let step = 0;
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.type === "screenshot") return;
      seen.push(m);
      if (m.type === "steps") total = m.commands.length;
      if (m.type === "transcript_ack") step = m.step ? m.step.index + 1 : 1;
      // the last step's outcome (or a question) ends the run
      if (m.type === "status" && m.level !== "busy" && m.level !== "info" && step >= total) resolve(seen);
      if (m.type === "confirm" || m.type === "clarify") resolve(seen);
    });
    setTimeout(() => resolve(seen), 45000);
  });
  for (const m of outcome) console.log(JSON.stringify(m).slice(0, 160));
  console.log(`tab now: ${page.url()} — ${await page.title()}`);
  ws.close();
  // HOLD_MS keeps the throwaway Chrome up so another caller (Hermes via jev_browse) can act on it
  const hold = Number(process.env.HOLD_MS ?? 0);
  if (hold > 0) {
    console.log(`holding for ${hold} ms…`);
    await new Promise((r) => setTimeout(r, hold));
    const tab = context.pages().at(-1) ?? page;
    console.log(`tab after hold: ${tab.url()} — ${await tab.title().catch(() => "")}`);
  }
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
