/** Send one utterance to the running companion as if it had been spoken, and print the
 *  messages that follow (including the spoken reply). When the command goes to the brain,
 *  keeps listening until its answer has been spoken. Usage: node scripts/voice-cmd.mjs "open wikipedia" */
import { WebSocket } from "ws";

const port = process.env.PORT ?? 3000;
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: process.env.JEV_TOKEN ? { authorization: `Bearer ${process.env.JEV_TOKEN}` } : {} });
const text = process.argv[2] ?? "open wikipedia and search for cats";
const t0 = Date.now();
let brain = false;
let settled = false;
ws.on("open", () => ws.send(JSON.stringify({ type: "command", text, via: "voice" })));
ws.on("message", (d) => {
  const m = JSON.parse(String(d));
  if (m.type === "screenshot") return;
  if (m.type === "brain_event" && m.event.kind === "delta") return;
  console.log(`[${Date.now() - t0} ms]`, JSON.stringify(m).slice(0, 200));
  if (m.type === "decision" && m.decision.route === "hermes") brain = true;
  if (m.type === "brain_event" && ["completed", "failed", "cancelled"].includes(m.event.kind)) settled = true;
  if (m.type === "speaking" && m.active === false && (!brain || settled)) process.exit(0);
});
setTimeout(() => process.exit(1), 180000);
