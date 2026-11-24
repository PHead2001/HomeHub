import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BinaryBitmap, DecodeHintType, HybridBinarizer, QRCodeReader, RGBLuminanceSource } from '@zxing/library';
import { PRINT_LABEL_CSS, PrintLabel } from '../../src/components/maintenance/print-label';
import { maintenanceDeepLink, qrSvg, QR_QUIET_ZONE } from '../../src/lib/maintenance/qr-label';

const ORIGIN = 'https://homehub.example.test';

/** Decodes a QR drawn as an SVG path of "M x y h w v 1 h -w z" rectangles, as the label draws it. */
function decodeSvgPath(path: string, side: number): string {
  const scale = 4;
  const width = side * scale;
  const pixels = new Uint8ClampedArray(width * width).fill(255);
  const rect = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/g;
  let consumed = 0;
  for (let match = rect.exec(path); match; match = rect.exec(path)) {
    consumed += match[0].length;
    const [x, y, w] = [Number(match[1]), Number(match[2]), Number(match[3])];
    for (let py = y * scale; py < (y + 1) * scale; py += 1) {
      for (let px = x * scale; px < (x + w) * scale; px += 1) pixels[py * width + px] = 0;
    }
  }
  assert.equal(consumed, path.length, 'the path only has module rectangles');
  const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(pixels, width, width)));
  return new QRCodeReader().decode(bitmap, new Map([[DecodeHintType.PURE_BARCODE, true]])).getText();
}

const renderLabel = (props: { name: string; location?: string; url: string }) => {
  const html = renderToStaticMarkup(createElement(PrintLabel, props));
  const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(html);
  const path = /<path d="([^"]+)"/.exec(html);
  assert.ok(viewBox && path, 'the label draws an SVG QR');
  return { html, side: Number(viewBox[1]), path: path[1] };
};

describe('QR labels (MA-31)', () => {
  it('builds a safe absolute deep link', () => {
    assert.equal(maintenanceDeepLink(ORIGIN, { type: 'home_asset', id: 'hvac-main' }), `${ORIGIN}/maintenance?asset=hvac-main`);
    assert.equal(maintenanceDeepLink(ORIGIN, { type: 'vehicle', id: 'blue-car' }), `${ORIGIN}/maintenance?vehicle=blue-car`);
    // Only the origin is kept: no path, query, fragment or credentials.
    assert.equal(
      maintenanceDeepLink('https://user:secret@homehub.example.test:8443/chores?token=abc#x', { type: 'home_asset', id: 'a' }),
      'https://homehub.example.test:8443/maintenance?asset=a',
    );
    assert.equal(maintenanceDeepLink('javascript:alert(1)', { type: 'home_asset', id: 'a' }), null);
    assert.equal(maintenanceDeepLink('not a url', { type: 'home_asset', id: 'a' }), null);
    assert.equal(maintenanceDeepLink(ORIGIN, { type: 'home_asset', id: '' }), null);
  });

  it('URL-encodes ids with special characters', () => {
    const id = 'a b/c?d&e=f#g%h+ü';
    const link = maintenanceDeepLink(ORIGIN, { type: 'home_asset', id })!;
    assert.equal(link, `${ORIGIN}/maintenance?asset=a%20b%2Fc%3Fd%26e%3Df%23g%25h%2B%C3%BC`);
    const parsed = new URL(link);
    assert.equal(parsed.searchParams.get('asset'), id);
    assert.deepEqual([...parsed.searchParams.keys()], ['asset']);
    assert.equal(parsed.hash, '');
  });

  it('the drawn label decodes back to exactly the deep link', () => {
    for (const [type, id] of [['home_asset', 'hvac-main'], ['vehicle', 'blue-car-2019'], ['home_asset', 'a b/c?d&e=f#g%h+ü'], ['vehicle', 'x'.repeat(120)]] as const) {
      const url = maintenanceDeepLink(ORIGIN, { type, id })!;
      const { html, side, path } = renderLabel({ name: 'Main HVAC System', location: 'Garage', url });
      assert.equal(decodeSvgPath(path, side), url);
      assert.match(html, /Scan to open in HomeHub/);
      assert.match(html, /Print label/);
      assert.match(html, /role="img" aria-label="QR code that opens Main HVAC System in HomeHub"/);
      assert.match(html, /@media print/);
    }
  });

  it('keeps a quiet zone and only the label prints', () => {
    const { side, path } = qrSvg(`${ORIGIN}/maintenance?asset=a`);
    const coordinates = [...path.matchAll(/M(\d+) (\d+)h(\d+)/g)].map((match) => [Number(match[1]), Number(match[2]), Number(match[3])]);
    assert.ok(coordinates.every(([x, y, w]) => x >= QR_QUIET_ZONE && y >= QR_QUIET_ZONE && x + w <= side - QR_QUIET_ZONE && y < side - QR_QUIET_ZONE));
    // The print rules apply only while a label is being printed; the sheet never shows on screen.
    assert.ok(PRINT_LABEL_CSS.split('@media print')[1].split('\n').slice(1).filter((line) => line.includes('{')).every((line) => line.trim().startsWith('html[data-print-label]')));
    assert.match(PRINT_LABEL_CSS, /^\[data-print-label-sheet\] \{ display: none; \}/);
    const source = readFileSync(resolve(process.cwd(), 'src/components/maintenance/print-label.tsx'), 'utf8');
    assert.match(source, /afterprint/);
  });
});
