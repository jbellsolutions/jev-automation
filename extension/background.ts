/** Service worker: keeps a socket to the companion, tracks the active tab, and carries out
 *  requests on it — navigation itself, everything in the page through the content script.
 *  MV3 workers are put to sleep when idle; socket traffic every 20 s and an alarm keep the
 *  bridge alive and reconnecting. */
import type { Action } from "../core/actions.js";
import { BRIDGE_PROTOCOL, type FromBridge, type RemoteOp, type RemoteResult, type TabInfo, type ToBridge } from "../core/remote.js";
import type { ContentRequest, ContentResponse } from "./content.js";

const DEFAULTS = { url: "ws://127.0.0.1:3111/ws/bridge", token: "" };
const PING_MS = 20_000;
const RECONNECT_MS = [1_000, 2_000, 5_000, 10_000];

let socket: WebSocket | null = null;
let attempts = 0;
let pingTimer: ReturnType<typeof setInterval> | null = null;

/** Where the companion is. Saved settings win; otherwise config.json, which the build writes
 *  next to this file from the companion's own .env, so loading the folder is all the pairing
 *  there is (nothing to type). */
async function settings(): Promise<{ url: string; token: string }> {
  const stored = (await chrome.storage.local.get(["url", "token"])) as Partial<typeof DEFAULTS>;
  if (stored.url?.trim() || stored.token?.trim()) return { url: stored.url?.trim() || DEFAULTS.url, token: stored.token?.trim() || "" };
  try {
    const res = await fetch(chrome.runtime.getURL("config.json"));
    const cfg = (await res.json()) as Partial<typeof DEFAULTS>;
    return { url: cfg.url?.trim() || DEFAULTS.url, token: cfg.token?.trim() || "" };
  } catch {
    return { ...DEFAULTS };
  }
}

async function activeTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) return tab;
  const [any] = await chrome.tabs.query({ active: true });
  return any ?? null;
}

const info = (tab: chrome.tabs.Tab | null): TabInfo | null => (tab ? { url: tab.url ?? "", title: tab.title ?? "" } : null);

const scriptable = (tab: chrome.tabs.Tab): boolean => /^(https?|file):/.test(tab.url ?? "");

/** Ask the content script; inject it first when the tab predates the extension. */
async function askContent(tab: chrome.tabs.Tab, req: ContentRequest): Promise<ContentResponse> {
  if (!tab.id) throw new Error("No tab is active");
  if (!scriptable(tab)) throw new Error(`Can't act on this page (${tab.url?.split("/")[0] ?? "internal"} pages are off limits)`);
  const send = () => chrome.tabs.sendMessage(tab.id!, req) as Promise<ContentResponse>;
  try {
    return await send();
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    return await send();
  }
}

async function waitForLoad(tabId: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.status === "complete" || Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function navigate(tab: chrome.tabs.Tab, url: string): Promise<void> {
  if (!tab.id) throw new Error("No tab is active");
  await chrome.tabs.update(tab.id, { url });
  await waitForLoad(tab.id);
}

async function execute(action: Action): Promise<string> {
  const tab = await activeTab();
  if (!tab) throw new Error("No tab is active in Chrome");
  switch (action.kind) {
    case "navigate":
      await navigate(tab, action.url);
      return `Opened ${action.url}`;
    case "search":
      await navigate(tab, action.url);
      return `Searched for "${action.query}"`;
    case "back":
      if (tab.id) await chrome.tabs.goBack(tab.id).catch(() => {});
      return "Went back";
    case "forward":
      if (tab.id) await chrome.tabs.goForward(tab.id).catch(() => {});
      return "Went forward";
    case "reload":
      if (tab.id) {
        await chrome.tabs.reload(tab.id);
        await waitForLoad(tab.id);
      }
      return "Reloaded";
    case "stop":
      return "Stopped";
    case "open_app":
      throw new Error(`The browser can't open ${action.app}`);
    case "none":
      return action.reason;
    default: {
      const res = await askContent(tab, { op: "execute", action });
      if (!res.ok) throw new Error(res.error);
      // a click may have started a navigation: give it a moment so the next snapshot is fresh
      if (action.kind === "click" || (action.kind === "type" && action.submit) || action.kind === "press") {
        await new Promise((r) => setTimeout(r, 250));
        if (tab.id) await waitForLoad(tab.id, 3_000);
      }
      return res.status ?? "Done";
    }
  }
}

async function perform(req: RemoteOp): Promise<RemoteResult> {
  switch (req.op) {
    case "tab":
      return { op: "tab", tab: info(await activeTab()) };
    case "snapshot": {
      const tab = await activeTab();
      if (!tab) throw new Error("No tab is active in Chrome");
      if (!scriptable(tab)) return { op: "snapshot", snapshot: { url: tab.url ?? "", title: tab.title ?? "", elements: [] } };
      const res = await askContent(tab, { op: "snapshot", max: req.max });
      if (!res.ok) throw new Error(res.error);
      return { op: "snapshot", snapshot: { url: tab.url ?? "", title: res.title ?? tab.title ?? "", elements: res.elements ?? [] } };
    }
    case "execute":
      return { op: "execute", status: await execute(req.action) };
    case "screenshot": {
      const tab = await activeTab();
      if (!tab?.windowId) return { op: "screenshot", jpegBase64: null };
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: req.quality });
        return { op: "screenshot", jpegBase64: dataUrl.slice(dataUrl.indexOf(",") + 1) };
      } catch {
        return { op: "screenshot", jpegBase64: null };
      }
    }
  }
}

function send(msg: FromBridge): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

async function onMessage(raw: string): Promise<void> {
  let msg: ToBridge;
  try {
    msg = JSON.parse(raw) as ToBridge;
  } catch {
    return;
  }
  if (msg.type === "ping") return send({ type: "pong" });
  if (msg.type !== "exec_req") return;
  try {
    send({ type: "exec_res", id: msg.id, ok: true, result: await perform(msg.req) });
  } catch (err) {
    send({ type: "exec_res", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function connect(): Promise<void> {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const { url, token } = await settings();
  const target = new URL(url);
  if (token) target.searchParams.set("token", token);
  let ws: WebSocket;
  try {
    ws = new WebSocket(target.toString());
  } catch {
    return scheduleReconnect();
  }
  socket = ws;
  ws.onopen = async () => {
    attempts = 0;
    send({ type: "hello", protocol: BRIDGE_PROTOCOL, agent: `jev-chrome-bridge/${chrome.runtime.getManifest().version}`, tab: info(await activeTab()) });
    void chrome.action.setBadgeText({ text: "on" });
    void chrome.action.setBadgeBackgroundColor({ color: "#1a7f37" });
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: "pong" }), PING_MS); // traffic keeps the worker alive
  };
  ws.onmessage = (ev) => void onMessage(String(ev.data));
  ws.onclose = () => {
    if (socket === ws) socket = null;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    void chrome.action.setBadgeText({ text: "" });
    scheduleReconnect();
  };
  ws.onerror = () => ws.close();
}

function scheduleReconnect(): void {
  const delay = RECONNECT_MS[Math.min(attempts++, RECONNECT_MS.length - 1)]!;
  setTimeout(() => void connect(), delay);
}

async function announceTab(): Promise<void> {
  send({ type: "tab", tab: info(await activeTab()) });
}

chrome.tabs.onActivated.addListener(() => void announceTab());
chrome.windows.onFocusChanged.addListener(() => void announceTab());
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if ((change.status === "complete" || change.url || change.title) && tab.active) void announceTab();
});
chrome.storage.onChanged.addListener(() => {
  socket?.close();
  socket = null;
  attempts = 0;
  void connect();
});
chrome.alarms.create("jev-bridge-keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());
void connect();
