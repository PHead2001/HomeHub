// Single source of truth for the HomeHub mark. Plain constants only (no types or
// imports) so `scripts/brand/render-icons.mjs` can import this file directly with
// Node's built-in type stripping when it regenerates the favicon and app icons.
//
// The mark sits on a 32x32 grid: a house whose roof is drawn as two connection
// edges meeting at a hub node, with smaller nodes at each eave. Two windows
// "light up" during the first-load intro.

export const LOGO_VIEWBOX = '0 0 32 32';

/** Walls and floor, drawn as an open path that tucks under the eave nodes. */
export const LOGO_WALLS_PATH = 'M7 15.5V26.5H25V15.5';

/** Roof edges: eave node -> hub node -> eave node. */
export const LOGO_ROOF_PATH = 'M4 15.5L16 5.5L28 15.5';

/** Hub node at the roof apex and the two eave nodes. */
export const LOGO_HUB_NODE = { cx: 16, cy: 5.5, r: 2.75 };
export const LOGO_EAVE_NODES = [
  { cx: 4, cy: 15.5, r: 1.9 },
  { cx: 28, cy: 15.5, r: 1.9 },
];

/** The two windows, filled in the accent color. */
export const LOGO_WINDOWS = [
  { x: 10.5, y: 17.5, width: 4, height: 4, rx: 0.9 },
  { x: 17.5, y: 17.5, width: 4, height: 4, rx: 0.9 },
];

export const LOGO_STROKE_WIDTH = 2.25;

// Static brand colors for raster icons, the manifest and browser chrome. They
// mirror the dark default theme in globals.css: --background (222.2 84% 4.9%)
// and --primary (174 44% 51%). Components use CSS variables, never these.
export const BRAND_BACKGROUND_HEX = '#020817';
export const BRAND_ACCENT_HEX = '#4bb9ae';
