/** MCP server (stdio) so Claude Code and other agents can drive the Jev assistant. It is a
 *  thin HTTP client of a running companion — it never owns a browser — so one process keeps
 *  owning each surface and every caller sees the same session state.
 *
 *  Register:  claude mcp add jev -e JEV_TOKEN=... -- npx tsx /path/to/server/mcp.ts
 *  (or as a stdio entry under mcp_servers in ~/.hermes/config.yaml so Hermes gets these tools).
 *  JEV_SERVER_URL may list several companions, comma separated; the first one up is used. */
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { CommandResult, SessionStatus } from "../core/results.js";

export interface McpOptions {
  /** One base URL, or several separated by commas: the first one whose /api/health answers is
   *  used (the desktop app listens on 3111, `npm start` on 3000). */
  baseUrl: string;
  token: string | undefined;
  fetch?: typeof fetch;
}

export function baseUrlCandidates(spec: string): string[] {
  return spec
    .split(",")
    .map((u) => u.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

class CompanionClient {
  private readonly fetchImpl: typeof fetch;
  private readonly candidates: string[];
  private base: string | null = null;
  constructor(private readonly opts: McpOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.candidates = baseUrlCandidates(opts.baseUrl);
    if (this.candidates.length === 1) this.base = this.candidates[0]!;
  }

  /** Probe the candidates in order; remembered until one fails to answer. */
  private async resolveBase(): Promise<string> {
    if (this.base) return this.base;
    for (const url of this.candidates) {
      try {
        const res = await this.fetchImpl(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) return (this.base = url);
      } catch {
        /* next */
      }
    }
    throw new Error(`companion unreachable at ${this.candidates.join(" or ")}. Is it running (npm run app, or npm start)?`);
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const base = await this.resolveBase();
    const res = await this.fetchImpl(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch((err: unknown) => {
      if (this.candidates.length > 1) this.base = null; // re-probe next time
      throw new Error(`companion unreachable at ${base}: ${err instanceof Error ? err.message : String(err)}. Is it running (npm start)?`);
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) {
      const msg = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : text || res.statusText;
      throw new Error(`companion ${method} ${path} → ${res.status}: ${msg}`);
    }
    return data as T;
  }

  health() {
    return this.request<{ ok: boolean; jev: { enabled: boolean; model: string | null }; url: string | null; sessions: string[] }>("GET", "/api/health");
  }
  sessions() {
    return this.request<{ default: string | null; sessions: SessionStatus[] }>("GET", "/api/sessions");
  }
  command(text: string, session?: string) {
    return this.request<CommandResult>("POST", "/api/command", { text, session });
  }
  reply(body: { ok?: boolean; pick?: string; session?: string }) {
    return this.request<CommandResult>("POST", "/api/reply", body);
  }
  cancel(session?: string) {
    return this.request<{ ok: boolean }>("POST", "/api/cancel", { session });
  }
}

const pct = (p: number | undefined) => (p == null ? "" : `${Math.round(p * 100)}%`);

/** Human-readable rendering of a CommandResult for the model reading the tool output. */
export function renderResult(r: CommandResult): string {
  const lines: string[] = [];
  r.steps.forEach((s, i) => {
    const d = s.decision;
    const head = r.steps.length > 1 ? `${i + 1}. ` : "";
    const how = d ? ` [${d.source === "jev" ? (d.model ?? "jev") : "heuristic"} · ${d.intent} ${pct(d.intentConfidence)}${d.targetConfidence != null ? ` · target ${pct(d.targetConfidence)}` : ""} · ${d.latencyMs} ms]` : "";
    const did = d ? `→ ${d.actionLabel}` : "";
    const out = s.result ? ` ${s.result.level === "error" ? "✗" : s.result.level === "warn" ? "⚠" : "✓"} ${s.result.text}` : "";
    const checked = s.verify ? ` (check: ${s.verify.text})` : "";
    lines.push(`${head}"${s.command}" ${did}${how}${out}${checked}`.trim());
  });
  if (r.pending?.kind === "confirm") {
    lines.push(`⚠ Waiting for the user's confirmation: ${r.pending.actionLabel} — ${r.pending.reason}`);
    lines.push(`Only the user can confirm this, in the Jev panel or by voice; tell them what is waiting. Call jev_reply with {"ok": false} to cancel it instead. Retrying with {"ok": true} will not work.`);
  } else if (r.pending?.kind === "approval") {
    lines.push(`⚠ ${r.pending.question} (waiting for the user)`);
  } else if (r.pending?.kind === "clarify") {
    lines.push(`? ${r.pending.question}`);
    for (const o of r.pending.options) lines.push(`   ${o.elementId}: ${o.label} (${pct(o.probability)})`);
    lines.push(`Call jev_reply with {"pick": "<elementId>"} to choose.`);
  }
  if (r.stoppedAt !== undefined && !r.pending && !r.ok) lines.push(`Stopped at step ${r.stoppedAt + 1}; later steps of the request did not run.`);
  lines.push(`Page: ${r.page.title ? `${r.page.title} — ` : ""}${r.page.url}`);
  return lines.join("\n");
}

const sessionArg = z.string().optional().describe('Session id (executor) to use, e.g. "playwright" or "chrome". Defaults to the companion\'s default session.');

export function createJevMcpServer(opts: McpOptions): McpServer {
  const client = new CompanionClient(opts);
  const server = new McpServer({ name: "jev", version: "0.1.0" });

  const ok = (text: string, structured?: Record<string, unknown>) => ({ content: [{ type: "text" as const, text }], structuredContent: structured });
  const fail = (err: unknown) => ({ content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }], isError: true });

  server.registerTool(
    "jev_browse",
    {
      title: "Run a command on what the user has in front of them, through Jev",
      description:
        'Speak to the Jev assistant: a natural-language command on the surface in front of the user — their Chrome tab when a browser is in front, otherwise the Mac app in front (its accessibility tree) — such as "open wikipedia.org", "click the pricing link", "type hello in the search box and press enter", "scroll to the bottom", "open slack", "open my resume". Several steps can be chained with "and"/"then". Jev grounds each step against the live page or window; low-confidence picks come back as a clarification and risky actions as a confirmation — answer either with jev_reply. jev_status tells you which surface is in front (a URL, or app://<name>).',
      inputSchema: { command: z.string().min(1).describe("The command, as you would say it aloud."), session: sessionArg },
    },
    async ({ command, session }) => {
      try {
        const r = await client.command(command, session);
        return ok(renderResult(r), r as unknown as Record<string, unknown>);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "jev_reply",
    {
      title: "Answer a pending Jev question",
      description:
        "Resolve a pending clarification ({pick: elementId}) left by jev_browse, or cancel a pending confirmation ({ok: false}). Confirming a risky action ({ok: true}) is reserved for the user, who answers in the Jev panel or by voice. Any parked steps of a multi-step command continue after a pick.",
      inputSchema: { ok: z.boolean().optional(), pick: z.string().optional().describe("Element id from the clarification options, e.g. e3"), session: sessionArg },
    },
    async ({ ok: yes, pick, session }) => {
      try {
        if (yes === true) {
          const { sessions, default: def } = await client.sessions();
          const target = sessions.find((s) => s.id === (session ?? def));
          if (target?.pending && target.pending.kind !== "clarify") {
            return fail(new Error(`Only the user can confirm "${target.pending.kind === "confirm" ? target.pending.actionLabel : target.pending.question}" — in the Jev panel or by voice. Tell them it is waiting; do not retry. {"ok": false} cancels it.`));
          }
        }
        const r = await client.reply({ ok: yes, pick, session });
        return ok(renderResult(r), r as unknown as Record<string, unknown>);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "jev_status",
    {
      title: "Jev assistant status",
      description: "Which surfaces (sessions) are connected, what page each is on, whether one is busy or waiting on a question, and whether Jev itself is enabled.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const [health, sessions] = await Promise.all([client.health(), client.sessions()]);
        const lines = [
          `Jev: ${health.jev.enabled ? `enabled (${health.jev.model})` : "disabled — keyword heuristics"}`,
          `Default session: ${sessions.default ?? "none"}`,
          ...sessions.sessions.map((s) =>
            s.ready === false
              ? `- ${s.id} (${s.kind}) not connected${s.kind === "chrome" ? " — the user's Chrome needs the Jev bridge extension running" : s.kind === "mac" ? " — cua-driver is not answering" : ""}`
              : `- ${s.id} (${s.kind}) ${s.busy ? "busy" : "idle"}${s.pending ? ` · waiting for the user: ${s.pending.kind}` : ""} · ${s.title ? `${s.title} — ` : ""}${s.url}`,
          ),
        ];
        return ok(lines.join("\n"), { ...health, ...sessions });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "jev_cancel",
    {
      title: "Stop the Jev assistant",
      description: "Drop any pending question and parked steps on a session.",
      inputSchema: { session: sessionArg },
    },
    async ({ session }) => {
      try {
        await client.cancel(session);
        return ok("Stopped.");
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = createJevMcpServer({
    baseUrl: process.env.JEV_SERVER_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`,
    token: process.env.JEV_TOKEN,
  });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
