/** Owns every Session (one per executor) and fans its messages out to the WebSocket UIs
 *  attached to it, streaming JPEG frames when the executor can produce them. */
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import type { Decider } from "../core/decide.js";
import type { Executor } from "../core/executor.js";
import type { ServerMessage } from "../core/protocol.js";
import type { SessionStatus } from "../core/results.js";
import { Session } from "../core/session.js";

/** Pushes a frame when the surface changed (or every interval as a safety net), skipping
 *  frames identical to the last one so an idle page costs nothing. */
class FrameStreamer {
  private lastHash = "";
  private inFlight = false;
  private dirty = true;
  private timer: NodeJS.Timeout | null = null;
  clients = 0;

  constructor(
    private readonly executor: Executor,
    private readonly send: (msg: ServerMessage) => void,
    private readonly intervalMs: number,
  ) {}

  markDirty(): void {
    this.dirty = true;
  }

  start(): void {
    if (this.timer || !this.executor.capabilities.screenshot) return;
    this.timer = setInterval(() => void this.push(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async push(force = false): Promise<void> {
    if (this.inFlight || this.clients === 0 || !this.executor.capabilities.screenshot) return;
    this.inFlight = true;
    try {
      const buf = await this.executor.screenshot();
      if (!buf) return;
      const hash = createHash("md5").update(buf).digest("hex");
      if (!force && !this.dirty && hash === this.lastHash) return;
      this.lastHash = hash;
      this.dirty = false;
      this.send({ type: "screenshot", jpegBase64: Buffer.from(buf).toString("base64"), url: this.executor.url, title: await this.executor.title() });
    } finally {
      this.inFlight = false;
    }
  }
}

interface Entry {
  session: Session;
  clients: Set<WebSocket>;
  streamer: FrameStreamer;
  unsubscribe: () => void;
}

export interface HubOptions {
  decider: Decider;
  screenshotIntervalMs: number;
  /** Session id programmatic callers and new UIs get when they don't name one. */
  defaultSession?: string;
}

export class Hub {
  private readonly entries = new Map<string, Entry>();
  private readonly owner = new Map<WebSocket, string>();

  constructor(private readonly opts: HubOptions) {}

  register(executor: Executor): Session {
    const id = executor.id;
    if (this.entries.has(id)) throw new Error(`Session ${id} already registered`);
    const clients = new Set<WebSocket>();
    const streamer = new FrameStreamer(executor, (msg) => this.broadcast(id, msg), this.opts.screenshotIntervalMs);
    const session = new Session(id, { executor, decider: this.opts.decider, afterAction: () => streamer.push(true) });
    const unsubSession = session.subscribe((msg) => this.broadcast(id, msg));
    const unsubChange = executor.onChange(() => streamer.markDirty());
    this.entries.set(id, {
      session,
      clients,
      streamer,
      unsubscribe: () => {
        unsubSession();
        unsubChange();
      },
    });
    return session;
  }

  unregister(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.streamer.stop();
    e.unsubscribe();
    for (const ws of e.clients) this.owner.delete(ws);
    this.entries.delete(id);
  }

  get(id: string): Session | undefined {
    return this.entries.get(id)?.session;
  }

  /** Explicit default, else the user's Chrome when the bridge is connected, else Playwright, else anything. */
  get defaultId(): string | null {
    const d = this.opts.defaultSession;
    if (d && this.entries.has(d)) return d;
    for (const id of ["chrome", "playwright"]) if (this.entries.has(id)) return id;
    return this.entries.keys().next().value ?? null;
  }

  sessionFor(ws: WebSocket): Session | undefined {
    const id = this.owner.get(ws);
    return id ? this.get(id) : undefined;
  }

  async statuses(): Promise<SessionStatus[]> {
    return Promise.all([...this.entries.values()].map((e) => e.session.status()));
  }

  /** Attach a UI socket to a session (moving it if it was attached elsewhere) and send hello. */
  attach(ws: WebSocket, sessionId: string): boolean {
    const e = this.entries.get(sessionId);
    if (!e) return false;
    this.detach(ws);
    e.clients.add(ws);
    this.owner.set(ws, sessionId);
    e.streamer.clients = e.clients.size;
    const executor = e.session.executor;
    const hello: ServerMessage = {
      type: "hello",
      jev: { enabled: this.opts.decider.enabled, model: this.opts.decider.model },
      viewport: executor.viewport,
    };
    ws.send(JSON.stringify(hello));
    e.streamer.start();
    e.streamer.markDirty();
    void e.streamer.push(true);
    return true;
  }

  detach(ws: WebSocket): void {
    const id = this.owner.get(ws);
    if (!id) return;
    const e = this.entries.get(id);
    this.owner.delete(ws);
    if (!e) return;
    e.clients.delete(ws);
    e.streamer.clients = e.clients.size;
    if (e.clients.size === 0) e.streamer.stop();
  }

  requestFrame(ws: WebSocket): void {
    const e = this.entries.get(this.owner.get(ws) ?? "");
    if (!e) return;
    e.streamer.markDirty();
    void e.streamer.push(true);
  }

  broadcast(sessionId: string, msg: ServerMessage): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    const data = JSON.stringify(msg);
    for (const ws of e.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }

  async close(): Promise<void> {
    for (const id of [...this.entries.keys()]) {
      const e = this.entries.get(id)!;
      this.unregister(id);
      await e.session.executor.close();
    }
  }
}
