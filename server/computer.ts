/** The Mac lane's launcher: applications with `open -a` (which also brings a running app to
 *  the front), files by name through Spotlight (`mdfind`), opened with `open`. Acting inside
 *  an app is the Mac executor's job. */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import type { Computer } from "../core/session.js";

type Run = (cmd: string, args: string[]) => Promise<string>;

/** Folders whose contents are never "my resume": caches, code dependencies, app bundles. */
const NOISE = /\/(?:Library|node_modules|\.[^/]+|\.git|dist|build|target|venv|__pycache__)\//;
/** Where people keep the files they ask for by name. */
export const FILE_ROOTS = ["Documents", "Desktop", "Downloads", "Movies", "Music", "Pictures", "iCloud Drive"];

const DISPLAY_NAMES: Record<string, string> = {
  chrome: "Google Chrome",
  "vs code": "Visual Studio Code",
  "system preferences": "System Settings",
  iterm: "iTerm",
  word: "Microsoft Word",
  excel: "Microsoft Excel",
  powerpoint: "Microsoft PowerPoint",
  outlook: "Microsoft Outlook",
  teams: "Microsoft Teams",
};

/** "vs code" -> "Visual Studio Code"; otherwise Title Case, which is what most bundles are called. */
export function appDisplayName(app: string): string {
  const key = app.trim().toLowerCase();
  return DISPLAY_NAMES[key] ?? key.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export class MacComputer implements Computer {
  constructor(
    private readonly run: Run = exec,
    private readonly home = homedir(),
    private readonly mtime: (path: string) => Promise<number> = (p) => stat(p).then((s) => s.mtimeMs),
    /** The frontmost app's name (default: `lsappinfo`); used to wait until a launch has focus. */
    private readonly frontName: () => Promise<string> = frontApp,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Launch or focus an app, then wait until it is actually the frontmost app (up to ~1.6 s) so
   *  the next step of a spoken sequence — "open slack and click general" — snapshots Slack, not
   *  whatever was in front when the launch was still starting up. */
  async openApp(app: string): Promise<string> {
    const name = appDisplayName(app);
    await this.run("open", ["-a", name]);
    const want = name.toLowerCase();
    for (let i = 0; i < 8; i++) {
      const front = (await this.frontName().catch(() => "")).toLowerCase();
      if (front && (front === want || front.includes(want) || want.includes(front))) break;
      await this.sleep(200);
    }
    return `Opened ${name}`;
  }

  /** Spotlight by file name under the user's own folders, newest first. `mdfind -name` matches
   *  the display name case-insensitively as a substring, so "resume" finds "Resume 2026.pdf". */
  async findFiles(query: string): Promise<string[]> {
    const q = query.trim();
    if (!q) return [];
    const args = ["-name", q];
    for (const root of FILE_ROOTS) args.push("-onlyin", `${this.home}/${root}`);
    let out: string;
    try {
      out = await this.run("mdfind", args);
    } catch {
      out = "";
    }
    const paths = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !NOISE.test(l));
    const dated = await Promise.all(paths.map(async (p) => ({ p, t: await this.mtime(p).catch(() => 0) })));
    return dated.sort((a, b) => b.t - a.t).map((d) => d.p);
  }

  async openPath(path: string): Promise<string> {
    await this.run("open", [path]);
    const name = path.split("/").pop() ?? path;
    return `Opened ${name}`;
  }
}

/** The frontmost application's display name, via `lsappinfo` (fast, no TCC prompt). */
function frontApp(): Promise<string> {
  return new Promise((resolve) =>
    execFile("/bin/sh", ["-c", 'lsappinfo info -only name "$(lsappinfo front)"'], { timeout: 3000 }, (_e, out) => {
      const m = /"LSDisplayName"\s*=\s*"(.*)"/.exec(String(out));
      resolve(m ? m[1]! : "");
    }),
  );
}

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().replace(/^Unable to find application named '(.*)'$/, "I couldn't find an app called $1")));
      else resolve(String(stdout ?? ""));
    });
  });
}

export function selectComputer(env: NodeJS.ProcessEnv = process.env, platform = process.platform): MacComputer | null {
  if (platform !== "darwin" || env.JEV_COMPUTER === "off") return null;
  return new MacComputer();
}
