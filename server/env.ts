/** Load KEY=value lines from a .env file into process.env without overriding what the shell
 *  already set. Enough for the keys this project uses; no dependency, no interpolation. */
import { readFileSync } from "node:fs";

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "").trim(); // trailing comment
    out[m[1]!] = value;
  }
  return out;
}

/** Returns the keys that were applied (missing file → none). */
export function loadEnvFile(file: string, env: NodeJS.ProcessEnv = process.env): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const applied: string[] = [];
  for (const [k, v] of Object.entries(parseEnv(text))) {
    if (env[k] === undefined || env[k] === "") {
      env[k] = v;
      applied.push(k);
    }
  }
  return applied;
}
