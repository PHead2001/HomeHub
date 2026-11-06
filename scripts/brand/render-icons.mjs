// Regenerates every raster/static brand asset from the single artwork source in
// src/components/brand/logo-artwork.ts. Run with `npm run brand:icons` after
// changing the artwork, then commit the outputs.
//
// Outputs:
//   src/app/icon.svg            favicon (Next app-router icon convention)
//   src/app/favicon.ico         16/32/48 px PNG-in-ICO favicon
//   src/app/apple-icon.png      180 px iOS home-screen icon (full bleed)
//   public/icons/icon-192.png   manifest icon, purpose "any"
//   public/icons/icon-512.png   manifest icon, purpose "any"
//   public/icons/maskable-512.png  manifest icon, purpose "maskable" (mark inside the 80% safe zone)
//   public/icons/shortcut-*.png 96 px manifest shortcut icons
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  BRAND_ACCENT_HEX,
  BRAND_BACKGROUND_HEX,
  LOGO_EAVE_NODES,
  LOGO_HUB_NODE,
  LOGO_ROOF_PATH,
  LOGO_STROKE_WIDTH,
  LOGO_WALLS_PATH,
  LOGO_WINDOWS,
} from '../../src/components/brand/logo-artwork.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const circle = ({ cx, cy, r }, fill) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`;
const rect = ({ x, y, width, height, rx }, fill) =>
  `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" fill="${fill}"/>`;

/** The mark's 32x32 artwork as SVG children, in one color. */
const markElements = (color) => [
  `<path d="${LOGO_WALLS_PATH}" stroke="${color}" stroke-width="${LOGO_STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
  `<path d="${LOGO_ROOF_PATH}" stroke="${color}" stroke-width="${LOGO_STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
  ...LOGO_WINDOWS.map((window) => rect(window, color)),
  ...LOGO_EAVE_NODES.map((node) => circle(node, color)),
  circle(LOGO_HUB_NODE, color),
].join('');

/**
 * An icon tile: background (rounded or full bleed) with the mark scaled to
 * `markScale` of the tile and centered. The 32-unit artwork's visual bounds are
 * roughly x 2-30, y 2.75-27.6, so it is nudged down to center optically.
 */
const iconSvg = ({ size, markScale, radius = 0, background = BRAND_BACKGROUND_HEX }) => {
  const markSize = size * markScale;
  const scale = markSize / 32;
  const offset = (size - markSize) / 2;
  const opticalNudge = 0.8 * scale; // artwork bounds center at y=15.2, so drop it 0.8 units
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<rect width="${size}" height="${size}" rx="${round(radius)}" fill="${background}"/>`
    + `<g transform="translate(${round(offset)} ${round(offset + opticalNudge)}) scale(${round(scale)})">${markElements(BRAND_ACCENT_HEX)}</g>`
    + '</svg>';
};

const round = (value) => Number(value.toFixed(3));

const png = (svg) => sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();

/** Minimal ICO container with embedded PNG images (supported by every current browser). */
const ico = (images) => {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map(({ data }) => data)]);
};

const write = (relativePath, data) => {
  const target = resolve(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
  console.log(`wrote ${relativePath}`);
};

// Favicon: rounded tile so the teal mark keeps contrast on light and dark tab strips.
const faviconSvg = iconSvg({ size: 32, markScale: 0.8, radius: 7 });
write('src/app/icon.svg', `${faviconSvg}\n`);
write('src/app/favicon.ico', ico(await Promise.all([16, 32, 48].map(async (size) => ({
  size,
  data: await png(iconSvg({ size, markScale: 0.8, radius: size * 0.22 })),
})))));

// iOS applies its own corner mask, so the apple icon is full bleed.
write('src/app/apple-icon.png', await png(iconSvg({ size: 180, markScale: 0.66 })));

for (const size of [192, 512]) {
  write(`public/icons/icon-${size}.png`, await png(iconSvg({ size, markScale: 0.7, radius: size * 0.22 })));
}

// Maskable: full bleed, mark within the central 80% safe-zone circle (0.6 of the edge keeps every point inside it).
write('public/icons/maskable-512.png', await png(iconSvg({ size: 512, markScale: 0.6 })));

// Shortcut icons reuse the mark on the brand tile (96 px, Lighthouse's recommended size).
write('public/icons/shortcut-96.png', await png(iconSvg({ size: 96, markScale: 0.7, radius: 96 * 0.22 })));
