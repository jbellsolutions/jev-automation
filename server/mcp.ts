/** MCP server (stdio) so Claude Code and other agents can drive the Jev assistant. It is a
 *  thin HTTP client of a running companion — it never owns a browser — so one process keeps
 *  owning each surface and every caller sees the same session state.
 *
 *  Register:  claude mcp add jev -e JEV_TOKEN=... -- npx tsx /path/to/server/mcp.ts */
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { CommandResult, SessionStatus } from "../core/results.js";

export interface McpOptions {
  baseUrl: string;
  token: string | undefined;
  fetch?: typeof fetch;
}

class CompanionClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: McpOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.opts.baseUrl.replace(/\/$/, "") + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch((err: unknown) => {
      throw new Error(`companion unreachable at ${this.opts.baseUrl}: ${err instanceof Error ? err.message : String(err)}. Is it running (npm start)?`);
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
    lines.push(`⚠ Waiting for confirmation: ${r.pending.actionLabel} — ${r.pending.reason}`);
    lines.push(`Call jev_reply with {"ok": true} to proceed or {"ok": false} to cancel.`);
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
      title: "Run a browser command through Jev",
      description:
        'Speak to the Jev assistant: a natural-language browser command such as "open wikipedia.org", "click the pricing link", "type hello in the search box and press enter", "scroll to the bottom". Several steps can be chained with "and"/"then". Jev grounds each step against the live page; low-confidence picks come back as a clarification and risky actions as a confirmation — answer either with jev_reply.',
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
      description: "Resolve a pending confirmation ({ok: true|false}) or clarification ({pick: elementId}) left by jev_browse. Any parked steps of a multi-step command continue after a yes/pick.",
      inputSchema: { ok: z.boolean().optional(), pick: z.string().optional().describe("Element id from the clarification options, e.g. e3"), session: sessionArg },
    },
    async ({ ok: yes, pick, session }) => {
      try {
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
    },
    async () => {
      try {
        const [health, sessions] = await Promise.all([client.health(), client.sessions()]);
        const lines = [
          `Jev: ${health.jev.enabled ? `enabled (${health.jev.model})` : "disabled — keyword heuristics"}`,
          `Default session: ${sessions.default ?? "none"}`,
          ...sessions.sessions.map((s) => `- ${s.id} (${s.kind}) ${s.busy ? "busy" : "idle"}${s.pending ? ` · waiting: ${s.pending.kind}` : ""} · ${s.title ? `${s.title} — ` : ""}${s.url}`),
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
