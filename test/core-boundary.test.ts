import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** core/ is shared by the server, the desktop app, the Chrome bridge and the MCP server, so it must stay free
 *  of runtime dependencies on any one host. */
const FORBIDDEN = /from\s+["'](playwright|express|ws|react|react-dom|electron)["']|\bchrome\.[a-z]/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

describe("core/ boundary", () => {
  const files = walk(path.join(process.cwd(), "core"));
  it("has modules", () => expect(files.length).toBeGreaterThan(0));
  it.each(files)("%s imports no host runtime", (file) => {
    expect(readFileSync(file, "utf8")).not.toMatch(FORBIDDEN);
  });
});
