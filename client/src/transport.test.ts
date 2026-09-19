import { describe, expect, it } from "vitest";
import { detectTransport } from "./transport.ts";

describe("detectTransport", () => {
  it("uses the serving host on the web", () => {
    const t = detectTransport({ location: { protocol: "http:", host: "localhost:3000" } as Location });
    expect(t.mode).toBe("web");
    expect(t.wsUrl("/ws/stt")).toBe("ws://localhost:3000/ws/stt");
  });

  it("uses the preload bridge on the desktop", () => {
    const t = detectTransport({ jev: { mode: "desktop", baseUrl: "http://127.0.0.1:3111", token: "t" }, location: { protocol: "file:", host: "" } as Location });
    expect(t.mode).toBe("desktop");
    expect(t.wsUrl("/ws")).toBe("ws://127.0.0.1:3111/ws");
  });
});
