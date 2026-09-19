/** Where synthesized audio goes. `ffplay` plays an MP3 stream straight from stdin, so speech
 *  starts as soon as the first frames arrive and several chunks can be fed into one playback
 *  without a gap; `afplay` (always on macOS) needs a whole file, so it is the fallback. */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface Playback {
  write(chunk: Uint8Array): void;
  /** No more audio is coming; `done` settles when what was written has been played. */
  end(): void;
  /** Cut the audio off now. */
  stop(): void;
  readonly done: Promise<void>;
}

export interface Player {
  readonly name: string;
  open(): Playback;
}

type Spawn = typeof spawn;

function exitPromise(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
}

export class FfplayPlayer implements Player {
  readonly name = "ffplay";
  constructor(
    private readonly bin = "ffplay",
    private readonly spawnImpl: Spawn = spawn,
  ) {}

  open(): Playback {
    const child = this.spawnImpl(this.bin, ["-f", "mp3", "-nodisp", "-autoexit", "-loglevel", "quiet", "-i", "pipe:0"], { stdio: ["pipe", "ignore", "ignore"] });
    child.stdin?.on("error", () => {}); // EPIPE after a stop is expected
    const done = exitPromise(child);
    return {
      write: (chunk) => {
        if (child.exitCode === null && child.stdin && !child.stdin.destroyed) child.stdin.write(chunk);
      },
      end: () => child.stdin?.end(),
      stop: () => {
        if (child.exitCode === null) child.kill();
      },
      done,
    };
  }
}

export class AfplayPlayer implements Player {
  readonly name = "afplay";
  constructor(private readonly spawnImpl: Spawn = spawn) {}

  open(): Playback {
    const parts: Uint8Array[] = [];
    let child: ChildProcess | null = null;
    let stopped = false;
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r));
    return {
      write: (chunk) => void parts.push(chunk),
      end: () => {
        if (stopped || !parts.length) return finish();
        const dir = mkdtempSync(path.join(tmpdir(), "jev-tts-"));
        const file = path.join(dir, "speech.mp3");
        writeFileSync(file, Buffer.concat(parts));
        child = this.spawnImpl("afplay", [file], { stdio: "ignore" });
        void exitPromise(child).then(() => {
          rmSync(dir, { recursive: true, force: true });
          finish();
        });
      },
      stop: () => {
        stopped = true;
        if (child && child.exitCode === null) child.kill();
        else finish();
      },
      done,
    };
  }
}

const FFPLAY_PATHS = ["/opt/homebrew/bin/ffplay", "/usr/local/bin/ffplay"];

/** ffplay when installed (streams), else afplay. */
export function selectPlayer(env: NodeJS.ProcessEnv = process.env): Player {
  const configured = env.JEV_FFPLAY?.trim();
  const bin = configured && existsSync(configured) ? configured : FFPLAY_PATHS.find((p) => existsSync(p));
  return bin ? new FfplayPlayer(bin) : new AfplayPlayer();
}
