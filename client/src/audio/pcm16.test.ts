import { describe, expect, it } from "vitest";
import { Framer, floatTo16BitPCM, resample } from "./pcm16.ts";

describe("floatTo16BitPCM", () => {
  it("scales and clamps", () => {
    expect(Array.from(floatTo16BitPCM(new Float32Array([0, 1, -1, 0.5, 2, -2])))).toEqual([0, 32767, -32768, 16383, 32767, -32768]);
  });
});

describe("resample", () => {
  it("is the identity at equal rates and halves length from 32k to 16k", () => {
    const input = new Float32Array([0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5]);
    expect(resample(input, 16000, 16000)).toBe(input);
    const out = resample(input, 32000, 16000);
    expect(out.length).toBe(4);
    expect(Array.from(out)).toEqual([0, 1, 0, -1]);
  });

  it("interpolates from 48k to 16k", () => {
    const input = new Float32Array(48).map((_, i) => i / 48);
    const out = resample(input, 48000, 16000);
    expect(out.length).toBe(16);
    expect(out[1]).toBeCloseTo(3 / 48, 5);
  });
});

describe("Framer", () => {
  it("emits fixed frames across chunk boundaries and pads the remainder on flush", () => {
    const f = new Framer(4);
    expect(f.push(new Int16Array([1, 2, 3]))).toEqual([]);
    const frames = f.push(new Int16Array([4, 5, 6, 7, 8, 9]));
    expect(frames.map((x) => Array.from(x))).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    expect(Array.from(f.flush()!)).toEqual([9, 0, 0, 0]);
    expect(f.flush()).toBeNull();
  });
});
