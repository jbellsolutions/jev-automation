import { createHash } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { type Action, describeAction } from "./actions.js";
import { BrowserSession } from "./browser.js";
import { parseOrdinal } from "./commands.js";
import { type Decision, createDecider } from "./decide.js";
import { demoPage } from "./demo.js";
import type { ClientMessage, DecisionSummary, ServerMessage } from "./protocol.js";

const PORT = Number(process.env.PORT ?? 3000);
const HEADLESS = (process.env.HEADLESS ?? "true").toLowerCase() !== "false";
const VIEWPORT = { width: 1280, height: 800 };
const SCREENSHOT_INTERVAL_MS = 700;

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const app = express();
app.use(express.static(publicDir));
app.get("/demo", (req, res) => {
  res.type("html").send(demoPage(String(req.query.page ?? "home")));
});

const decider = createDecider();
const browser = new BrowserSession({
  headless: HEADLESS,
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
  startUrl: process.env.START_URL ?? `http://localhost:${PORT}/demo`,
  viewport: VIEWPORT,
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, jev: { enabled: decider.enabled, model: decider.model }, url: browser.url });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}
const status = (text: string, level: Extract<ServerMessage, { type: "status" }>["level"] = "info") => broadcast({ type: "status", text, level });

// --- screenshot streaming -----------------------------------------------------------
let lastShotHash = "";
let shotInFlight = false;
let shotDirty = true;
async function pushScreenshot(force = false): Promise<void> {
  if (shotInFlight || wss.clients.size === 0) return;
  shotInFlight = true;
  try {
    const buf = await browser.screenshot();
    if (!buf) return;
    const hash = createHash("md5").update(buf).digest("hex");
    if (!force && !shotDirty && hash === lastShotHash) return;
    lastShotHash = hash;
    shotDirty = false;
    broadcast({ type: "screenshot", jpegBase64: buf.toString("base64"), url: browser.url, title: await browser.title() });
  } finally {
    shotInFlight = false;
  }
}

// --- command handling ---------------------------------------------------------------
let pendingConfirm: { action: Action; label: string } | null = null;
let pendingClarify: { decision: Decision } | null = null;
let queue: Promise<void> = Promise.resolve();
let inFlight: AbortController | null = null;

function summarize(d: Decision): DecisionSummary {
  return {
    command: d.command,
    intent: d.intent,
    intentConfidence: d.intentConfidence,
    action: d.action,
    actionLabel: d.clarify ? d.clarify.question : describeAction(d.action),
    source: d.source,
    model: d.meta.model,
    latencyMs: d.meta.latencyMs,
    inputTokens: d.meta.inputTokens,
    targetConfidence: d.targetConfidence ?? undefined,
    alternatives: d.alternatives.length ? d.alternatives : undefined,
    risky: d.riskProbability,
  };
}

async function run(action: Action): Promise<void> {
  status(describeAction(action) + "…", "busy");
  try {
    const result = await browser.execute(action);
    status(result, "ok");
  } catch (err) {
    status(err instanceof Error ? err.message : String(err), "error");
  }
  shotDirty = true;
  await pushScreenshot(true);
}

async function handleCommand(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  broadcast({ type: "transcript_ack", text: trimmed });

  if (pendingConfirm) {
    const reply = await decider.classifyReply(trimmed, pendingConfirm.label);
    const pending = pendingConfirm;
    if (reply === "confirm") {
      pendingConfirm = null;
      return run(pending.action);
    }
    if (reply === "cancel") {
      pendingConfirm = null;
      return status(`Cancelled: ${pending.label}`, "warn");
    }
    pendingConfirm = null; // a new command supersedes the question
  }
  if (pendingClarify) {
    const idx = parseOrdinal(trimmed);
    const opts = pendingClarify.decision.clarify?.options ?? [];
    const picked = idx !== null ? opts[idx] : undefined;
    pendingClarify = null;
    if (picked) return run({ kind: "click", elementId: picked.elementId, label: picked.label });
  }

  status("Thinking…", "busy");
  inFlight?.abort();
  inFlight = new AbortController();
  const snapshot = await browser.snapshot();
  let decision: Decision;
  try {
    decision = await decider.decide(trimmed, snapshot, inFlight.signal);
  } catch (err) {
    if (inFlight.signal.aborted) return;
    return status(err instanceof Error ? err.message : String(err), "error");
  }
  broadcast({ type: "decision", decision: summarize(decision) });
  if (decision.meta.fallbackReason) status(`Jev unavailable (${decision.meta.fallbackReason}); used heuristics`, "warn");

  if (decision.clarify) {
    pendingClarify = { decision };
    return broadcast({ type: "clarify", question: decision.clarify.question, options: decision.clarify.options });
  }
  if (decision.action.kind === "none") return status(decision.action.reason, "warn");
  if (decision.action.kind === "stop") {
    pendingConfirm = null;
    return status("Stopped", "ok");
  }
  if (decision.needsConfirmation) {
    const label = describeAction(decision.action);
    pendingConfirm = { action: decision.action, label };
    return broadcast({ type: "confirm", actionLabel: label, reason: `This looks hard to undo (risk ${Math.round(decision.riskProbability * 100)}%). Say "yes" or "no".` });
  }
  await run(decision.action);
}

function enqueue(task: () => Promise<void>): void {
  queue = queue.then(task).catch((err) => status(err instanceof Error ? err.message : String(err), "error"));
}

wss.on("connection", (ws) => {
  const hello: ServerMessage = { type: "hello", jev: { enabled: decider.enabled, model: decider.model }, viewport: VIEWPORT };
  ws.send(JSON.stringify(hello));
  shotDirty = true;
  void pushScreenshot(true);

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "command":
        if (typeof msg.text === "string") enqueue(() => handleCommand(msg.text));
        break;
      case "confirm_reply":
        enqueue(async () => {
          const pending = pendingConfirm;
          pendingConfirm = null;
          if (!pending) return;
          if (msg.ok) await run(pending.action);
          else status(`Cancelled: ${pending.label}`, "warn");
        });
        break;
      case "pick":
        enqueue(async () => {
          const opt = pendingClarify?.decision.clarify?.options.find((o) => o.elementId === msg.elementId);
          pendingClarify = null;
          if (opt) await run({ kind: "click", elementId: opt.elementId, label: opt.label });
        });
        break;
      case "click_at":
        if (Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
          enqueue(() => run({ kind: "click_at", x: Math.round(msg.x), y: Math.round(msg.y) }));
        }
        break;
      case "screenshot_request":
        shotDirty = true;
        void pushScreenshot(true);
        break;
    }
  });
});

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  await browser.start();
  browser.onChange(() => {
    shotDirty = true;
  });
  setInterval(() => void pushScreenshot(), SCREENSHOT_INTERVAL_MS);
  console.log(`Jev voice browser → http://localhost:${PORT}`);
  console.log(decider.enabled ? `Decisions: TypeSafe Jev (${decider.model})` : "Decisions: keyword heuristics (set TYPESAFE_API_KEY to use Jev)");
}

const shutdown = async () => {
  await browser.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
