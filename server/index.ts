/** CLI entry: a companion with the Playwright executor, serving the web client. */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDecider } from "../core/decide.js";
import { createCompanion } from "./companion.js";
import { selectComputer } from "./computer.js";
import { FrontExecutor } from "./executors/front.js";
import { selectMac } from "./executors/mac.js";
import { PlaywrightExecutor } from "./executors/playwright.js";
import { RemoteExecutor } from "./executors/remote.js";
import { createBrain } from "./hermes.js";
import { describeSpeaker, selectSpeaker } from "./speak/select.js";
import { selectSttProvider } from "./stt/select.js";

const PORT = Number(process.env.PORT ?? 3000);
const HEADLESS = (process.env.HEADLESS ?? "true").toLowerCase() !== "false";
const VIEWPORT = { width: 1280, height: 800 };
const DEVICE_SCALE_FACTOR = Number(process.env.DEVICE_SCALE_FACTOR ?? 2);
const JPEG_QUALITY = Number(process.env.JPEG_QUALITY ?? 80);

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "client");

const decider = createDecider();
const stt = selectSttProvider();
const speaker = selectSpeaker();
const brain = createBrain();
const computer = selectComputer();
const bridge = new RemoteExecutor({
  onReady: (ready) => {
    console.log(ready ? "Chrome: bridge connected — acting in your Chrome" : "Chrome: bridge disconnected — back to the built-in browser");
    companion.hub.followDefault();
  },
});
const companion = createCompanion({
  decider,
  token: process.env.JEV_TOKEN,
  clientDir,
  defaultSession: process.env.JEV_DEFAULT_SESSION,
  stt,
  speaker,
  brain,
  computer,
  bridge,
});
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

const mac = selectMac();
const front = mac ? new FrontExecutor({ mac, chrome: bridge, fallback: playwright }) : null;

async function main(): Promise<void> {
  const port = await companion.listen(PORT);
  if (front) companion.register(front);
  companion.register(bridge);
  companion.register(playwright);
  await playwright.start();
  if (front) await front.start();
  console.log(front ? (mac!.ready ? "Mac: cua-driver ready — acting in the app in front" : "Mac: cua-driver not answering — Mac apps off (run hermes computer-use doctor)") : "Mac: off");
  console.log(`Jev voice browser → http://localhost:${port}${existsSync(path.join(clientDir, "index.html")) ? "" : "  (client not built: npm run build)"}`);
  console.log(decider.enabled ? `Decisions: TypeSafe Jev (${decider.model})` : "Decisions: keyword heuristics (set TYPESAFE_API_KEY to use Jev)");
  console.log(companion.auth.configured ? "API: bearer token required (JEV_TOKEN)" : "API: disabled — set JEV_TOKEN to enable /api and the MCP server");
  console.log(stt ? `Voice in: streaming via ${stt.name}` : "Voice in: browser Web Speech (set DEEPGRAM_API_KEY or run npm run build:native for streaming transcription)");
  console.log(`Voice out: ${describeSpeaker(speaker)}`);
  console.log(companion.auth.configured ? "Chrome: waiting for the bridge extension (load dist/extension unpacked; token = JEV_TOKEN)" : "Chrome: bridge disabled — set JEV_TOKEN");
  if (brain) {
    const h = await brain.health();
    console.log(h.ok ? `Brain: Hermes (${h.detail}) at ${process.env.HERMES_API_URL ?? "http://127.0.0.1:8642"}` : `Brain: Hermes configured but not reachable — ${h.detail}`);
  } else console.log("Brain: none (set HERMES_API_KEY to route questions and tasks to Hermes)");
  console.log(computer ? "Computer: open apps via open -a" : "Computer: off");
}

const shutdown = async () => {
  await companion.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
