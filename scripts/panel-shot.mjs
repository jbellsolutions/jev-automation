import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const pages = browser.contexts().flatMap((c) => c.pages());
const page = pages.find((p) => p.url().includes("127.0.0.1:3111")) ?? pages[0];
console.log("pages:", pages.map((p) => p.url()));
const info = await page.evaluate(() => ({
  title: document.title,
  desktop: document.body.classList.contains("desktop"),
  pill: document.querySelector("#jev-pill")?.textContent,
  micLabel: document.querySelector(".mic-label")?.textContent,
  note: document.querySelector(".note")?.textContent ?? null,
  status: document.querySelector("#status")?.textContent,
  size: [innerWidth, innerHeight],
  hasBridge: typeof window.jev,
  autoListen: window.jev?.autoListen,
}));
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: process.argv[2] });
await browser.close();
