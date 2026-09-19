/** Stream a 16 kHz mono PCM file (or a phrase spoken by macOS `say`) through the configured STT
 *  provider and print the utterances. Usage:
 *    npx tsx scripts/stt-smoke.ts "open wikipedia and search for cats"
 *    npx tsx scripts/stt-smoke.ts --file audio.raw */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Segmenter } from "../server/stt/segment.js";
import { selectSttProvider } from "../server/stt/select.js";

const RATE = 16000;

/** The samples of a WAVE file: everything inside its `data` chunk. */
function wavData(wav: Buffer): Buffer {
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "data") return wav.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}
const args = process.argv.slice(2);
const provider = selectSttProvider();
if (!provider) {
  console.error("No STT provider configured (set DEEPGRAM_API_KEY).");
  process.exit(1);
}

let pcm: Buffer;
if (args[0] === "--file") {
  pcm = readFileSync(args[1]!);
} else {
  const phrase = args.join(" ") || "open wikipedia and search for cats";
  const out = path.join(tmpdir(), `jev-stt-${process.pid}.wav`);
  // LEI16@16000 = little-endian 16-bit PCM at 16 kHz inside a WAVE container
  execFileSync("say", ["-o", out, "--data-format=LEI16@16000", "--file-format=WAVE", phrase]);
  pcm = wavData(readFileSync(out));
  console.log(`spoke "${phrase}" → ${pcm.length} bytes (${(pcm.length / 2 / RATE).toFixed(1)} s)`);
}

const seg = new Segmenter(800);
const t0 = Date.now();
const stream = provider.open({ sampleRate: RATE, encoding: "pcm_s16le", channels: 1, lang: "en", keywords: ["Jev", "Hermes"] }, (ev) => {
  const ms = Date.now() - t0;
  if (ev.type === "open") {
    console.log(`[${ms} ms] ${provider.name} ready — streaming in 100 ms frames`);
    let offset = 0;
    const frame = (RATE / 10) * 2;
    const timer = setInterval(() => {
      if (offset >= pcm.length) {
        clearInterval(timer);
        setTimeout(() => stream.finish(), 500);
        return;
      }
      stream.send(new Uint8Array(pcm.subarray(offset, offset + frame)));
      offset += frame;
    }, 100);
    return;
  }
  if (ev.type === "error") console.error(`[${ms} ms] error: ${ev.message}`);
  for (const s of seg.push(ev, Date.now())) {
    if (s.type === "interim") process.stdout.write(`\r… ${s.text.padEnd(70)}`);
    else console.log(`\n[${ms} ms] UTTERANCE: ${s.text}`);
  }
  if (ev.type === "closed") {
    console.log(`[${ms} ms] closed`);
    process.exit(0);
  }
});
setTimeout(() => {
  console.error("timed out");
  process.exit(2);
}, 30000);
