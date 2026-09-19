import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { PAGE_SCRIPT } from "../core/page-script.js";
import { pageScriptPlugin, pageScriptSource } from "../scripts/page-script-plugin.mjs";

describe("page-script plugin", () => {
  it("lifts the exact page script out of core without executing TypeScript", () => {
    expect(pageScriptSource()).toBe(PAGE_SCRIPT);
  });

  it("inlines it as real code behind virtual:page-script", async () => {
    const out = await build({
      stdin: { contents: 'import { listElements } from "virtual:page-script"; globalThis.__n = typeof listElements;', resolveDir: process.cwd() },
      bundle: true,
      write: false,
      format: "iife",
      plugins: [pageScriptPlugin()],
      logLevel: "silent",
    });
    const code = out.outputFiles[0]!.text;
    expect(code).toContain("data-jev-id");
    expect(code).not.toMatch(/eval\(|new Function/);
    new Function("globalThis", code)(globalThis);
    expect((globalThis as { __n?: string }).__n).toBe("function");
  });
});
