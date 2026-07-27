#!/usr/bin/env node
// Generates build/icon.png (512x512), the source icon electron-builder converts
// into .ico / .icns at package time. Kept as a script rather than a binary blob
// so the icon is editable and the repo stays text-only.
//
//   node scripts/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;
const SS = 3; // supersamples per axis — cheap antialiasing

// Rounded-box signed distance: negative inside, positive outside.
function sdRoundBox(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function over(dst, src, a) {
  for (let i = 0; i < 3; i++) dst[i] = dst[i] * (1 - a) + src[i] * a;
  dst[3] = dst[3] * (1 - a) + a;
}

const GRAD_TOP = [0xEE, 0x90, 0x6A];
const GRAD_BOT = [0xC2, 0x55, 0x3B];
const TRACK = [0xFF, 0xFF, 0xFF];
const FILL = [0x34, 0xB9, 0x6C];
const DOT = [0x3B, 0x82, 0xF6];

const buf = Buffer.alloc(SIZE * SIZE * 4);

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const px = [0, 0, 0, 0];
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const fx = x + (sx + 0.5) / SS;
        const fy = y + (sy + 0.5) / SS;
        const s = [0, 0, 0, 0];

        // App tile: rounded square with a vertical gradient.
        const dTile = sdRoundBox(fx, fy, 256, 256, 232, 232, 112);
        if (dTile < 1) {
          const t = fy / SIZE;
          const c = GRAD_TOP.map((v, i) => v * (1 - t) + GRAD_BOT[i] * t);
          over(s, c, Math.min(1, Math.max(0, 0.5 - dTile)));
        }

        // Status dot, then the usage track with a partial fill — the widget in
        // miniature.
        const dDot = Math.hypot(fx - 136, fy - 256) - 20;
        over(s, DOT, Math.min(1, Math.max(0, 0.5 - dDot)));

        const dTrack = sdRoundBox(fx, fy, 300, 256, 116, 30, 30);
        over(s, TRACK, Math.min(1, Math.max(0, 0.5 - dTrack)) * 0.92);
        if (dTrack < 0 && fx < 322) {
          const dFill = sdRoundBox(fx, fy, 254, 256, 70, 30, 30);
          over(s, FILL, Math.min(1, Math.max(0, 0.5 - dFill)));
        }

        for (let i = 0; i < 4; i++) px[i] += s[i];
      }
    }
    const n = SS * SS;
    const o = (y * SIZE + x) * 4;
    for (let i = 0; i < 4; i++) buf[o + i] = Math.round(Math.min(255, (px[i] / n) * (i === 3 ? 255 : 1)));
  }
}

// ─── PNG encoding ────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(b) {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // colour type: RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  buf.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${SIZE}x${SIZE}, ${png.length} bytes)`);
