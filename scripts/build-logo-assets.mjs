#!/usr/bin/env node
// Renders every logo asset from the one master, web/assets-src/totem-logo.svg:
// the Totem mascot (a winged tiki totem), white on black in a 24-unit box. Plain
// white on black, no effects. Edit the master, never the outputs. The master was
// generated with Codex's image tool and vectorized with potrace (2026-10-02).
//
//   node scripts/build-logo-assets.mjs            # writes the seven files below
//
// sharp is a devDependency of web/, so `cd web && npm install` first.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sharp = createRequire(join(ROOT, 'web', 'package.json'))('sharp');
const master = readFileSync(join(ROOT, 'web/assets-src/totem-logo.svg'), 'utf8');
// the art alone: the master's own <svg> wrapper and black field come off
const art = master.replace(/<svg[^>]*>/, '').replace('</svg>', '').replace(/<rect[^>]*\/>/, '').trim();

/** The 24-unit art box covering `scale` of a square canvas. */
function framed(size, scale, transparent = false) {
  const s = 24 / scale, o = (s - 24) / 2, vb = `${-o} ${-o} ${s} ${s}`;
  const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${size}" height="${size}">`;
  if (!transparent) return `${open}<rect x="${-o}" y="${-o}" width="${s}" height="${s}" fill="#000"/>${art}</svg>`;
  // Painted white through a luminance mask, so the black cut-outs (bolt holes,
  // lobe holes, the gap between lobes) stay see-through on any background.
  return `${open}<defs><mask id="m" maskUnits="userSpaceOnUse" x="${-o}" y="${-o}" width="${s}" height="${s}">` +
    `<rect x="${-o}" y="${-o}" width="${s}" height="${s}" fill="#000"/>${art}</mask></defs>` +
    `<rect x="${-o}" y="${-o}" width="${s}" height="${s}" fill="#fff" mask="url(#m)"/></svg>`;
}

async function write(rel, size, scale, transparent = false) {
  let img = sharp(Buffer.from(framed(size, scale, transparent)), { density: Math.min(2400, 216 * Math.max(1, 1024 / size)) }).resize(size, size);
  if (!transparent) img = img.flatten({ background: '#000' }).removeAlpha();
  await img.png().toFile(join(ROOT, 'web', rel));
  console.log(`  web/${rel}  ${size}px`);
}

// The sidebar mark sits straight on the UI, so it is the transparent one.
await write('src/assets/totem-logo.png', 512, 0.98, true);
await write('public/favicon.png', 256, 0.92);
await write('public/icons/icon-180.png', 180, 0.74);
await write('public/icons/icon-192.png', 192, 0.74);
await write('public/icons/icon-512.png', 512, 0.74);
// Maskable icons keep the mark inside the 80% safe zone Android crops to.
await write('public/icons/maskable-192.png', 192, 0.58);
await write('public/icons/maskable-512.png', 512, 0.58);
