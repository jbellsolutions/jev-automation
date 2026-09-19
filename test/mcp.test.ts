import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { HeuristicDecider } from "../core/decide.js";
import { type Companion, createCompanion } from "../server/companion.js";
import { createJevMcpServer, renderResult } from "../server/mcp.js";
import { FakeExecutor, el } from "./helpers/fake-executor.js";

const TOKEN = "t";
let companion: Companion | null = null;
let client: Client | null = null;

async function boot(elements: Parameters<typeof el>[1][] = [], token: string | undefined = TOKEN) {
  const executor = new FakeExecutor(elements.map((o, i) => el(`e${i}`, o)), "playwright");
  companion = createCompanion({ decider: new HeuristicDecider(), token: TOKEN });
  const port = await companion.listen(0);
  companion.register(executor);
  const server = createJevMcpServer({ baseUrl: `http://127.0.0.1:${port}`, token });
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

  it("surfaces a confirmation and resolves it with jev_reply", async () => {
    const { executor, call } = await boot([{ tag: "button", text: "Delete account" }]);
    const first = await call("jev_browse", { command: "click delete account" });
    expect(first.text).toMatch(/Waiting for confirmation: Click button "Delete account"/);
    expect(first.text).toMatch(/jev_reply with \{"ok": true\}/);
    expect(executor.executed).toEqual([]);
    const second = await call("jev_reply", { ok: true });
    expect(second.isError).toBe(false);
    expect(executor.executed).toHaveLength(1);
  });

  it("surfaces a clarification with element ids and accepts a pick", async () => {
    const { executor, call } = await boot([{ text: "Pricing", hrefShort: "/pricing" }, { text: "Pricing FAQ", hrefShort: "/faq" }, { text: "Pricing plans", hrefShort: "/plans" }]);
    const first = await call("jev_browse", { command: "click pricing" });
    expect(first.text).toMatch(/\? Which one did you mean/);
    expect(first.text).toMatch(/e1: link "Pricing FAQ"/);
    await call("jev_reply", { pick: "e2" });
    expect(executor.executed).toEqual([{ kind: "click", elementId: "e2", label: 'link "Pricing plans" → /plans' }]);
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
      steps: [{ command: "open a.com", decision: null, result: { text: "boom", level: "error" } }, { command: "scroll down", decision: null, result: null }],
      page: { url: "https://a.com", title: "" },
      pending: null,
      stoppedAt: 0,
    });
    expect(text).toContain("✗ boom");
    expect(text).toContain("Stopped after step 1 of 2.");
  });
});
