import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnvFile, parseEnv } from "../server/env.js";

describe("env file", () => {
  it("parses KEY=value lines, quotes, comments and export prefixes", () => {
    expect(parseEnv('# c\nA=1\nexport B="two words"\nC=\'x\' \nD=val # note\nE=\n\nnot a line\n')).toEqual({ A: "1", B: "two words", C: "x", D: "val", E: "" });
  });
  it("fills only what the shell did not set; missing file is fine", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jev-env-"));
    const file = path.join(dir, ".env");
    writeFileSync(file, "HERMES_API_KEY=fromfile\nPORT=3000\nEMPTY_IN_SHELL=filled\n");
    const env: NodeJS.ProcessEnv = { PORT: "4000", EMPTY_IN_SHELL: "" };
    expect(loadEnvFile(file, env).sort()).toEqual(["EMPTY_IN_SHELL", "HERMES_API_KEY"]);
    expect(env).toEqual({ PORT: "4000", EMPTY_IN_SHELL: "filled", HERMES_API_KEY: "fromfile" });
    expect(loadEnvFile(path.join(dir, "nope"), env)).toEqual([]);
  });
});
