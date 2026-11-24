// QR labels (MA-31): a deep link to an asset or vehicle, and the QR code for
// it as an SVG path. The link holds only the page and the record id: no token,
// no household id, no credentials. Opening it still needs a signed-in member
// with `maintenance.view`; an id that does not exist (deleted, or another
// household's) shows the page's "no longer available" notice.
// The QR matrix comes from @zxing/library's encoder (already used for the device
// setup QR); it runs without a DOM, so it is unit tested
// (tests/unit/maintenance-insights-qr.test.ts), which decodes the drawn code.
import { EncodeHintType, QRCodeDecoderErrorCorrectionLevel, QRCodeEncoder } from '@zxing/library';

export type LabelTarget = { type: 'home_asset' | 'vehicle'; id: string };

/** Modules of white space around the code, as the QR standard asks. */
export const QR_QUIET_ZONE = 4;

/**
 * The absolute deep link for a label: `<origin>/maintenance?asset=<id>` or
 * `?vehicle=<id>`, the id URL-encoded. Only the scheme, host and port of
 * `origin` are kept (a path, query, fragment or user name in it is dropped).
 * Null for an origin that is not http(s) or an empty id.
 */
export function maintenanceDeepLink(origin: string, target: LabelTarget): string | null {
  if (!target.id) return null;
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return null;
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') return null;
  const key = target.type === 'vehicle' ? 'vehicle' : 'asset';
  return `${base.origin}/maintenance?${key}=${encodeURIComponent(target.id)}`;
}

export type QrMatrix = { size: number; dark: boolean[][] };

/** The QR modules for `text` (error correction M, UTF-8), row by row. */
export function qrMatrix(text: string): QrMatrix {
  const hints = new Map<EncodeHintType, unknown>([[EncodeHintType.CHARACTER_SET, 'UTF-8']]);
  const matrix = QRCodeEncoder.encode(text, QRCodeDecoderErrorCorrectionLevel.M, hints).getMatrix();
  const size = matrix.getWidth();
  const dark = Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) => matrix.get(x, y) === 1));
  return { size, dark };
}

/**
 * One SVG path drawing every dark module as a 1×1 square, offset by the quiet
 * zone; `viewBox` is `0 0 side side`. Each dark run on a row is one rectangle.
 */
export function qrSvg(text: string): { path: string; side: number } {
  const { size, dark } = qrMatrix(text);
  const parts: string[] = [];
  for (let y = 0; y < size; y += 1) {
    let x = 0;
    while (x < size) {
      if (!dark[y][x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < size && dark[y][x]) x += 1;
      parts.push(`M${start + QR_QUIET_ZONE} ${y + QR_QUIET_ZONE}h${x - start}v1h-${x - start}z`);
    }
  }
  return { path: parts.join(''), side: size + QR_QUIET_ZONE * 2 };
}
