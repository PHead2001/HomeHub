import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  PUSH_BADGE,
  PUSH_ICON,
  imageSourceFor,
  memberCanView,
  resolvePushImage,
  safePushImageUrl,
  webpushNotification,
} from '../../functions/src/shared/push-media';

const BUCKET = 'homehub-test.firebasestorage.app';
const HOUSE = 'house-a';
const storageUrl = (objectPath: string, bucket = BUCKET, extra = '') =>
  `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectPath)}?alt=media&token=abc${extra}`;
const petScope = { bucket: BUCKET, householdId: HOUSE, folders: ['pets/'] };

describe('push image URL policy', () => {
  test('an https download URL in this household\'s pet folder is used', () => {
    const url = storageUrl(`households/${HOUSE}/pets/maple.jpg`);
    assert.equal(safePushImageUrl(url, petScope), url);
  });

  test('image paths on the app origin are used', () => {
    assert.equal(safePushImageUrl('/icons/icon-192.png', petScope), '/icons/icon-192.png');
  });

  test('foreign hosts, schemes and placeholders are refused', () => {
    for (const url of [
      'https://placehold.co/300x300.png',
      'https://evil.example/households/house-a/pets/x.png',
      'http://firebasestorage.googleapis.com/v0/b/homehub-test.firebasestorage.app/o/households%2Fhouse-a%2Fpets%2Fx.png?alt=media',
      'https://firebasestorage.googleapis.com.evil.example/v0/b/x/o/households%2Fhouse-a%2Fpets%2Fx.png?alt=media',
      'https://user:pw@firebasestorage.googleapis.com/v0/b/homehub-test.firebasestorage.app/o/households%2Fhouse-a%2Fpets%2Fx.png?alt=media',
      'https://firebasestorage.googleapis.com:8443/v0/b/homehub-test.firebasestorage.app/o/households%2Fhouse-a%2Fpets%2Fx.png?alt=media',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      '//evil.example/x.png',
      '/\\evil.example/x.png',
      '/api/sw.png',
      '/icons/../secret.png',
      '/icons/icon.svg',
      42,
      undefined,
      '',
    ]) {
      assert.equal(safePushImageUrl(url, petScope), null, String(url));
    }
  });

  test('other buckets, other households and other folders are refused', () => {
    assert.equal(safePushImageUrl(storageUrl(`households/${HOUSE}/pets/x.jpg`, 'someone-else.appspot.com'), petScope), null);
    assert.equal(safePushImageUrl(storageUrl('households/house-b/pets/x.jpg'), petScope), null);
    assert.equal(safePushImageUrl(storageUrl(`households/${HOUSE}/maintenance/home_asset/a/receipt.jpg`), petScope), null);
    assert.equal(safePushImageUrl(storageUrl(`households/${HOUSE}/pets/../../house-b/pets/x.jpg`), petScope), null);
    assert.equal(safePushImageUrl(storageUrl(`households/${HOUSE}/pets/`), petScope), null);
    assert.equal(safePushImageUrl(storageUrl(`users/owner@example.test/avatars/me.jpg`), petScope), null);
    // Not a media download (metadata JSON), or no bucket configured.
    assert.equal(safePushImageUrl(storageUrl(`households/${HOUSE}/pets/x.jpg`).replace('alt=media', 'alt=json'), petScope), null);
    assert.equal(safePushImageUrl(storageUrl(`households/${HOUSE}/pets/x.jpg`), { ...petScope, bucket: '' }), null);
  });
});

describe('which record a notification points at', () => {
  test('pet reminders read the pet in the same household', () => {
    assert.deepEqual(imageSourceFor({ category: 'pets', sourceType: 'pet_feeding', sourceId: 'maple:2026-11-06|am' })?.path, ['pets', 'maple']);
    assert.deepEqual(imageSourceFor({ category: 'pets', sourceType: 'pet-medication', sourceId: 'maple' })?.path, ['pets', 'maple']);
  });

  test('shopping items and library products read their own documents', () => {
    assert.deepEqual(imageSourceFor({ category: 'shopping', sourceType: 'shopping_item', sourceId: 'weekly:milk' })?.path, ['shopping-lists', 'weekly', 'items', 'milk']);
    assert.deepEqual(imageSourceFor({ category: 'shopping', sourceType: 'barcode_library', sourceId: '0123456789' })?.path, ['barcode-library', '0123456789']);
  });

  test('anything else, or IDs that would escape the path, carry no image', () => {
    for (const notification of [
      { category: 'shopping', sourceType: 'shopping_list', sourceId: 'weekly' },
      { category: 'maintenance', sourceType: 'maintenance_asset_schedule', sourceId: 'hvac' },
      { category: 'chores', sourceType: 'pet_feeding', sourceId: 'maple' },
      { category: 'pets', sourceType: 'pet_feeding', sourceId: '..' },
      { category: 'pets', sourceType: 'pet_feeding', sourceId: '__name__' },
      { category: 'shopping', sourceType: 'shopping_item', sourceId: 'weekly/items/x:milk' },
      { category: 'shopping', sourceType: 'shopping_item', sourceId: 'weekly:milk:extra' },
      { category: 'pets', sourceType: 'pet_feeding' },
      {},
    ]) {
      assert.equal(imageSourceFor(notification), null, JSON.stringify(notification));
    }
  });
});

describe('resolving the push image', () => {
  const PET_URL = storageUrl(`households/${HOUSE}/pets/maple.jpg`);
  const LIBRARY_URL = storageUrl(`households/${HOUSE}/barcode-library/oats.jpg`);
  const docs: Record<string, Record<string, unknown>> = {
    [`households/${HOUSE}/pets/maple`]: { name: 'Maple', photoUrl: PET_URL },
    [`households/${HOUSE}/pets/placeholder`]: { name: 'Pip', photoUrl: 'https://placehold.co/300x300.png' },
    [`households/${HOUSE}/pets/borrowed`]: { name: 'Rex', photoUrl: storageUrl('households/house-b/pets/rex.jpg') },
    [`households/${HOUSE}/shopping-lists/weekly/items/oats`]: { name: 'Oats', barcode: '0123' },
    [`households/${HOUSE}/shopping-lists/weekly/items/eggs`]: { name: 'Eggs', imageUrl: 'https://images.openfoodfacts.org/eggs.jpg' },
    [`households/${HOUSE}/barcode-library/0123`]: { name: 'Oats', imageUrl: LIBRARY_URL },
    'households/house-b/pets/maple': { name: 'Other Maple', photoUrl: storageUrl('households/house-b/pets/maple.jpg') },
  };
  const reads: string[] = [];
  const read = async (path: string) => {
    reads.push(path);
    return docs[path];
  };
  const pet = (sourceId: string, householdId = HOUSE) => ({ householdId, category: 'pets', sourceType: 'pet_feeding', sourceId });

  test('a pet reminder carries the pet photo', async () => {
    assert.deepEqual(await resolvePushImage(read, HOUSE, pet('maple'), BUCKET), { url: PET_URL, permission: 'pets.view' });
  });

  test('a shopping item without a photo falls back to its library image', async () => {
    const image = await resolvePushImage(read, HOUSE, { householdId: HOUSE, category: 'shopping', sourceType: 'shopping_item', sourceId: 'weekly:oats' }, BUCKET);
    assert.deepEqual(image, { url: LIBRARY_URL, permission: 'shopping.view' });
  });

  test('foreign URLs and another household\'s files are refused', async () => {
    assert.equal(await resolvePushImage(read, HOUSE, pet('placeholder'), BUCKET), null);
    assert.equal(await resolvePushImage(read, HOUSE, pet('borrowed'), BUCKET), null);
    assert.equal(await resolvePushImage(read, HOUSE, { householdId: HOUSE, category: 'shopping', sourceType: 'shopping_item', sourceId: 'weekly:eggs' }, BUCKET), null);
  });

  test('reads stay inside the trigger household', async () => {
    reads.length = 0;
    // A document claiming another household is ignored outright.
    assert.equal(await resolvePushImage(read, HOUSE, pet('maple', 'house-b'), BUCKET), null);
    assert.equal(reads.length, 0);
    await resolvePushImage(read, HOUSE, pet('maple'), BUCKET);
    assert.ok(reads.every((path) => path.startsWith(`households/${HOUSE}/`)), reads.join(', '));
  });

  test('missing records and failing reads fall back to no image', async () => {
    assert.equal(await resolvePushImage(read, HOUSE, pet('ghost'), BUCKET), null);
    assert.equal(await resolvePushImage(async () => { throw new Error('unavailable'); }, HOUSE, pet('maple'), BUCKET), null);
    assert.equal(await resolvePushImage(read, HOUSE, { householdId: HOUSE, category: 'chores', title: 'Dishes' }, BUCKET), null);
  });
});

describe('who sees the picture', () => {
  test('mirrors the rules: owner always, overrides win, then role defaults', () => {
    assert.equal(memberCanView({ role: 'owner', permissions: { 'pets.view': false } }, 'pets.view'), true);
    assert.equal(memberCanView({ role: 'member' }, 'shopping.view'), true);
    assert.equal(memberCanView({ role: 'child' }, 'pets.view'), true);
    assert.equal(memberCanView({ role: 'child' }, 'shopping.view'), false);
    assert.equal(memberCanView({ role: 'child', permissions: { 'shopping.view': true } }, 'shopping.view'), true);
    assert.equal(memberCanView({ role: 'member', permissions: { 'pets.view': false } }, 'pets.view'), false);
    assert.equal(memberCanView({ role: 'newuser' }, 'pets.view'), false);
    assert.equal(memberCanView({}, 'pets.view'), false);
  });
});

describe('web push options', () => {
  test('always the app icon and badge; the image only when resolved', () => {
    assert.deepEqual(webpushNotification('n1', null), { icon: PUSH_ICON, badge: PUSH_BADGE, tag: 'n1' });
    assert.deepEqual(webpushNotification('n1', '/icons/icon-192.png'), { icon: PUSH_ICON, badge: PUSH_BADGE, tag: 'n1', image: '/icons/icon-192.png' });
    assert.equal(PUSH_ICON, '/icons/icon-192.png');
    assert.equal(PUSH_BADGE, '/icons/badge-96.png');
  });
});
