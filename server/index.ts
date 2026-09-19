import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { createDecider } from "../core/decide.js";
import type { ClientMessage } from "../core/protocol.js";
import { demoPage } from "./demo.js";
import { PlaywrightExecutor } from "./executors/playwright.js";
import { Hub } from "./hub.js";

const PORT = Number(process.env.PORT ?? 3000);
const HEADLESS = (process.env.HEADLESS ?? "true").toLowerCase() !== "false";
const VIEWPORT = { width: 1280, height: 800 };
const DEVICE_SCALE_FACTOR = Number(process.env.DEVICE_SCALE_FACTOR ?? 2);
const JPEG_QUALITY = Number(process.env.JPEG_QUALITY ?? 80);
const SCREENSHOT_INTERVAL_MS = 700;

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "client");

const app = express();
app.use(express.static(clientDir));
app.get("/", (_req, res, next) => {
  if (existsSync(path.join(clientDir, "index.html"))) return next();
  res.status(503).type("text").send("Client not built. Run `npm run build` (or `npm run dev` for the Vite dev server on :5173).");
});
app.get("/demo", (req, res) => {
  res.type("html").send(demoPage(String(req.query.page ?? "home")));
});

const decider = createDecider();
const hub = new Hub({ decider, screenshotIntervalMs: SCREENSHOT_INTERVAL_MS, defaultSession: process.env.JEV_DEFAULT_SESSION });
const playwright = new PlaywrightExecutor({
  headless: HEADLESS,
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
  args: (process.env.CHROMIUM_ARGS ?? "").split(/\s+/).filter(Boolean),
  startUrl: process.env.START_URL ?? "https://www.google.com",
  fallbackUrl: `http://localhost:${PORT}/demo`,
  viewport: { ...VIEWPORT },
  deviceScaleFactor: DEVICE_SCALE_FACTOR,
  jpegQuality: JPEG_QUALITY,
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, jev: { enabled: decider.enabled, model: decider.model }, url: playwright.url });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  const defaultId = hub.defaultId;
  if (!defaultId || !hub.attach(ws, defaultId)) {
    ws.close(1013, "no session available");
    return;
  }
  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      return;
    }
    const session = hub.sessionFor(ws);
    if (!session) return;
    switch (msg.type) {
      case "command":
        if (typeof msg.text === "string") void session.command(msg.text);
        break;
      case "confirm_reply":
        void session.reply(!!msg.ok);
        break;
      case "pick":
        void session.pick(String(msg.elementId));
        break;
      case "click_at":
        void session.clickAt(Number(msg.fx), Number(msg.fy));
        break;
      case "viewport":
        void session.setViewport(Number(msg.width), Number(msg.height));
        break;
      case "screenshot_request":
        hub.requestFrame(ws);
        break;
    }
  });
  ws.on("close", () => hub.detach(ws));
});

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  hub.register(playwright);
  await playwright.start();
  console.log(`Jev voice browser → http://localhost:${PORT}${existsSync(path.join(clientDir, "index.html")) ? "" : "  (client not built: npm run build)"}`);
  console.log(decider.enabled ? `Decisions: TypeSafe Jev (${decider.model})` : "Decisions: keyword heuristics (set TYPESAFE_API_KEY to use Jev)");
}

const shutdown = async () => {
  await hub.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
