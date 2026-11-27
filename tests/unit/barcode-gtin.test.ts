import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { barcodeMoveDecision, normalizedBarcodeId } from '../../scripts/ops/barcode-library-ids.mjs';
import { barcodeId, expandUpcE, gtinCheckDigitValid, lookupIds, normalizeGtin, sameBarcode } from '../../src/lib/barcode/gtin';

describe('barcode normalisation (BL-12)', () => {
  test('check digits', () => {
    assert.equal(gtinCheckDigitValid('4006381333931'), true);
    assert.equal(gtinCheckDigitValid('012345678905'), true);
    assert.equal(gtinCheckDigitValid('96385074'), true);
    assert.equal(gtinCheckDigitValid('4006381333932'), false);
    assert.equal(gtinCheckDigitValid('abc'), false);
  });

  test('UPC-A and EAN-13 forms of one product share one 13-digit ID', () => {
    assert.deepEqual(normalizeGtin('012345678905'), { ok: true, id: '0012345678905', checked: true });
    assert.deepEqual(normalizeGtin('0012345678905'), { ok: true, id: '0012345678905', checked: true });
    assert.deepEqual(normalizeGtin('012345 678905'), { ok: true, id: '0012345678905', checked: true });
    assert.deepEqual(normalizeGtin('0-12345-67890-5'), { ok: true, id: '0012345678905', checked: true });
    assert.deepEqual(normalizeGtin('00012345678905'), { ok: true, id: '0012345678905', checked: true });
    assert.deepEqual(normalizeGtin('4006381333931'), { ok: true, id: '4006381333931', checked: true });
    assert.equal(sameBarcode('012345678905', '0012345678905'), true);
  });

  test('EAN-8 pads to 13; UPC-E expands to its UPC-A', () => {
    assert.deepEqual(normalizeGtin('96385074'), { ok: true, id: '0000096385074', checked: true });
    // UPC-E 04252614 is UPC-A 042100005264.
    assert.equal(expandUpcE('04252614'), '042100005264');
    assert.deepEqual(normalizeGtin('04252614', 'UPC_E'), { ok: true, id: '0042100005264', checked: true });
    assert.equal(sameBarcode('04252614', '042100005264'), true);
    assert.equal(expandUpcE('24252614'), null);
  });

  test('a code without a valid check digit is kept as its digits (in-store codes, the e2e fixtures)', () => {
    assert.deepEqual(normalizeGtin('000000000404'), { ok: true, id: '000000000404', checked: false });
    assert.deepEqual(normalizeGtin('008500001280'), { ok: true, id: '008500001280', checked: false });
    assert.deepEqual(normalizeGtin('123456'), { ok: true, id: '123456', checked: false });
  });

  test('refusals', () => {
    assert.deepEqual(normalizeGtin(''), { ok: false, reason: 'empty' });
    assert.deepEqual(normalizeGtin('12345'), { ok: false, reason: 'length' });
    assert.deepEqual(normalizeGtin('12a456789'), { ok: false, reason: 'not-digits' });
    assert.deepEqual(normalizeGtin('1'.repeat(33)), { ok: false, reason: 'length' });
    assert.deepEqual(normalizeGtin(undefined), { ok: false, reason: 'empty' });
    assert.equal(barcodeId(' abc '), 'abc');
    assert.equal(sameBarcode('abc', 'abc'), false);
  });

  test('lookup tries the normalised ID, then the code as given', () => {
    assert.deepEqual(lookupIds('012345678905'), ['0012345678905', '012345678905']);
    assert.deepEqual(lookupIds('4006381333931'), ['4006381333931']);
    assert.deepEqual(lookupIds('000000000404'), ['000000000404']);
  });

  test('the migration (scripts/ops) gives the same IDs as the app', () => {
    for (const code of ['012345678905', '0012345678905', '012345 678905', '96385074', '04252614', '00012345678905', '4006381333931', '000000000404', '123456', '12345', 'abc']) {
      const app = normalizeGtin(code);
      assert.equal(normalizedBarcodeId(code), app.ok ? app.id : null, code);
    }
  });

  test('the migration moves to the normalised ID, never over a taken one', () => {
    assert.deepEqual(barcodeMoveDecision('0012345678905', new Set(['0012345678905'])), { kind: 'current' });
    assert.deepEqual(barcodeMoveDecision('012345678905', new Set(['012345678905'])), { kind: 'move', to: '0012345678905' });
    assert.deepEqual(barcodeMoveDecision('012345678905', new Set(['012345678905', '0012345678905'])), { kind: 'collision', to: '0012345678905' });
    assert.deepEqual(barcodeMoveDecision('store-code', new Set()), { kind: 'current' });
    assert.deepEqual(barcodeMoveDecision('000000000404', new Set()), { kind: 'current' });
  });
});
