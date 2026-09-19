/** The companion: HTTP + WebSocket server around a Hub of sessions. Built as a factory so
 *  the CLI (index.ts), the desktop app and the tests can all run one in-process. */
import { existsSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import type { Brain } from "../core/brain.js";
import type { Decider } from "../core/decide.js";
import type { Executor } from "../core/executor.js";
import type { Speaker } from "../core/speak.js";
import type { ClientMessage } from "../core/protocol.js";
import type { Computer } from "../core/session.js";
import { type Auth, allowedOrigins, createAuth, socketAllowed, tokenPresented } from "./auth.js";
import type { RemoteExecutor } from "./executors/remote.js";
import { demoPage } from "./demo.js";
import { createApi } from "./http.js";
import { Hub } from "./hub.js";
import { attachSttRelay } from "./stt/relay.js";
import type { SttProvider } from "./stt/types.js";

export interface CompanionOptions {
  decider: Decider;
  token?: string;
  /** Directory holding the built web client; served at / when present. */
  clientDir?: string;
  screenshotIntervalMs?: number;
  defaultSession?: string;
  /** Extra origins allowed to open UI sockets (e.g. "chrome-extension://*"). */
  extraOrigins?: string[];
  /** Streaming speech-to-text for /ws/stt; without one, UIs fall back to Web Speech. */
  stt?: SttProvider | null;
  /** Reads replies to voice commands aloud. */
  speaker?: Speaker | null;
  /** The agent behind the `hermes` route (Hermes); without one such commands stay local. */
  brain?: Brain | null;
  /** The Mac lane (open apps); without one "open slack" goes to the brain or is refused. */
  computer?: Computer | null;
  /** The user's Chrome, reached through the bridge extension on /ws/bridge. */
  bridge?: RemoteExecutor | null;
}

export interface Companion {
  hub: Hub;
  auth: Auth;
  /** Listen on every loopback address (localhost resolves to ::1 first on many Macs). */
  listen(port: number): Promise<number>;
  register(executor: Executor): void;
  close(): Promise<void>;
}

export function createCompanion(opts: CompanionOptions): Companion {
  const auth = createAuth(opts.token);
  const hub = new Hub({
    decider: opts.decider,
    screenshotIntervalMs: opts.screenshotIntervalMs ?? 700,
    defaultSession: opts.defaultSession,
    sttProvider: opts.stt?.name ?? null,
    speaker: opts.speaker,
    brain: opts.brain,
    computer: opts.computer,
  });

  const app = express();
  if (opts.clientDir) {
    const clientDir = opts.clientDir;
    app.use(express.static(clientDir));
    app.get("/", (_req, res, next) => {
      if (existsSync(path.join(clientDir, "index.html"))) return next();
      res.status(503).type("text").send("Client not built. Run `npm run build` (or `npm run dev` for the Vite dev server on :5173).");
    });
  }
  app.get("/demo", (req, res) => {
    res.type("html").send(demoPage(String(req.query.page ?? "home")));
  });
  app.use("/api", createApi({ hub, auth, decider: opts.decider }));

  const wss = new WebSocketServer({ noServer: true });
  const sttWss = new WebSocketServer({ noServer: true });
  const bridgeWss = new WebSocketServer({ noServer: true });
  let origins = allowedOrigins(0, opts.extraOrigins);

  // the bridge drives the user's browser: it always presents the token (the extension's
  // origin alone is not enough), and UIs follow Chrome while it is connected
  bridgeWss.on("connection", (ws: WebSocket) => {
    const bridge = opts.bridge;
    if (!bridge) return ws.close(1013, "no Chrome bridge configured");
    bridge.attach(ws);
  });

  sttWss.on("connection", (ws: WebSocket) => {
    if (!opts.stt) return ws.close(1013, "no speech-to-text provider configured");
    attachSttRelay(ws, { provider: opts.stt });
  });

  wss.on("connection", (ws: WebSocket) => {
    const defaultId = hub.defaultId;
    if (!defaultId || !hub.attach(ws, defaultId)) {
      ws.close(1013, "no session available");
      return;
    }
    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      const session = hub.sessionFor(ws);
      if (!session) return;
      switch (msg.type) {
        case "command":
          if (typeof msg.text === "string") void session.command(msg.text, { speak: msg.via === "voice" });
          break;
        case "confirm_reply":
          void session.reply(!!msg.ok);
          break;
        case "pick":
          void session.pick(String(msg.elementId));
          break;
        case "approval_reply":
          if (["once", "session", "always", "deny"].includes(String(msg.choice))) void session.approve(msg.choice);
          break;
        case "interrupt":
          session.interrupt();
          break;
        case "click_at":
          void session.clickAt(Number(msg.fx), Number(msg.fy));
          break;
        case "viewport":
          void session.setViewport(Number(msg.width), Number(msg.height));
          break;
        case "screenshot_request":
          hub.requestFrame(ws);
          break;
      }
    });
    ws.on("close", () => hub.detach(ws));
  });

  const servers: http.Server[] = [];
  const makeServer = () => {
    const server = http.createServer(app);
    server.on("upgrade", (req, socket, head) => {
      const pathname = req.url?.split("?")[0];
      const target = pathname === "/ws" ? wss : pathname === "/ws/stt" ? sttWss : pathname === "/ws/bridge" ? bridgeWss : null;
      if (!target) return socket.destroy();
      const allowed = target === bridgeWss ? tokenPresented(req, auth) : socketAllowed(req, auth, origins);
      if (!allowed) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        return socket.destroy();
      }
      target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
    });
    return server;
  };

  const listenOn = (server: http.Server, host: string, port: number) =>
    new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve((server.address() as AddressInfo).port);
      });
    });

  return {
    hub,
    auth,
    async listen(port) {
      const v4 = makeServer();
      const bound = await listenOn(v4, "127.0.0.1", port);
      servers.push(v4);
      try {
        const v6 = makeServer();
        await listenOn(v6, "::1", bound);
        servers.push(v6);
      } catch {
        /* no IPv6 loopback on this machine */
      }
      origins = allowedOrigins(bound, opts.extraOrigins);
      return bound;
    },
    register(executor) {
      hub.register(executor);
    },
    async close() {
      for (const ws of wss.clients) ws.terminate();
      for (const ws of sttWss.clients) ws.terminate();
      for (const ws of bridgeWss.clients) ws.terminate();
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
      await hub.close();
    },
  };
}
