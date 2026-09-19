import { describe, expect, it } from "vitest";
import { onEscape, onHotkey, onRendererListening, onRendererSpeaking, onWindowVisibility } from "../app/hotkey.js";
import { encodePng, trayAlpha, trayIconPng } from "../app/tray-icon.js";

describe("panel hotkey state machine", () => {
  it("hidden → show and listen; visible idle → listen; listening → stop", () => {
    const a = onHotkey({ visible: false, listening: false });
    expect(a).toEqual({ state: { visible: true, listening: true }, effects: ["show", "focus", "start_listening"] });
    const b = onHotkey({ visible: true, listening: false });
    expect(b).toEqual({ state: { visible: true, listening: true }, effects: ["focus", "start_listening"] });
    const c = onHotkey({ visible: true, listening: true });
    expect(c).toEqual({ state: { visible: true, listening: false }, effects: ["stop_listening"] });
  });

  it("escape stops listening first, then hides", () => {
    expect(onEscape({ visible: true, listening: true })).toEqual({ state: { visible: true, listening: false }, effects: ["stop_listening"] });
    expect(onEscape({ visible: true, listening: false })).toEqual({ state: { visible: false, listening: false }, effects: ["hide"] });
    expect(onEscape({ visible: false, listening: false }).effects).toEqual([]);
  });

  it("while the assistant talks, the hotkey cuts it off first and keeps (or starts) listening", () => {
    expect(onHotkey({ visible: true, listening: true, speaking: true })).toEqual({ state: { visible: true, listening: true, speaking: false }, effects: ["interrupt"] });
    expect(onHotkey({ visible: true, listening: false, speaking: true })).toEqual({ state: { visible: true, listening: true, speaking: false }, effects: ["interrupt", "focus", "start_listening"] });
    expect(onHotkey({ visible: false, listening: false, speaking: true })).toEqual({ state: { visible: true, listening: true, speaking: false }, effects: ["interrupt", "show", "focus", "start_listening"] });
    expect(onEscape({ visible: true, listening: true, speaking: true })).toEqual({ state: { visible: true, listening: true, speaking: false }, effects: ["interrupt"] });
    expect(onRendererSpeaking({ visible: true, listening: true }, true)).toEqual({ visible: true, listening: true, speaking: true });
    const s = { visible: true, listening: true };
    expect(onRendererSpeaking(s, false)).toBe(s);
  });

  it("follows what the renderer and window report", () => {
    const s = { visible: true, listening: false };
    expect(onRendererListening(s, true)).toEqual({ visible: true, listening: true });
    expect(onRendererListening(s, false)).toBe(s);
    expect(onWindowVisibility(s, false)).toEqual({ visible: false, listening: false });
  });
});

describe("tray icon", () => {
  it("encodes a valid PNG with the right dimensions", () => {
    const png = trayIconPng("listening", 22);
    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(22);
    expect(png.readUInt32BE(20)).toBe(22);
    expect(png.subarray(png.length - 8, png.length - 4).toString("ascii")).toBe("IEND");
  });

  it("idle is a ring (transparent centre), listening a disc", () => {
    expect(trayAlpha("idle", 21)[10 * 21 + 10]).toBe(0);
    expect(trayAlpha("listening", 21)[10 * 21 + 10]).toBe(255);
    expect(trayAlpha("idle", 21)[10 * 21 + 2]).toBe(255); // on the ring
    expect(trayAlpha("idle", 21)[0]).toBe(0); // corner
    const tiny = encodePng(1, 1, new Uint8Array([0, 0, 0, 255]));
    expect(tiny.length).toBeGreaterThan(40);
  });
});
