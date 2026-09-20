/** JSON API for programmatic callers: the MCP server, scripts, and later the phone. Every
 *  route except /api/health requires the bearer token. */
import { type Response, Router, json } from "express";
import type { Decider } from "../core/decide.js";
import type { Session } from "../core/session.js";
import type { Auth } from "./auth.js";
import type { Hub } from "./hub.js";

export interface ApiDeps {
  hub: Hub;
  auth: Auth;
  decider: Decider;
}

export function createApi({ hub, auth, decider }: ApiDeps): Router {
  const api = Router();
  api.use(json({ limit: "64kb" }));

  api.get("/health", async (_req, res) => {
    const def = hub.defaultId;
    const session = def ? hub.get(def) : undefined;
    res.json({ ok: true, paused: hub.paused, jev: { enabled: decider.enabled, model: decider.model }, url: session?.executor.url ?? null, sessions: (await hub.statuses()).map((s) => s.id) });
  });

  api.use(auth.bearer);

  const resolve = (res: Response, id: unknown): Session | null => {
    const wanted = typeof id === "string" && id ? id : hub.defaultId;
    const session = wanted ? hub.get(wanted) : undefined;
    if (!session) {
      res.status(404).json({ error: wanted ? `no session "${wanted}"` : "no session available" });
      return null;
    }
    return session;
  };

  api.get("/sessions", async (_req, res) => {
    res.json({ default: hub.defaultId, paused: hub.paused, sessions: await hub.statuses() });
  });

  /** Browser/Mac only: the brain's own jev_browse tool comes through here, so a command must
   *  never bounce back into the brain. Use /ask for that. */
  const PAUSED = "Jev is paused: the user switched the assistant off. Nothing runs on this Mac until they resume it.";
  const paused = (res: Response): boolean => {
    if (!hub.paused) return false;
    res.status(409).json({ error: PAUSED });
    return true;
  };

  api.post("/command", async (req, res) => {
    const { text, session: id } = (req.body ?? {}) as { text?: unknown; session?: unknown };
    if (typeof text !== "string" || !text.trim()) return void res.status(400).json({ error: "text is required" });
    if (paused(res)) return;
    const session = resolve(res, id);
    if (!session) return;
    res.json(await session.command(text, { local: true }));
  });

  api.post("/pause", (req, res) => {
    hub.setPaused(!!(req.body ?? {}).paused);
    res.json({ ok: true, paused: hub.paused });
  });

  api.post("/reply", async (req, res) => {
    const { ok, pick, session: id } = (req.body ?? {}) as { ok?: unknown; pick?: unknown; session?: unknown };
    const session = resolve(res, id);
    if (!session) return;
    if (typeof pick === "string") return void res.json(await session.pick(pick));
    if (typeof ok === "boolean") return void res.json(await session.reply(ok));
    res.status(400).json({ error: "pass ok: boolean or pick: elementId" });
  });

  /** Like /command, but waits for the brain's final answer when the text goes to it. */
  api.post("/ask", async (req, res) => {
    const { text, session: id } = (req.body ?? {}) as { text?: unknown; session?: unknown };
    if (typeof text !== "string" || !text.trim()) return void res.status(400).json({ error: "text is required" });
    if (paused(res)) return;
    const session = resolve(res, id);
    if (!session) return;
    res.json(await session.ask(text));
  });

  api.post("/approve", async (req, res) => {
    const { choice, session: id } = (req.body ?? {}) as { choice?: unknown; session?: unknown };
    const session = resolve(res, id);
    if (!session) return;
    if (choice !== "once" && choice !== "session" && choice !== "always" && choice !== "deny") return void res.status(400).json({ error: "choice must be once | session | always | deny" });
    res.json(await session.approve(choice));
  });

  api.post("/cancel", (req, res) => {
    const session = resolve(res, (req.body ?? {}).session);
    if (!session) return;
    session.cancel();
    res.json({ ok: true });
  });

  return api;
}
