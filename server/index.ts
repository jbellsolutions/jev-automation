/** CLI entry: a companion with the Playwright executor, serving the web client. */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDecider } from "../core/decide.js";
import { createCompanion } from "./companion.js";
import { PlaywrightExecutor } from "./executors/playwright.js";
import { selectSttProvider } from "./stt/select.js";

const PORT = Number(process.env.PORT ?? 3000);
const HEADLESS = (process.env.HEADLESS ?? "true").toLowerCase() !== "false";
const VIEWPORT = { width: 1280, height: 800 };
const DEVICE_SCALE_FACTOR = Number(process.env.DEVICE_SCALE_FACTOR ?? 2);
const JPEG_QUALITY = Number(process.env.JPEG_QUALITY ?? 80);

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "client");

const decider = createDecider();
const stt = selectSttProvider();
const companion = createCompanion({
  decider,
  token: process.env.JEV_TOKEN,
  clientDir,
  defaultSession: process.env.JEV_DEFAULT_SESSION,
  stt,
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

async function main(): Promise<void> {
  const port = await companion.listen(PORT);
  companion.register(playwright);
  await playwright.start();
  console.log(`Jev voice browser → http://localhost:${port}${existsSync(path.join(clientDir, "index.html")) ? "" : "  (client not built: npm run build)"}`);
  console.log(decider.enabled ? `Decisions: TypeSafe Jev (${decider.model})` : "Decisions: keyword heuristics (set TYPESAFE_API_KEY to use Jev)");
  console.log(companion.auth.configured ? "API: bearer token required (JEV_TOKEN)" : "API: disabled — set JEV_TOKEN to enable /api and the MCP server");
  console.log(stt ? `Voice: streaming via ${stt.name}` : "Voice: browser Web Speech (set DEEPGRAM_API_KEY for streaming transcription)");
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
