/** Apple's on-device speech recognition through the `jev-speech` helper (native/jev-speech).
 *  Free, offline, no account — the fallback when no cloud key works, and a fine default on a Mac.
 *  The helper takes PCM on stdin and emits JSON lines; it cuts utterances itself on silence. */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SttEvent, SttProvider, SttStart, SttStream } from "./types.js";

export interface AppleSpeechOptions {
  /** Path to the built helper; defaults to native/jev-speech/jev-speech in the repo. */
  bin?: string;
  locale?: string;
  spawn?: typeof spawn;
}

export function defaultAppleBin(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "native", "jev-speech", "jev-speech");
}

export function appleSpeechAvailable(bin = defaultAppleBin()): boolean {
  return process.platform === "darwin" && existsSync(bin);
}

interface HelperLine {
  type?: string;
  text?: string;
  final?: boolean;
  message?: string;
  state?: string;
  onDevice?: boolean;
}

export class AppleSpeechProvider implements SttProvider {
  readonly name = "apple";
  private readonly bin: string;

  constructor(private readonly opts: AppleSpeechOptions = {}) {
    this.bin = opts.bin ?? defaultAppleBin();
  }

  open(start: SttStart, onEvent: (ev: SttEvent) => void): SttStream {
    const locale = start.lang && start.lang.includes("-") ? start.lang : (this.opts.locale ?? "en-US");
    const args = [String(start.sampleRate), locale, ...(start.keywords ?? [])];
    let child: ChildProcess;
    try {
      child = (this.opts.spawn ?? spawn)(this.bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      queueMicrotask(() => onEvent({ type: "error", message: `cannot start ${this.bin}: ${err instanceof Error ? err.message : String(err)}` }));
      return { send: () => {}, finish: () => {}, close: () => {} };
    }
    let closed = false;
    let buf = "";
    const done = (ev: SttEvent) => {
      if (closed) return;
      closed = true;
      onEvent(ev);
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: HelperLine;
        try {
          msg = JSON.parse(line) as HelperLine;
        } catch {
          continue;
        }
        switch (msg.type) {
          case "ready":
            onEvent({ type: "open" });
            break;
          case "transcript":
            onEvent({ type: "transcript", text: msg.text ?? "", final: !!msg.final, speechFinal: !!msg.final });
            break;
          case "permission":
            onEvent({ type: "error", message: "Allow speech recognition for jev-speech in the system prompt to use on-device voice." });
            break;
          case "error":
            onEvent({ type: "error", message: msg.message ?? "jev-speech error" });
            break;
        }
      }
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => (stderr += c));
    child.on("error", (err) => done({ type: "error", message: err.message }));
    child.on("exit", (code, signal) => {
      if (code && code !== 0 && !closed) onEvent({ type: "error", message: `jev-speech exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}` });
      done({ type: "closed" });
      void signal;
    });
    return {
      send: (audio) => {
        if (closed || !child.stdin || child.stdin.destroyed) return;
        if (child.stdin.writableLength > 1_000_000) return; // the helper fell behind; drop rather than queue
        child.stdin.write(audio);
      },
      finish: () => {
        child.stdin?.end();
      },
      close: () => {
        if (!closed) child.kill("SIGTERM");
      },
    };
  }
}
