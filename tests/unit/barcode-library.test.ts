import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  alreadySavedCopy,
  barcodeToAdd,
  capturedProduct,
  newProductData,
  productEdit,
  productName,
  productSubmitBlock,
  restoredProductData,
  saveToLibraryHref,
  staleProductPhoto,
} from '../../src/lib/barcode/library-writes';
import { createPendingPhotoDeletes } from '../../src/lib/barcode/pending-photo-deletes';

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

describe('photo deletes wait out the Undo window (BL-4)', () => {
  const fakeScheduler = () => {
    const timers = new Map<number, () => void>();
    let next = 0;
    return {
      scheduler: {
        set: (callback: () => void) => { next += 1; timers.set(next, callback); return next; },
        clear: (handle: unknown) => { timers.delete(handle as number); },
      },
      fireAll: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((callback) => callback()); },
      count: () => timers.size,
    };
  };

  test('the timer deletes the photo; nothing is deleted before it', () => {
    const removed: string[] = [];
    const clock = fakeScheduler();
    const registry = createPendingPhotoDeletes({ windowMs: 10_000, remove: (path) => removed.push(path), scheduler: clock.scheduler });
    registry.schedule('h/1', 'households/h/barcode-library/a.jpg');
    assert.deepEqual(removed, []);
    assert.equal(registry.pending('h/1'), true);
    clock.fireAll();
    assert.deepEqual(removed, ['households/h/barcode-library/a.jpg']);
    assert.equal(registry.pending('h/1'), false);
    // After the window an Undo learns the photo is gone.
    assert.equal(registry.cancel('h/1'), null);
  });

  test('an Undo cancels the delete and keeps the photo', () => {
    const removed: string[] = [];
    const clock = fakeScheduler();
    const registry = createPendingPhotoDeletes({ windowMs: 10_000, remove: (path) => removed.push(path), scheduler: clock.scheduler });
    registry.schedule('h/1', 'p1');
    assert.equal(registry.cancel('h/1'), 'p1');
    assert.equal(clock.count(), 0);
    clock.fireAll();
    assert.deepEqual(removed, []);
    registry.removeNow('p1');
    assert.deepEqual(removed, ['p1']);
  });

  test('a second delete of the same code replaces the first entry without losing its photo', () => {
    const removed: string[] = [];
    const clock = fakeScheduler();
    const registry = createPendingPhotoDeletes({ windowMs: 10_000, remove: (path) => removed.push(path), scheduler: clock.scheduler });
    registry.schedule('h/1', 'p1');
    registry.schedule('h/1', 'p2');
    assert.deepEqual(removed, ['p1']);
    assert.equal(clock.count(), 1);
    clock.fireAll();
    assert.deepEqual(removed, ['p1', 'p2']);
  });

  test('an Undo after the photo was deleted restores the product without it', () => {
    assert.deepEqual(restoredProductData({ name: 'Juice', ...photo, createdAt: '2026-01-01T00:00:00.000Z' }, 'u2', now, { photoGone: true }), {
      name: 'Juice', imageUrl: '', createdAt: '2026-01-01T00:00:00.000Z', createdByUid: 'u2',
    });
  });
});

describe('delete captures the current product (BL-4)', () => {
  test('the Undo restores what was deleted, not the older copy on the page', () => {
    const pageCopy = { id: '1', name: 'Juice', imageUrl: 'https://example.test/old.jpg', imagePath: 'households/h/barcode-library/old.jpg', createdAt: '2026-01-01T00:00:00.000Z' };
    const current = { name: 'Orange juice', imageUrl: 'https://example.test/new.jpg', imagePath: 'households/h/barcode-library/new.jpg', createdAt: pageCopy.createdAt, createdByUid: 'u1' };
    const captured = capturedProduct('1', current);
    assert.deepEqual(captured, { id: '1', name: 'Orange juice', imageUrl: current.imageUrl, imagePath: current.imagePath, createdAt: pageCopy.createdAt });
    assert.deepEqual(restoredProductData(captured!, 'u2', now), {
      name: 'Orange juice', imageUrl: current.imageUrl, imagePath: current.imagePath, createdAt: pageCopy.createdAt, createdByUid: 'u2',
    });
    // The delayed cleanup targets the deleted photo, never the edit's already-deleted old one.
    assert.equal(managed(captured!), current.imagePath);
  });

  test('a product someone else removed meanwhile has nothing to undo', () => {
    assert.equal(capturedProduct('1', null), null);
    assert.equal(capturedProduct('1', undefined), null);
  });

  test('a captured product without a photo or date stays valid', () => {
    assert.deepEqual(capturedProduct('1', { name: '' }), { id: '1', name: 'Saved product', imageUrl: '' });
  });
});

describe('Save is blocked while the shown photo is not the one that would be saved', () => {
  test('a photo being shrunk waits; a rejected photo blocks; otherwise Save runs', () => {
    assert.equal(productSubmitBlock({ photoBusy: true, photoError: null }), 'busy');
    assert.equal(productSubmitBlock({ photoBusy: false, photoError: 'This photo is still larger than 5 MB after shrinking it.' }), 'photo-rejected');
    assert.equal(productSubmitBlock({ photoBusy: false, photoError: null }), null);
  });
});
