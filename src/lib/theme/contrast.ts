/**
 * WCAG 2.x contrast helpers for HSL channel tokens ("174 60% 32%").
 * Used by the preset contrast tests and by nothing at runtime that affects rendering.
 */

export type Rgb = [number, number, number];

/** Parses an HSL channel token ("h s% l%") into 0–1 sRGB. */
export function hslTokenToRgb(token: string): Rgb {
  const match = token.trim().match(/^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  if (!match) throw new Error(`Not an HSL channel token: "${token}"`);
  const h = (((Number(match[1]) % 360) + 360) % 360) / 360;
  const s = Number(match[2]) / 100;
  const l = Number(match[3]) / 100;
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)];
}

const channel = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Composites `top` at `alpha` over an opaque `bottom`. */
export function blend(top: Rgb, bottom: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => top[i] * alpha + bottom[i] * (1 - alpha)) as Rgb;
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function tokenContrast(a: string, b: string): number {
  return contrastRatio(hslTokenToRgb(a), hslTokenToRgb(b));
}

/** "#rrggbb" for an HSL token; used for `<meta name="theme-color">`. */
export function hslTokenToHex(token: string): string {
  return `#${hslTokenToRgb(token)
    .map((c) => Math.round(c * 255).toString(16).padStart(2, '0'))
    .join('')}`;
}
