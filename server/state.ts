/** Small persistent state for the assistant (`~/.jev/state.json`, mode 0600): which Hermes
 *  conversation is current, later window position and settings. Missing or corrupt → empty. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface JevState {
  hermesSessionId?: string;
  /** Model that conversation was created on (null = Hermes' default); a change means a new one. */
  hermesModel?: string | null;
}

export const defaultStatePath = () => path.join(process.env.JEV_HOME ?? path.join(homedir(), ".jev"), "state.json");

export function readState(file = defaultStatePath()): JevState {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JevState) : {};
  } catch {
    return {};
  }
}

export function writeState(patch: Partial<JevState>, file = defaultStatePath()): JevState {
  const next = { ...readState(file), ...patch };
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return next;
}
