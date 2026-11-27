/**
 * QR codes for invite links (audit HO-16, HO-23): the module grid from the barcode
 * library the scanner already ships (`@zxing/library`'s encoder, error correction
 * level M), drawn as one SVG path. Pure; unit-tested by decoding the result
 * (tests/unit/invite-link.test.ts).
 */

import { EncodeHintType, QRCodeDecoderErrorCorrectionLevel, QRCodeEncoder } from '@zxing/library';

export type QrModules = {
  /** Modules per side (no quiet zone). */
  size: number;
  /** Row-major: `dark[y * size + x]`. */
  dark: boolean[];
};

/** The module grid for `text` (UTF-8, level M). Throws for text too long for a QR code. */
export function qrModules(text: string): QrModules {
  const hints = new Map<EncodeHintType, unknown>([[EncodeHintType.CHARACTER_SET, 'UTF-8']]);
  const matrix = QRCodeEncoder.encode(text, QRCodeDecoderErrorCorrectionLevel.M, hints).getMatrix();
  const size = matrix.getWidth();
  const dark: boolean[] = [];
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) dark.push(matrix.get(x, y) === 1);
  return { size, dark };
}

/** The quiet zone scanners need around the code, in modules. */
export const QR_QUIET_ZONE = 4;

/**
 * One SVG path for the dark modules, offset by the quiet zone, with each horizontal
 * run of dark modules as one rectangle. The viewBox is `0 0 n n` with
 * `n = size + 2 * QR_QUIET_ZONE`.
 */
export function qrSvgPath({ size, dark }: QrModules, quiet = QR_QUIET_ZONE): string {
  const parts: string[] = [];
  for (let y = 0; y < size; y += 1) {
    let x = 0;
    while (x < size) {
      if (!dark[y * size + x]) { x += 1; continue; }
      const start = x;
      while (x < size && dark[y * size + x]) x += 1;
      parts.push(`M${start + quiet} ${y + quiet}h${x - start}v1h-${x - start}z`);
    }
  }
  return parts.join('');
}
