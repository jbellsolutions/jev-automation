/** The wire between the companion and a remote surface — today the Chrome bridge extension
 *  driving the user's own browser. The companion asks; the bridge answers with the same
 *  shapes the Playwright executor produces, so the session loop cannot tell them apart.
 *
 *  Socket: the bridge connects to `/ws/bridge?token=…` and says hello; the companion sends
 *  `exec_req`s and `ping`s; the bridge answers each request by id and reports tab changes. */
import type { Action } from "./actions.js";
import type { PageElement } from "./elements.js";

export const BRIDGE_PROTOCOL = 1;

export interface TabInfo {
  url: string;
  title: string;
}

/** Elements as the page script returns them: ids are assigned by position (see extractElements). */
export type RawElement = Omit<PageElement, "id">;

export interface RawSnapshot extends TabInfo {
  elements: RawElement[];
}

export type RemoteOp =
  | { op: "snapshot"; max: number }
  | { op: "execute"; action: Action }
  /** JPEG of the visible tab, base64. */
  | { op: "screenshot"; quality: number }
  | { op: "tab" };

export type RemoteResult =
  | { op: "snapshot"; snapshot: RawSnapshot }
  | { op: "execute"; status: string }
  | { op: "screenshot"; jpegBase64: string | null }
  | { op: "tab"; tab: TabInfo | null };

/** companion -> bridge */
export type ToBridge = { type: "exec_req"; id: string; req: RemoteOp } | { type: "ping" };

/** bridge -> companion */
export type FromBridge =
  | { type: "hello"; protocol: number; agent: string; tab: TabInfo | null }
  | { type: "exec_res"; id: string; ok: true; result: RemoteResult }
  | { type: "exec_res"; id: string; ok: false; error: string }
  /** The active tab changed or navigated; the companion refreshes its view. */
  | { type: "tab"; tab: TabInfo | null }
  | { type: "pong" };

/** Element-id contract shared with the Playwright executor. */
export const STALE_ELEMENT = (label: string) => `${label} is no longer on the page`;
