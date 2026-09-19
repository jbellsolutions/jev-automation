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
    res.json({ ok: true, jev: { enabled: decider.enabled, model: decider.model }, url: session?.executor.url ?? null, sessions: (await hub.statuses()).map((s) => s.id) });
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
    res.json({ default: hub.defaultId, sessions: await hub.statuses() });
  });

  api.post("/command", async (req, res) => {
    const { text, session: id } = (req.body ?? {}) as { text?: unknown; session?: unknown };
    if (typeof text !== "string" || !text.trim()) return void res.status(400).json({ error: "text is required" });
    const session = resolve(res, id);
    if (!session) return;
    res.json(await session.command(text));
  });

  api.post("/reply", async (req, res) => {
    const { ok, pick, session: id } = (req.body ?? {}) as { ok?: unknown; pick?: unknown; session?: unknown };
    const session = resolve(res, id);
    if (!session) return;
    if (typeof pick === "string") return void res.json(await session.pick(pick));
    if (typeof ok === "boolean") return void res.json(await session.reply(ok));
    res.status(400).json({ error: "pass ok: boolean or pick: elementId" });
  });

  api.post("/cancel", (req, res) => {
    const session = resolve(res, (req.body ?? {}).session);
    if (!session) return;
    session.cancel();
    res.json({ ok: true });
  });

  return api;
}
