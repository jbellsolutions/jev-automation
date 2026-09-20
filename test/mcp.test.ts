import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { HeuristicDecider } from "../core/decide.js";
import { type Companion, createCompanion } from "../server/companion.js";
import { baseUrlCandidates, createJevMcpServer, renderResult } from "../server/mcp.js";
import { FakeExecutor, el } from "./helpers/fake-executor.js";

const TOKEN = "t";
let companion: Companion | null = null;
let client: Client | null = null;

async function boot(elements: Parameters<typeof el>[1][] = [], token: string | undefined = TOKEN, baseUrl?: (port: number) => string) {
  const executor = new FakeExecutor(elements.map((o, i) => el(`e${i}`, o)), "playwright");
  companion = createCompanion({ decider: new HeuristicDecider(), token: TOKEN });
  const port = await companion.listen(0);
  companion.register(executor);
  const server = createJevMcpServer({ baseUrl: baseUrl ? baseUrl(port) : `http://127.0.0.1:${port}`, token });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client!.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
    return { text: r.content.map((c) => c.text ?? "").join("\n"), data: r.structuredContent as Record<string, unknown> | undefined, isError: !!r.isError };
  };
  return { executor, call };
}

afterEach(async () => {
  await client?.close();
  await companion?.close();
  client = companion = null;
});

describe("MCP server", () => {
  it("lists the four tools", async () => {
    await boot();
    const tools = (await client!.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["jev_browse", "jev_cancel", "jev_reply", "jev_status"]);
  });

  it("jev_browse runs a command and renders each step", async () => {
    const { executor, call } = await boot();
    const r = await call("jev_browse", { command: "open wikipedia and scroll down" });
    expect(r.isError).toBe(false);
    expect(executor.executed.map((a) => a.kind)).toEqual(["navigate", "scroll"]);
    expect(r.text).toMatch(/1\. "open wikipedia" → Open https:\/\/www\.wikipedia\.org \[heuristic · open_url/);
    expect(r.text).toMatch(/2\. "scroll down" → Scroll down/);
    expect(r.text).toMatch(/Page: .*wikipedia/);
    expect(r.data).toMatchObject({ ok: true });
  });

  it("surfaces a confirmation that only the user can give; jev_reply may cancel it", async () => {
    const { executor, call } = await boot([{ tag: "button", text: "Delete account" }]);
    const first = await call("jev_browse", { command: "click delete account" });
    expect(first.text).toMatch(/Waiting for the user's confirmation: Click button "Delete account"/);
    expect(first.text).toMatch(/Only the user can confirm/);
    expect(executor.executed).toEqual([]);
    const refused = await call("jev_reply", { ok: true });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/Only the user can confirm "Click button "Delete account""/);
    expect(executor.executed).toEqual([]);
    const cancelled = await call("jev_reply", { ok: false });
    expect(cancelled.isError).toBe(false);
    expect(cancelled.text).toMatch(/Cancelled: Click button/);
    expect(executor.executed).toEqual([]);
    const status = await call("jev_status");
    expect(status.text).not.toMatch(/waiting/);
  });

  it("jev_reply {ok: true} still works when nothing risky is pending", async () => {
    const { call } = await boot();
    const r = await call("jev_reply", { ok: true });
    expect(r.isError).toBe(false);
  });

  it("surfaces a clarification with element ids and accepts a pick", async () => {
    const { executor, call } = await boot([{ text: "Pricing", hrefShort: "/pricing" }, { text: "Pricing FAQ", hrefShort: "/faq" }, { text: "Pricing plans", hrefShort: "/plans" }]);
    const first = await call("jev_browse", { command: "click pricing" });
    expect(first.text).toMatch(/\? Which one did you mean/);
    expect(first.text).toMatch(/e1: link "Pricing FAQ"/);
    await call("jev_reply", { pick: "e2" });
    expect(executor.executed).toEqual([{ kind: "click", elementId: "e2", label: 'link "Pricing plans" → /plans' }]);
  });

  it("tries several companion URLs and uses the first one that answers", async () => {
    const { call } = await boot([], TOKEN, (port) => `http://127.0.0.1:1, http://127.0.0.1:${port}/`);
    const r = await call("jev_status");
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/- playwright/);
    expect(baseUrlCandidates("http://a:1/,, http://b:2 ")).toEqual(["http://a:1", "http://b:2"]);
  });

  it("jev_status reports sessions and Jev mode", async () => {
    const { call } = await boot();
    const r = await call("jev_status");
    expect(r.text).toMatch(/Jev: disabled/);
    expect(r.text).toMatch(/- playwright \(playwright\) idle/);
  });

  it("jev_cancel drops a pending question", async () => {
    const { executor, call } = await boot([{ tag: "button", text: "Delete account" }]);
    await call("jev_browse", { command: "click delete account" });
    expect((await call("jev_cancel")).text).toBe("Stopped.");
    await call("jev_reply", { ok: true });
    expect(executor.executed).toEqual([]);
  });

  it("returns a tool error, not a crash, on a bad token or a dead companion", async () => {
    const { call } = await boot([], "wrong");
    const r = await call("jev_status");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/401/);
    const dead = createJevMcpServer({ baseUrl: "http://127.0.0.1:1", token: "x" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await dead.connect(a);
    const c = new Client({ name: "t2", version: "0" });
    await c.connect(b);
    const res = (await c.callTool({ name: "jev_browse", arguments: { command: "open a.com" } })) as { isError?: boolean; content: Array<{ text?: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/companion unreachable/);
    await c.close();
  });
});

describe("renderResult", () => {
  it("marks stopped sequences", () => {
    const text = renderResult({
      ok: false,
      steps: [{ stepId: 1, command: "open a.com", decision: null, result: { text: "boom", level: "error" } }],
      page: { url: "https://a.com", title: "" },
      pending: null,
      stoppedAt: 0,
    });
    expect(text).toContain("✗ boom");
    expect(text).toContain("Stopped at step 1; later steps of the request did not run.");
  });
});
