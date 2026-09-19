/** macOS text-to-speech through /usr/bin/say. One utterance at a time; a new one interrupts. */
import { type ChildProcess, spawn } from "node:child_process";
import type { Speaker } from "../../core/speak.js";

export interface SayOptions {
  voice?: string;
  /** Words per minute; `say` defaults to about 175. */
  rate?: number;
  spawn?: typeof spawn;
}

export class SaySpeaker implements Speaker {
  private current: ChildProcess | null = null;

  constructor(private readonly opts: SayOptions = {}) {}

  speak(text: string, signal?: AbortSignal): Promise<void> {
    this.stop();
    const clean = text.trim();
    if (!clean) return Promise.resolve();
    const args: string[] = [];
    if (this.opts.voice) args.push("-v", this.opts.voice);
    if (this.opts.rate) args.push("-r", String(this.opts.rate));
    // text goes on stdin so nothing the page said is parsed as an option
    const child = (this.opts.spawn ?? spawn)("say", args, { stdio: ["pipe", "ignore", "ignore"] });
    this.current = child;
    child.stdin?.end(clean);
    return new Promise((resolve) => {
      const done = () => {
        if (this.current === child) this.current = null;
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => child.kill();
      signal?.addEventListener("abort", onAbort, { once: true });
      child.once("exit", done);
      child.once("error", done);
    });
  }

  stop(): void {
    const c = this.current;
    this.current = null;
    if (c && c.exitCode === null) c.kill();
  }
}

export function selectSpeaker(env: NodeJS.ProcessEnv = process.env): Speaker | null {
  if (process.platform !== "darwin" || (env.JEV_SPEAK ?? "on").toLowerCase() === "off") return null;
  return new SaySpeaker({ voice: env.JEV_VOICE || undefined, rate: env.JEV_SPEECH_RATE ? Number(env.JEV_SPEECH_RATE) : undefined });
}
