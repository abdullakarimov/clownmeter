// Draws the clown-nose icons as PNGs (no dependencies).
// The 128px icon keeps its artwork within the centre 96x96, as the Chrome Web Store asks;
// the small toolbar sizes use the full canvas so they stay legible.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SIZES = [
  { size: 16, radius: 0.47 },
  { size: 48, radius: 0.46 },
  { size: 128, radius: 0.375 }, // 96px circle + 16px transparent padding per side
];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};

function png(size, radius) {
  const SAMPLES = 4;
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  // Highlight sits up and to the left of centre, scaled with the nose.
  const hx = 0.5 - radius * 0.3;
  const hy = 0.5 - radius * 0.35;
  const hr = radius * 0.24;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const u = (x + (sx + 0.5) / SAMPLES) / size;
          const v = (y + (sy + 0.5) / SAMPLES) / size;
          const d = Math.hypot(u - 0.5, v - 0.5);
          if (d > radius) continue;
          const shade = 1 - (d / radius) * 0.35;
          let cr = 230 * shade, cg = 40 * shade, cb = 35 * shade;
          const h = Math.hypot(u - hx, v - hy);
          if (h < hr) {
            const t = (1 - h / hr) * 0.85;
            cr += (255 - cr) * t;
            cg += (255 - cg) * t;
            cb += (255 - cb) * t;
          }
          r += cr; g += cg; b += cb; hits++;
        }
      }
      const o = y * stride + 1 + x * 4;
      const n = hits || 1;
      raw[o] = r / n;
      raw[o + 1] = g / n;
      raw[o + 2] = b / n;
      raw[o + 3] = (hits / (SAMPLES * SAMPLES)) * 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const { size, radius } of SIZES) {
  writeFileSync(path.join(root, "icons", `${size}.png`), png(size, radius));
}
console.log(`Wrote icons/${SIZES.map((s) => `${s.size}.png`).join(", icons/")}`);
