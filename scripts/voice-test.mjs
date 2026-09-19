/** Speak a line with whatever voice .env selects (ElevenLabs when keyed, else say), and report
 *  how long the first audio took. Usage: npm run voice:test -- "Hey Justin, this is the new voice." */
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../server/env.ts";
import { describeSpeaker, selectSpeaker } from "../server/speak/select.ts";

loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
const text = process.argv.slice(2).join(" ") || "Hey Justin, this is the new voice. Loud and clear.";
const speaker = selectSpeaker(process.env, (m) => console.warn(m));
console.log(`voice: ${describeSpeaker(speaker)}${speaker ? `, up to ${speaker.maxChars ?? 160} chars spoken` : ""}`);
if (!speaker) process.exit(0);
const t0 = Date.now();
await speaker.speak(text);
console.log(`spoke ${text.length} chars in ${Date.now() - t0} ms`);
