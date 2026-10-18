// Writes public/favicon.ico: the editor's logo (the header .logo in style.css) at several sizes.
// A rounded square filled with a clockwise conic gradient, drawn with 4x4 supersampling.
// No dependencies. Run: node tools/make-icon.js
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SIZES = [16, 24, 32, 48, 256];
const STOPS = ['#0019ff', '#00a6ff', '#5b2bff', '#b026ff', '#0019ff'].map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)));
const RADIUS = 7 / 22; // corner radius as a fraction of the size, as in the CSS
const SS = 4;

// Colour at a point, as CSS conic-gradient(from 0deg, ...) does: 0 = 12 o'clock, clockwise.
function conic(x, y) {
  let t = Math.atan2(x - 0.5, 0.5 - y) / (2 * Math.PI);
  if (t < 0) t += 1;
  const f = t * (STOPS.length - 1);
  const i = Math.min(Math.floor(f), STOPS.length - 2);
  const k = f - i;
  return STOPS[i].map((c, n) => c + (STOPS[i + 1][n] - c) * k);
}

function inside(x, y) {
  const r = RADIUS;
  const dx = Math.max(r - x, x - (1 - r), 0);
  const dy = Math.max(r - y, y - (1 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

function render(n) {
  const raw = Buffer.alloc((n * 4 + 1) * n); // PNG scanlines: filter byte 0 + RGBA
  for (let py = 0; py < n; py++) {
    raw[py * (n * 4 + 1)] = 0;
    for (let px = 0; px < n; px++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        if (inside((px + (sx + 0.5) / SS) / n, (py + (sy + 0.5) / SS) / n)) hit++;
      }
      const c = conic((px + 0.5) / n, (py + 0.5) / n);
      const o = py * (n * 4 + 1) + 1 + px * 4;
      raw[o] = Math.round(c[0]); raw[o + 1] = Math.round(c[1]); raw[o + 2] = Math.round(c[2]);
      raw[o + 3] = Math.round(255 * hit / (SS * SS));
    }
  }
  return raw;
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(n) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bits, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(render(n), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const images = SIZES.map(png);
const head = Buffer.alloc(6 + 16 * SIZES.length);
head.writeUInt16LE(1, 2); // type: icon
head.writeUInt16LE(SIZES.length, 4);
let offset = head.length;
SIZES.forEach((n, i) => {
  const e = 6 + 16 * i;
  head[e] = n === 256 ? 0 : n; head[e + 1] = n === 256 ? 0 : n;
  head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(images[i].length, e + 8);
  head.writeUInt32LE(offset, e + 12);
  offset += images[i].length;
});
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'favicon.ico');
fs.writeFileSync(out, Buffer.concat([head, ...images]));
console.log('wrote ' + out + ' (' + offset + ' bytes)');
