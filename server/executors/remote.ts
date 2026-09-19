/** The user's own Chrome, through the bridge extension. One executor lives for the whole
 *  process: the bridge attaches and detaches as the extension connects and reconnects, and
 *  while it is away every action fails fast with a clear message instead of hanging. */
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { Action } from "../../core/actions.js";
import { MAX_ELEMENTS, type PageSnapshot } from "../../core/elements.js";
import type { Executor, ExecutorCapabilities } from "../../core/executor.js";
import { BRIDGE_PROTOCOL, type FromBridge, type RemoteOp, type RemoteResult, type TabInfo, type ToBridge } from "../../core/remote.js";

export interface RemoteExecutorOptions {
  /** How long one request may take; navigation waits for the load, so allow for slow sites. */
  timeoutMs?: number;
  jpegQuality?: number;
  /** Keep-alive interval; the bridge answers each ping, and a missed answer drops the socket. */
  pingMs?: number;
  onReady?: (ready: boolean) => void;
}

interface Pending {
  resolve: (r: RemoteResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export const NOT_CONNECTED = "Chrome isn't connected: install the Jev bridge extension and point it at this companion";

export class RemoteExecutor implements Executor {
  readonly kind = "chrome" as const;
  readonly capabilities: ExecutorCapabilities = { screenshot: true, viewport: false, clickAt: true };
  readonly viewport = { width: 1280, height: 800 };
  private socket: WebSocket | null = null;
  private tab: TabInfo | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly changeListeners = new Set<() => void>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private awaitingPong = false;
  private readonly timeoutMs: number;

  constructor(
    private readonly opts: RemoteExecutorOptions = {},
    readonly id = "chrome",
  ) {
    this.timeoutMs = opts.timeoutMs ?? 25_000;
  }

  /** The bridge is connected and has said hello. */
  get ready(): boolean {
    return this.socket !== null;
  }

  get url(): string {
    return this.tab?.url ?? "about:blank";
  }

  async start(): Promise<void> {}

  /** Adopt a freshly opened bridge socket; a second bridge replaces the first. */
  attach(ws: WebSocket): void {
    if (this.socket && this.socket !== ws) this.socket.close(1000, "replaced by a newer bridge");
    this.socket = ws;
    this.awaitingPong = false;
    ws.on("message", (raw) => this.onMessage(String(raw)));
    ws.on("close", () => this.detach(ws));
    ws.on("error", () => this.detach(ws));
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.ping(), this.opts.pingMs ?? 20_000);
    this.opts.onReady?.(true);
    this.changed();
  }

  private detach(ws: WebSocket): void {
    if (this.socket !== ws) return;
    this.socket = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Chrome disconnected while working"));
      this.pending.delete(id);
    }
    this.opts.onReady?.(false);
    this.changed();
  }

  private ping(): void {
    if (!this.socket) return;
    if (this.awaitingPong) {
      this.socket.terminate();
      return;
    }
    this.awaitingPong = true;
    this.send({ type: "ping" });
  }

  private send(msg: ToBridge): void {
    this.socket?.send(JSON.stringify(msg));
  }

  private onMessage(raw: string): void {
    let msg: FromBridge;
    try {
      msg = JSON.parse(raw) as FromBridge;
    } catch {
      return;
    }
    switch (msg.type) {
      case "hello":
        if (msg.protocol !== BRIDGE_PROTOCOL) console.warn(`Chrome bridge speaks protocol ${msg.protocol}, companion ${BRIDGE_PROTOCOL}`);
        this.tab = msg.tab;
        this.changed();
        break;
      case "pong":
        this.awaitingPong = false;
        break;
      case "tab":
        this.tab = msg.tab;
        this.changed();
        break;
      case "exec_res": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error));
        break;
      }
    }
  }

  private request<K extends RemoteOp["op"]>(req: Extract<RemoteOp, { op: K }>): Promise<Extract<RemoteResult, { op: K }>> {
    if (!this.socket) return Promise.reject(new Error(NOT_CONNECTED));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome didn't answer within ${Math.round(this.timeoutMs / 1000)} s`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: (r) => resolve(r as Extract<RemoteResult, { op: K }>), reject, timer });
      this.send({ type: "exec_req", id, req });
    });
  }

  async title(): Promise<string> {
    return this.tab?.title ?? "";
  }

  async snapshot(): Promise<PageSnapshot> {
    const { snapshot } = await this.request({ op: "snapshot", max: MAX_ELEMENTS });
    this.tab = { url: snapshot.url, title: snapshot.title };
    return { url: snapshot.url, title: snapshot.title, elements: snapshot.elements.map((e, i) => ({ id: `e${i}`, ...e })) };
  }

  async screenshot(): Promise<Uint8Array | null> {
    if (!this.socket) return null;
    try {
      const { jpegBase64 } = await this.request({ op: "screenshot", quality: this.opts.jpegQuality ?? 60 });
      return jpegBase64 ? Buffer.from(jpegBase64, "base64") : null;
    } catch {
      return null;
    }
  }

  async execute(action: Action): Promise<string> {
    const { status } = await this.request({ op: "execute", action });
    return status;
  }

  async setViewport(): Promise<boolean> {
    return false; // the user's window is theirs
  }

  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  private changed(): void {
    for (const cb of this.changeListeners) cb();
  }

  async close(): Promise<void> {
    this.socket?.close(1001, "companion closing");
    this.socket = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
  }
}
