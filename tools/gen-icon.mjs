#!/usr/bin/env node
/**
 * Generates src-tauri/icons/icon.ico with zero dependencies.
 *
 * Bitmap entries (16-256px), 32bpp BGRA bottom-up + empty AND mask 鈥?the
 * format the Windows resource compiler expects. The mark is the STELLAR
 * diamond: plate, cyan鈫抦agenta gradient diamond, white core, soft glow.
 *
 * 杩愯锛歯ode tools/gen-icon.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'apps',
  'launcher',
  'src-tauri',
  'icons',
  'icon.ico',
);
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const clamp = (n) => Math.round(Math.max(0, Math.min(255, n)));
const mix = (a, b, t) => a + (b - a) * t;

/** BGRA pixels for one size, returned bottom-up (BMP-in-ICO order). */
function draw(size) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(size * 4);
    for (let x = 0; x < size; x++) {
      const nx = ((x + 0.5) / size) * 2 - 1;
      const ny = ((y + 0.5) / size) * 2 - 1;
      const rounded = Math.max(Math.abs(nx) - 0.8, Math.abs(ny) - 0.8);

      let b = 0x26, g = 0x12, r = 0x13; // plate #131226
      let a = 255;

      if (rounded > 0.02) {
        if (rounded < 0.5) {
          // soft glow just outside the plate
          const glow = (1 - rounded / 0.5) * 0.55;
          b = clamp(0x26 + 0x5c * glow);
          g = clamp(0x12 + 0x5c * glow);
          r = clamp(0x13 + 0x8c * glow);
        } else {
          a = 0;
        }
        row.writeUInt32LE(((((a << 24) | (b << 16) | (g << 8) | r) >>> 0)), x * 4);
        continue;
      }

      if (rounded > 0.10) {
        b = 0x48; g = 0x27; r = 0x2a; // plate edge #2a2748
      } else {
        const t = (nx + ny + 2) / 4; // cyan 鈫?magenta across the diamond
        b = clamp(mix(0xff, 0xa3, t));
        g = clamp(mix(0xe6, 0x4f, t));
        r = clamp(mix(0x35, 0xff, t));

        const d = Math.abs(nx) + Math.abs(ny);
        if (d <= 0.34) {
          // white core with a feathered edge, halved on the smallest sizes
          const k = size <= 24 ? 0.5 : 1;
          const feather = Math.max(0, 1 - d / 0.34) * k;
          b = clamp(mix(0xff, b, 0.25 * feather));
          g = clamp(mix(0xff, g, 0.25 * feather));
          r = clamp(mix(0xff, r, 0.25 * feather));
        }
      }
      row.writeUInt32LE(((((a << 24) | (b << 16) | (g << 8) | r) >>> 0)), x * 4);
    }
    rows.push(row);
  }
  rows.reverse();
  return Buffer.concat(rows);
}

function icoImage(size) {
  const pixels = draw(size);
  const bih = Buffer.alloc(40);
  bih.writeUInt32LE(40, 0);
  bih.writeInt32LE(size, 4);
  bih.writeInt32LE(size * 2, 8); // XOR + AND
  bih.writeUInt16LE(1, 12);
  bih.writeUInt16LE(32, 14);
  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([bih, pixels, Buffer.alloc(maskRow * size)]);
}

function buildIco() {
  const images = SIZES.map(icoImage);
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(SIZES.length, 4);

  const entries = [];
  let offset = 6 + SIZES.length * 16;
  SIZES.forEach((s, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(s >= 256 ? 0 : s, 0);
    e.writeUInt8(s >= 256 ? 0 : s, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(images[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += images[i].length;
    entries.push(e);
  });
  return Buffer.concat([dir, ...entries, ...images]);
}

mkdirSync(join(OUT, '..'), { recursive: true });
const buf = buildIco();
writeFileSync(OUT, buf);
console.log(`icon.ico 鈫?${OUT} (${(buf.length / 1024).toFixed(1)} KiB, ${SIZES.join('/')})`);

