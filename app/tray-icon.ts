/** A menu-bar template icon drawn in code (no binary assets): a ring, thinner while busy.
 *  PNG is written by hand — RGBA, no filters, one zlib stream. */
import { deflateSync } from "node:zlib";

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.subarray(y * width * 4, (y + 1) * width * 4).forEach((v, i) => (raw[y * (width * 4 + 1) + 1 + i] = v));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
}

export type TrayKind = "idle" | "busy" | "paused";

/** Alpha coverage of the icon, row-major: a ring when idle, a thick ring when busy, a faint
 *  ring with a bar through it (a power-off glyph) when paused. */
export function trayAlpha(kind: TrayKind, size: number): Uint8Array {
  const alpha = new Uint8Array(size * size);
  const c = (size - 1) / 2;
  const outer = size * 0.42;
  const inner = kind === "idle" || kind === "paused" ? size * 0.3 : size * 0.18;
  const barHalf = size * 0.06;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      // anti-aliased ring: coverage falls off over one pixel at each edge
      let cover = Math.max(0, Math.min(1, outer + 0.5 - d)) * Math.max(0, Math.min(1, d - inner + 0.5));
      if (kind === "paused") {
        cover *= 0.45; // dimmed ring…
        const bar = Math.max(0, Math.min(1, barHalf + 0.5 - Math.abs(x - c))) * (y >= c - outer && y <= c ? 1 : 0);
        cover = Math.max(cover, bar); // …with a vertical bar from the top edge to the centre
      }
      alpha[y * size + x] = Math.round(cover * 255);
    }
  }
  return alpha;
}

/** `size` px square, black with alpha (macOS tints template images itself). */
export function trayIconPng(kind: TrayKind, size = 44): Buffer {
  const alpha = trayAlpha(kind, size);
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < alpha.length; i++) rgba[i * 4 + 3] = alpha[i]!;
  return encodePng(size, size, rgba);
}
