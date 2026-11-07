import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { memberCanView, resolvePushImage } from '../../functions/src/shared/push-media';

// The push sender's image lookup against the Firestore emulator, through the
// Admin SDK, exactly as sendPushOnNewNotification reads it.
const BUCKET = 'homehub-e2e.firebasestorage.app';
const HOUSE = 'push-media-house';
const OTHER = 'push-media-other';
const url = (objectPath: string) =>
  `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(objectPath)}?alt=media&token=t`;
const readDoc = async (path: string) => (await adminDb.doc(path).get()).data();
const house = (id: string) => adminDb.collection('households').doc(id);

before(async () => {
  await Promise.all([adminDb.recursiveDelete(house(HOUSE)), adminDb.recursiveDelete(house(OTHER))]);
  await house(HOUSE).collection('pets').doc('maple').set({ name: 'Maple', photoUrl: url(`households/${HOUSE}/pets/maple.jpg`) });
  await house(HOUSE).collection('pets').doc('stray').set({ name: 'Stray', photoUrl: url(`households/${OTHER}/pets/rex.jpg`) });
  await house(HOUSE).collection('pets').doc('placeholder').set({ name: 'Pip', photoUrl: 'https://placehold.co/300x300.png' });
  await house(HOUSE).collection('shopping-lists').doc('weekly').collection('items').doc('oats').set({ name: 'Oats', barcode: '0123' });
  await house(HOUSE).collection('barcode-library').doc('0123').set({ name: 'Oats', imageUrl: url(`households/${HOUSE}/barcode-library/oats.jpg`) });
  await house(OTHER).collection('pets').doc('rex').set({ name: 'Rex', photoUrl: url(`households/${OTHER}/pets/rex.jpg`) });
});

after(async () => {
  await Promise.all([adminDb.recursiveDelete(house(HOUSE)), adminDb.recursiveDelete(house(OTHER))]);
});

const pet = (sourceId: string) => ({ householdId: HOUSE, category: 'pets', sourceType: 'pet_feeding', sourceId });

describe('push image lookup', () => {
  test('a pet reminder carries the pet photo from the same household', async () => {
    assert.deepEqual(await resolvePushImage(readDoc, HOUSE, pet('maple'), BUCKET), {
      url: url(`households/${HOUSE}/pets/maple.jpg`),
      permission: 'pets.view',
    });
  });

  test('a shopping item falls back to its barcode library image', async () => {
    const image = await resolvePushImage(readDoc, HOUSE, {
      householdId: HOUSE, category: 'shopping', sourceType: 'shopping_item', sourceId: 'weekly:oats',
    }, BUCKET);
    assert.equal(image?.url, url(`households/${HOUSE}/barcode-library/oats.jpg`));
  });

  test('another household\'s pet, foreign URLs and missing records give no image', async () => {
    // `rex` exists only in the other household: the lookup never reads there.
    assert.equal(await resolvePushImage(readDoc, HOUSE, pet('rex'), BUCKET), null);
    // A pet in this household pointing at the other household's file.
    assert.equal(await resolvePushImage(readDoc, HOUSE, pet('stray'), BUCKET), null);
    assert.equal(await resolvePushImage(readDoc, HOUSE, pet('placeholder'), BUCKET), null);
    assert.equal(await resolvePushImage(readDoc, HOUSE, pet('ghost'), BUCKET), null);
    // A document that claims another household is ignored.
    assert.equal(await resolvePushImage(readDoc, HOUSE, { ...pet('maple'), householdId: OTHER }, BUCKET), null);
  });

  test('a child without shopping.view would not get a product picture', () => {
    assert.equal(memberCanView({ role: 'child' }, 'shopping.view'), false);
    assert.equal(memberCanView({ role: 'child' }, 'pets.view'), true);
  });
});
