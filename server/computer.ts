/** The Mac lane before the accessibility executor (M5): launch or focus an application with
 *  `open -a`, which also brings it to the front when it is already running. */
import { execFile } from "node:child_process";
import type { Computer } from "../core/session.js";

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
  constructor(private readonly run: (cmd: string, args: string[]) => Promise<void> = exec) {}

  async openApp(app: string): Promise<string> {
    const name = appDisplayName(app);
    await this.run("open", ["-a", name]);
    return `Opened ${name}`;
  }
}

function exec(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().replace(/^Unable to find application named '(.*)'$/, "I couldn't find an app called $1")));
      else resolve();
    });
  });
}

export function selectComputer(env: NodeJS.ProcessEnv = process.env, platform = process.platform): MacComputer | null {
  if (platform !== "darwin" || env.JEV_COMPUTER === "off") return null;
  return new MacComputer();
}
