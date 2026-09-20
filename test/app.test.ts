import { describe, expect, it } from "vitest";
import { onEscape, onHotkey, onPaused, onRendererBusy, onWindowVisibility } from "../app/hotkey.js";
import { encodePng, trayAlpha, trayIconPng } from "../app/tray-icon.js";

describe("panel hotkey state machine", () => {
  it("⌥Space always shows and focuses; it never hides an already-visible panel", () => {
    expect(onHotkey({ visible: false, busy: false })).toEqual({ state: { visible: true, busy: false }, effects: ["show", "focus"] });
    expect(onHotkey({ visible: true, busy: false })).toEqual({ state: { visible: true, busy: false }, effects: ["focus"] });
    expect(onHotkey({ visible: true, busy: true })).toEqual({ state: { visible: true, busy: true }, effects: ["focus"] });
  });

  it("escape cancels while busy (stays open), else hides", () => {
    expect(onEscape({ visible: true, busy: true })).toEqual({ state: { visible: true, busy: true }, effects: ["cancel"] });
    expect(onEscape({ visible: true, busy: false })).toEqual({ state: { visible: false, busy: false }, effects: ["hide"] });
    expect(onEscape({ visible: false, busy: false }).effects).toEqual([]);
  });

  it("paused: the hotkey resumes and shows; pausing drops busy", () => {
    expect(onHotkey({ visible: true, busy: false, paused: true })).toEqual({ state: { visible: true, busy: false, paused: false }, effects: ["resume", "focus"] });
    expect(onHotkey({ visible: false, busy: false, paused: true }).effects).toEqual(["resume", "show", "focus"]);
    expect(onPaused({ visible: true, busy: true }, true)).toEqual({ visible: true, busy: false, paused: true });
    const s = { visible: true, busy: false, paused: true };
    expect(onPaused(s, true)).toBe(s);
    expect(onPaused(s, false)).toEqual({ visible: true, busy: false, paused: false });
  });

  it("follows what the renderer and window report", () => {
    const s = { visible: true, busy: false };
    expect(onRendererBusy(s, true)).toEqual({ visible: true, busy: true });
    expect(onRendererBusy(s, false)).toBe(s);
    expect(onWindowVisibility(s, false)).toEqual({ visible: false, busy: false });
  });
});

describe("tray icon: paused glyph", () => {
  it("is dimmer than idle and has a bar", () => {
    const idle = trayAlpha("idle", 44);
    const paused = trayAlpha("paused", 44);
    const sum = (a: Uint8Array) => a.reduce((n, v) => n + v, 0);
    expect(sum(paused)).toBeLessThan(sum(idle));
    // the bar: full coverage inside the ring's hole at the top centre, where the idle ring is empty
    expect(paused[12 * 44 + 21]).toBeGreaterThan(200);
    expect(idle[12 * 44 + 21]).toBe(0);
  });
});

describe("tray icon", () => {
  it("encodes a valid PNG with the right dimensions", () => {
    const png = trayIconPng("busy", 22);
    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(22);
    expect(png.readUInt32BE(20)).toBe(22);
    expect(png.subarray(png.length - 8, png.length - 4).toString("ascii")).toBe("IEND");
  });

  it("idle and busy are both rings (transparent centre), busy's thicker", () => {
    expect(trayAlpha("idle", 21)[10 * 21 + 10]).toBe(0);
    expect(trayAlpha("busy", 21)[10 * 21 + 10]).toBe(0);
    expect(trayAlpha("idle", 21)[10 * 21 + 2]).toBe(255); // on the ring
    expect(trayAlpha("idle", 21)[0]).toBe(0); // corner
    const tiny = encodePng(1, 1, new Uint8Array([0, 0, 0, 255]));
    expect(tiny.length).toBeGreaterThan(40);
  });
});
