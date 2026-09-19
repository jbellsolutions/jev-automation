import type { Action } from "./actions.js";
import type { PageSnapshot } from "./elements.js";

/** What an executor can do beyond the Action union; the hub and UIs adapt to these. */
export interface ExecutorCapabilities {
  /** Can produce JPEG frames for a live view. */
  screenshot: boolean;
  /** Honours setViewport (a real browser tab or desktop app cannot be resized by us). */
  viewport: boolean;
  /** Supports the click_at action. */
  clickAt: boolean;
}

export type ExecutorKind = "playwright" | "chrome" | "mac" | "orgo";

/** One controllable surface: a Playwright browser, the user's Chrome tab via the bridge, the
 *  Mac's frontmost app via accessibility, ... Every surface exposes the same three verbs the
 *  decision loop needs — snapshot what's there, execute an Action, tell me when it changed —
 *  so decide.ts and the session loop never know which one they are driving.
 *
 *  Contract shared by all implementations: execute() on a click/type whose element id is no
 *  longer present must throw `${label} is no longer on the page`. */
export interface Executor {
  readonly id: string;
  readonly kind: ExecutorKind;
  readonly capabilities: ExecutorCapabilities;
  readonly viewport: { width: number; height: number };
  /** Current location: a URL for browsers, app://<bundle id> for desktop apps. */
  readonly url: string;
  /** False while the surface cannot be driven (a bridge that is not connected); absent = ready. */
  readonly ready?: boolean;
  start(): Promise<void>;
  title(): Promise<string>;
  snapshot(): Promise<PageSnapshot>;
  /** JPEG bytes, or null when a frame cannot be produced right now. */
  screenshot(): Promise<Uint8Array | null>;
  /** Perform an action and return a short status line for the UI. */
  execute(action: Action): Promise<string>;
  /** Resize the surface; returns false when nothing changed (or the surface can't resize). */
  setViewport(width: number, height: number): Promise<boolean>;
  /** Called whenever the surface changed on its own (navigation, load, tab switch). */
  onChange(cb: () => void): () => void;
  close(): Promise<void>;
}
