/** Where the companion lives, from this UI's point of view. The web build talks to the host that
 *  served it; the desktop build gets an explicit address (and token) from the Electron preload. */

export interface DesktopBridge {
  mode: "desktop";
  /** e.g. "http://127.0.0.1:3000" */
  baseUrl: string;
  token: string;
}

export interface Transport {
  mode: "web" | "desktop";
  /** ws(s):// URL for a socket path such as "/ws" or "/ws/stt". */
  wsUrl(path: string): string;
}

declare global {
  interface Window {
    jev?: DesktopBridge;
  }
}

export function detectTransport(w: Pick<Window, "jev" | "location"> = window): Transport {
  const bridge = w.jev;
  if (bridge?.mode === "desktop") {
    const base = new URL(bridge.baseUrl);
    const proto = base.protocol === "https:" ? "wss" : "ws";
    return { mode: "desktop", wsUrl: (path) => `${proto}://${base.host}${path}` };
  }
  const proto = w.location.protocol === "https:" ? "wss" : "ws";
  return { mode: "web", wsUrl: (path) => `${proto}://${w.location.host}${path}` };
}
