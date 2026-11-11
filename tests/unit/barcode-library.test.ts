import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  alreadySavedCopy,
  barcodeToAdd,
  newProductData,
  productEdit,
  productName,
  restoredProductData,
  saveToLibraryHref,
  staleProductPhoto,
} from '../../src/lib/barcode/library-writes';

const now = new Date('2026-11-10T12:00:00.000Z');
const photo = { imageUrl: 'https://example.test/a.jpg', imagePath: 'households/h/barcode-library/a.jpg' };
const managed = (image: { imageUrl?: string; imagePath?: string }) => image.imagePath ?? null;

describe('barcode library create (BL-3, BL-10)', () => {
  test('a new product records its creator and may have no photo', () => {
    assert.deepEqual(newProductData({ name: '  Oat   milk ', photo: null, uid: 'u1', now }), {
      name: 'Oat milk', imageUrl: '', createdAt: now.toISOString(), createdByUid: 'u1',
    });
    assert.deepEqual(newProductData({ name: 'Juice', photo, uid: 'u1', now }), {
      name: 'Juice', imageUrl: photo.imageUrl, imagePath: photo.imagePath, createdAt: now.toISOString(), createdByUid: 'u1',
    });
  });

  test('names are trimmed and capped at 120 characters', () => {
    assert.equal(productName('x'.repeat(130)).length, 120);
    assert.equal(productName(' a  b '), 'a b');
  });

  test('a restore keeps the record but names the restorer', () => {
    assert.deepEqual(restoredProductData({ name: 'Juice', imageUrl: photo.imageUrl, imagePath: photo.imagePath, createdAt: '2026-01-01T00:00:00.000Z' }, 'u2', now), {
      name: 'Juice', imageUrl: photo.imageUrl, imagePath: photo.imagePath, createdAt: '2026-01-01T00:00:00.000Z', createdByUid: 'u2',
    });
    assert.equal(restoredProductData({ name: 'Old' }, 'u2', now).createdAt, now.toISOString());
  });
});

describe('barcode library edit', () => {
  const existing = { name: 'Juice', ...photo };

  test('only changed fields, never createdAt or createdByUid', () => {
    assert.deepEqual(productEdit(existing, { name: 'Juice', photo: { kind: 'keep' } }), { set: {}, removeImagePath: false, changed: false });
    const rename = productEdit(existing, { name: 'Orange juice', photo: { kind: 'keep' } });
    assert.deepEqual(rename, { set: { name: 'Orange juice' }, removeImagePath: false, changed: true });
    for (const edit of [rename, productEdit(existing, { name: 'X', photo: { kind: 'remove' } })]) {
      assert.ok(!('createdAt' in edit.set) && !('createdByUid' in edit.set));
    }
  });

  test('removing and replacing the photo', () => {
    assert.deepEqual(productEdit(existing, { name: 'Juice', photo: { kind: 'remove' } }), { set: { imageUrl: '' }, removeImagePath: true, changed: true });
    const next = { imageUrl: 'https://example.test/b.jpg', imagePath: 'households/h/barcode-library/b.jpg' };
    assert.deepEqual(productEdit(existing, { name: 'Juice', photo: { kind: 'replace', photo: next } }), { set: next, removeImagePath: false, changed: true });
    assert.deepEqual(productEdit({ name: 'Juice' }, { name: 'Juice', photo: { kind: 'remove' } }), { set: {}, removeImagePath: false, changed: false });
  });

  test('the photo an edit leaves unused is cleaned up, and only that one', () => {
    assert.equal(staleProductPhoto(existing, { kind: 'keep' }, managed), null);
    assert.equal(staleProductPhoto(existing, { kind: 'remove' }, managed), photo.imagePath);
    assert.equal(staleProductPhoto(existing, { kind: 'replace', photo: { imageUrl: 'x', imagePath: 'households/h/barcode-library/b.jpg' } }, managed), photo.imagePath);
    assert.equal(staleProductPhoto(existing, { kind: 'replace', photo }, managed), null);
    assert.equal(staleProductPhoto({ imageUrl: 'https://images.openfoodfacts.org/x.jpg' }, { kind: 'remove' }, managed), null);
  });
});

describe('save to library from a scan (BL-9)', () => {
  test('the link carries the scanned code and the library reads it back', () => {
    assert.equal(saveToLibraryHref('000000000404'), '/library?add=000000000404');
    assert.equal(barcodeToAdd('?add=000000000404'), '000000000404');
    assert.equal(barcodeToAdd('?add=12'), null);
    assert.equal(barcodeToAdd('?add=abc123456'), null);
    assert.equal(barcodeToAdd(''), null);
  });

  test('an existing code is offered for editing, not overwritten', () => {
    assert.equal(alreadySavedCopy('Juice'), 'This barcode is already saved as Juice. Edit it instead?');
  });
});
