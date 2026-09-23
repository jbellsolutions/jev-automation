import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createGuard, scopeOfAddress, targetScope } from "../core/scope.js";

// The same file drives browser-box's Python guard; browser-box checks the copies are identical.
const { vectors } = JSON.parse(readFileSync(new URL("./scope-vectors.json", import.meta.url), "utf8")) as {
  vectors: [string, string][];
};

describe("targetScope — shared vectors with browser-box's Python guard", () => {
  it("has a real set of vectors", () => expect(vectors.length).toBeGreaterThan(25));
  for (const [url, expected] of vectors) {
    it(`${JSON.stringify(url)} is ${expected}`, () => expect(targetScope(url)).toBe(expected));
  }
});

describe("scopeOfAddress", () => {
  it("unwraps IPv4-mapped IPv6 instead of calling it public", () => {
    expect(scopeOfAddress("::ffff:127.0.0.1")).toBe("loopback");
    expect(scopeOfAddress("::ffff:7f00:1")).toBe("loopback");
    expect(scopeOfAddress("::ffff:169.254.169.254")).toBe("link_local");
  });
  it("is not fooled by a public-looking v6", () => expect(scopeOfAddress("2606:4700:4700::1111")).toBe("public_web"));
});

describe("createGuard — every request a Jev-driven browser makes", () => {
  const resolvesTo = (...addresses: string[]) => async () => addresses;

  it("lets a public name through", async () => {
    const check = createGuard(resolvesTo("93.184.216.34"));
    expect(await check("https://example.com/")).toEqual({ allowed: true, scope: "public_web" });
  });

  it("refuses Steel's own API — the navigation proven on 2026-09-23", async () => {
    const check = createGuard(resolvesTo("93.184.216.34"));
    const verdict = await check("http://127.0.0.1:3000/v1/sessions");
    expect(verdict.allowed).toBe(false);
    expect(verdict.scope).toBe("loopback");
  });

  it("refuses a compose service name", async () => {
    const check = createGuard(resolvesTo("93.184.216.34"));
    expect((await check("http://gateway:8080/mcp")).allowed).toBe(false);
  });

  it("refuses a public name that resolves inward", async () => {
    const check = createGuard(resolvesTo("10.0.0.5"));
    const verdict = await check("https://looks-fine.example/");
    expect(verdict).toMatchObject({ allowed: false, scope: "private_network" });
    expect(verdict.reason).toContain("10.0.0.5");
  });

  it("refuses when one public record sits beside the metadata service", async () => {
    const check = createGuard(resolvesTo("93.184.216.34", "169.254.169.254"));
    expect(await check("https://split.example/")).toMatchObject({ allowed: false, scope: "link_local" });
  });

  it("refuses a name that does not resolve instead of guessing", async () => {
    const check = createGuard(async () => {
      throw new Error("ENOTFOUND");
    });
    expect((await check("https://nowhere.invalid/")).allowed).toBe(false);
  });

  it("never blocks data:, blob: or about: — they never leave the browser", async () => {
    const check = createGuard(resolvesTo("10.0.0.5"));
    for (const url of ["data:text/html,hi", "about:blank", "blob:https://example.com/uuid"]) {
      expect((await check(url)).allowed).toBe(true);
    }
  });

  it("refuses file:", async () => {
    const check = createGuard(resolvesTo("93.184.216.34"));
    expect(await check("file:///etc/passwd")).toMatchObject({ allowed: false, scope: "local_file" });
  });

  it("asks DNS once per host, not once per request", async () => {
    let lookups = 0;
    const check = createGuard(async () => {
      lookups++;
      return ["93.184.216.34"];
    });
    for (let i = 0; i < 20; i++) await check(`https://example.com/asset-${i}.png`);
    expect(lookups).toBe(1);
  });
});
