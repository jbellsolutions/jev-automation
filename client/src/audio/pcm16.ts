/** Pure audio helpers for the microphone path: Float32 → Int16 PCM, resampling, framing.
 *  Kept free of Web Audio types so they run (and are tested) in Node. */

export function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Linear-interpolation resampler; good enough for speech going to a recognizer. Returns the
 *  input untouched when the rates match. */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = pos - lo;
    out[i] = input[lo]! * (1 - frac) + input[hi]! * frac;
  }
  return out;
}

/** Accumulates samples and hands back fixed-size frames (e.g. 100 ms = 1600 samples at 16 kHz). */
export class Framer {
  private pending: Int16Array[] = [];
  private pendingLength = 0;

  constructor(readonly frameSamples: number) {}

  push(samples: Int16Array): Int16Array[] {
    this.pending.push(samples);
    this.pendingLength += samples.length;
    const frames: Int16Array[] = [];
    while (this.pendingLength >= this.frameSamples) {
      const frame = new Int16Array(this.frameSamples);
      let filled = 0;
      while (filled < this.frameSamples) {
        const head = this.pending[0]!;
        const take = Math.min(head.length, this.frameSamples - filled);
        frame.set(head.subarray(0, take), filled);
        filled += take;
        if (take === head.length) this.pending.shift();
        else this.pending[0] = head.subarray(take);
        this.pendingLength -= take;
      }
      frames.push(frame);
    }
    return frames;
  }

  /** Whatever is left, zero-padded to a full frame (for the end of a stream). */
  flush(): Int16Array | null {
    if (this.pendingLength === 0) return null;
    const frame = new Int16Array(this.frameSamples);
    let filled = 0;
    for (const chunk of this.pending) {
      frame.set(chunk.subarray(0, this.frameSamples - filled), filled);
      filled += Math.min(chunk.length, this.frameSamples - filled);
    }
    this.pending = [];
    this.pendingLength = 0;
    return frame;
  }
}

/** Source of the AudioWorklet processor that posts raw Float32 blocks to the main thread.
 *  Worklets cannot import modules, so it stays a self-contained string loaded via a blob URL. */
export const PCM_WORKLET_SOURCE = `
class JevCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let i = 0;
    while (i < channel.length) {
      const take = Math.min(channel.length - i, this.buffer.length - this.offset);
      this.buffer.set(channel.subarray(i, i + take), this.offset);
      this.offset += take;
      i += take;
      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(2048);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("jev-capture", JevCapture);
`;
