/** Send one utterance to the running companion as if it had been spoken, and print the
 *  messages that follow (including the spoken reply). Usage: node scripts/voice-cmd.mjs "open wikipedia" */
import { WebSocket } from "ws";

const ws = new WebSocket("ws://127.0.0.1:3000/ws");
const text = process.argv[2] ?? "open wikipedia and search for cats";
const t0 = Date.now();
ws.on("open", () => ws.send(JSON.stringify({ type: "command", text, via: "voice" })));
ws.on("message", (d) => {
  const m = JSON.parse(String(d));
  if (m.type === "screenshot") return;
  console.log(`[${Date.now() - t0} ms]`, JSON.stringify(m).slice(0, 160));
  if (m.type === "speaking" && m.active === false) process.exit(0);
});
setTimeout(() => process.exit(1), 40000);
