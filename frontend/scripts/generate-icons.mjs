/**
 * Generates the BiasharaGPT PWA icon set.
 *
 *   node scripts/generate-icons.mjs
 *
 * Writes PNGs into public/icons/. Re-run after changing the brand colours.
 * Uses only Node built-ins (zlib) so it needs no extra dependency: shapes are
 * rasterised from signed distance functions with 4x4 supersampling, then
 * encoded as 8-bit RGBA PNG.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// Brand colours, matching the CSS custom properties in src/index.css
const INDIGO = [27, 42, 74];
const MARIGOLD = [232, 163, 61];
const SAND = [246, 239, 227];

const SAMPLES = 4; // per axis, so 16 samples per pixel

/* ---------- signed distance helpers (negative = inside) ---------- */

const roundedRect = (x, y, cx, cy, hw, hh, r) => {
  const dx = Math.max(Math.abs(x - cx) - (hw - r), 0);
  const dy = Math.max(Math.abs(y - cy) - (hh - r), 0);
  return Math.hypot(dx, dy) - r;
};

// Lower half of a circular ring: the "listening" arc under the mic head.
const lowerArc = (x, y, cx, cy, radius, stroke) => {
  if (y < cy) return Infinity;
  return Math.abs(Math.hypot(x - cx, y - cy) - radius) - stroke / 2;
};

/* ---------- rasteriser ---------- */

// Layers are painted in order; each is { sd(x, y), color }.
function rasterise(size, layers) {
  const px = Buffer.alloc(size * size * 4);
  const step = 1 / SAMPLES;
  const offset = step / 2;

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (const layer of layers) {
        // Coverage = fraction of subsamples inside the shape.
        let hits = 0;
        for (let sy = 0; sy < SAMPLES; sy++) {
          for (let sx = 0; sx < SAMPLES; sx++) {
            const x = col + offset + sx * step;
            const y = row + offset + sy * step;
            if (layer.sd(x, y) <= 0) hits++;
          }
        }
        if (!hits) continue;

        const cov = hits / (SAMPLES * SAMPLES);
        const [lr, lg, lb] = layer.color;
        // Source-over compositing on premultiplied accumulators.
        r = lr * cov + r * (1 - cov);
        g = lg * cov + g * (1 - cov);
        b = lb * cov + b * (1 - cov);
        a = cov + a * (1 - cov);
      }

      const i = (row * size + col) * 4;
      px[i] = Math.round(r);
      px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return px;
}

/* ---------- PNG encoding ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = ~0;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
};

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const body = Buffer.concat([head.subarray(4), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, data, tail]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // bytes 10-12: deflate compression, adaptive filtering, no interlace (all 0)

  // Each scanline is prefixed with filter type 0 (none).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let row = 0; row < size; row++) {
    const at = row * (size * 4 + 1);
    raw[at] = 0;
    pixels.copy(raw, at + 1, row * size * 4, (row + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- the icon itself ---------- */

function micLayers(size, scale, color) {
  const cx = size / 2;
  const cy = size / 2;
  const headW = size * 0.2 * scale;
  const headH = size * 0.34 * scale;
  const headTop = cy - size * 0.24 * scale;
  const headCy = headTop + headH / 2;

  const arcR = size * 0.19 * scale;
  const arcCy = headTop + headH * 0.62;
  const stroke = Math.max(1, size * 0.045 * scale);

  const stemTop = arcCy + arcR - stroke / 2;
  const stemH = size * 0.1 * scale;
  const stemCy = stemTop + stemH / 2;
  const baseW = size * 0.2 * scale;
  const baseCy = stemTop + stemH;

  return [
    // capsule head
    { sd: (x, y) => roundedRect(x, y, cx, headCy, headW / 2, headH / 2, headW / 2), color },
    // listening arc
    { sd: (x, y) => lowerArc(x, y, cx, arcCy, arcR, stroke), color },
    // stem
    { sd: (x, y) => roundedRect(x, y, cx, stemCy, stroke / 2, stemH / 2, stroke / 2), color },
    // base
    { sd: (x, y) => roundedRect(x, y, cx, baseCy, baseW / 2, stroke / 2, stroke / 2), color },
  ];
}

/**
 * @param {number} size
 * @param {'standard'|'maskable'|'monochrome'} variant
 */
function icon(size, variant = 'standard') {
  if (variant === 'monochrome') {
    // Opaque silhouette only — Android tints this for notification badges.
    return rasterise(size, micLayers(size, 1, [0, 0, 0]));
  }

  if (variant === 'maskable') {
    // Full bleed, glyph inside the 80% safe zone: launchers crop the corners.
    return rasterise(size, [
      { sd: () => -1, color: INDIGO },
      ...micLayers(size, 0.72, MARIGOLD),
    ]);
  }

  const ruleW = size * 0.34;
  const ruleH = Math.max(1, size * 0.018);
  const ruleCy = size * 0.795 + ruleH / 2;

  return rasterise(size, [
    { sd: (x, y) => roundedRect(x, y, size / 2, size / 2, size / 2, size / 2, size * 0.22), color: INDIGO },
    ...micLayers(size, 1, MARIGOLD),
    // Thin sand underline, echoing the till-slip receipt motif.
    { sd: (x, y) => roundedRect(x, y, size / 2, ruleCy, ruleW / 2, ruleH / 2, ruleH / 2), color: SAND },
  ]);
}

// iOS home-screen icons must be fully opaque, so flatten transparency onto indigo.
function flatten(pixels, [br, bg, bb]) {
  const out = Buffer.from(pixels);
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3] / 255;
    out[i] = Math.round(out[i] * a + br * (1 - a));
    out[i + 1] = Math.round(out[i + 1] * a + bg * (1 - a));
    out[i + 2] = Math.round(out[i + 2] * a + bb * (1 - a));
    out[i + 3] = 255;
  }
  return out;
}

const targets = [
  ['icon-192.png', 192, icon(192)],
  ['icon-512.png', 512, icon(512)],
  ['icon-maskable-192.png', 192, icon(192, 'maskable')],
  ['icon-maskable-512.png', 512, icon(512, 'maskable')],
  ['icon-monochrome-512.png', 512, icon(512, 'monochrome')],
  ['apple-touch-icon-180.png', 180, flatten(icon(180), INDIGO)],
  ['favicon-32.png', 32, icon(32)],
  ['favicon-16.png', 16, icon(16)],
];

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, size, pixels] of targets) {
  const path = join(OUT_DIR, name);
  writeFileSync(path, encodePng(size, pixels));
  console.log(`wrote ${relative(process.cwd(), path)}`);
}
