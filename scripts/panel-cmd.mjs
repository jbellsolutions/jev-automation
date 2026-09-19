/** Type a command into the running desktop panel (needs `electron . --remote-debugging-port=9223`)
 *  and print the log entries it produced. Usage: node scripts/panel-cmd.mjs "open wikipedia" out.png */
import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("3111"));
await page.fill("#text-input", process.argv[2]);
await page.press("#text-input", "Enter");
const still = await page.inputValue("#text-input");
console.log("input after submit:", JSON.stringify(still));
await page.waitForTimeout(7000);
const entries = await page.$$eval(".entry", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()).slice(0, 3));
console.log(JSON.stringify(entries, null, 1));
await page.screenshot({ path: process.argv[3] });
await browser.close();
