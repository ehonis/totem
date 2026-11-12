#!/usr/bin/env node
// Renders every logo asset from the masters in web/assets-src/. The mark is a winged tiki
// totem, white on black in a 24-unit box, with no effects:
//   totem-logo.svg        the mark, used at 56px and up (sidebar, favicon.png, app icons)
//   totem-logo-small.svg  the same mark with its horizontal edges on the 32px pixel grid
//                         (favicon-32.png; the nav rail's Totems icon reads it too)
//   totem-logo-16.svg     a 16×16 pixel drawing for favicon-16.png, painted as is
// It writes the dashboard's files and the iPhone app's (mobile/assets/). Edit the
// masters, never the outputs. The desktop app's icons come from the same master:
// `cd desktop && npm run icons`.
//
//   node scripts/build-logo-assets.mjs            # writes the sixteen files below
//
// sharp is a devDependency of web/, so `cd web && pnpm install` first.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sharp = createRequire(join(ROOT, 'web', 'package.json'))('sharp');
const read = (name) => readFileSync(join(ROOT, 'web/assets-src', name), 'utf8');
// the art alone: the master's own <svg> wrapper and black field come off
const artOf = (master) => master.replace(/<svg[^>]*>/, '').replace('</svg>', '').replace(/<rect[^>]*\/>/, '').trim();
const MAIN = artOf(read('totem-logo.svg')), SMALL = artOf(read('totem-logo-small.svg'));

/** The 24-unit art box covering `scale` of a square canvas. */
function framed(art, size, scale, transparent = false) {
  const s = 24 / scale, o = (s - 24) / 2, vb = `${-o} ${-o} ${s} ${s}`;
  const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${size}" height="${size}">`;
  if (!transparent) return `${open}<rect x="${-o}" y="${-o}" width="${s}" height="${s}" fill="#000"/>${art}</svg>`;
  // Painted white through a luminance mask, so the black cut-outs (the face, the
  // feather slits) stay see-through on any background.
  return `${open}<defs><mask id="m" maskUnits="userSpaceOnUse" x="${-o}" y="${-o}" width="${s}" height="${s}">` +
    `<rect x="${-o}" y="${-o}" width="${s}" height="${s}" fill="#000"/>${art}</mask></defs>` +
    `<rect x="${-o}" y="${-o}" width="${s}" height="${s}" fill="#fff" mask="url(#m)"/></svg>`;
}

async function render(svg, rel, size, transparent) {
  let img = sharp(Buffer.from(svg), { density: Math.min(2400, 216 * Math.max(1, 1024 / size)) }).resize(size, size);
  if (!transparent) img = img.flatten({ background: '#000' }).removeAlpha();
  await img.png().toFile(join(ROOT, rel));
  console.log(`  ${rel}  ${size}px`);
}
const write = (rel, size, scale, { transparent = false, art = MAIN } = {}) =>
  render(framed(art, size, scale, transparent), rel, size, transparent);

// The Totems tab's mark (two mascots) as a white, transparent PNG for the app, which
// tints it. Placement is read from the web's component, so the two never differ.
function totemsIcon() {
  const tsx = readFileSync(join(ROOT, 'web/src/components/TotemsIcon.tsx'), 'utf8');
  const place = (name) => tsx.match(new RegExp(`const ${name} = '([^']+)'`))?.[1] ?? (() => { throw new Error(`TotemsIcon.tsx: no ${name}`) })();
  const knockout = SMALL.replace(/(fill|stroke)="#fff"/g, '$1="#000"').replace(/stroke-width="6"/g, 'stroke-width="16"');
  const mask = (id, body) => `<mask id="${id}" maskUnits="userSpaceOnUse" x="-2" y="-2" width="28" height="28"><rect x="-2" y="-2" width="28" height="28" fill="#000"/>${body}</mask>`;
  const g = (t, art) => `<g transform="${t}">${art}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs>` +
    mask('a', g(place('MAIN'), SMALL)) + mask('b', g(place('SMALL'), SMALL) + g(place('MAIN'), knockout)) +
    `</defs><rect x="-2" y="-2" width="28" height="28" fill="#fff" mask="url(#b)"/><rect x="-2" y="-2" width="28" height="28" fill="#fff" mask="url(#a)"/></svg>`;
}

// The sidebar mark sits straight on the UI, so it is the transparent one.
await write('web/src/assets/totem-logo.png', 512, 0.98, { transparent: true });
await write('web/public/favicon.png', 256, 0.92);
// Small sizes fill the whole square: the small master's grid only holds at scale 1.
await write('web/public/favicon-32.png', 32, 1, { art: SMALL });
// The 16px master is already pixels; render it at its own size so nothing resamples.
await sharp(Buffer.from(read('totem-logo-16.svg').replace('<svg ', '<svg width="16" height="16" ')))
  .flatten({ background: '#000' }).removeAlpha().png().toFile(join(ROOT, 'web/public/favicon-16.png'));
console.log('  web/public/favicon-16.png  16px');
await write('web/public/icons/icon-180.png', 180, 0.74);
await write('web/public/icons/icon-192.png', 192, 0.74);
await write('web/public/icons/icon-512.png', 512, 0.74);
// Maskable icons keep the mark inside the 80% safe zone Android crops to.
await write('web/public/icons/maskable-192.png', 192, 0.58);
await write('web/public/icons/maskable-512.png', 512, 0.58);

// The iPhone app (app.json). Its icon and splash are native: a change here ships in
// the next App Store build, not over the air. android-icon-background.png is plain black.
await write('mobile/assets/icon.png', 1024, 0.74);
await write('mobile/assets/splash-icon.png', 1024, 0.6);
await write('mobile/assets/favicon.png', 48, 0.93);
// Adaptive icons keep the mark inside the 66% circle a launcher may crop to.
await write('mobile/assets/android-icon-foreground.png', 512, 0.5, { transparent: true });
await write('mobile/assets/android-icon-monochrome.png', 512, 0.5, { transparent: true });
await write('mobile/assets/images/totem-logo.png', 512, 0.98, { transparent: true });
await render(totemsIcon(), 'mobile/assets/images/totems-icon.png', 72, true);
