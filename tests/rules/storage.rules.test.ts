import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import { deleteObject, getBytes, ref, uploadBytes } from 'firebase/storage';

const projectId = 'demo-homehub-e2e';
const householdA = 'storage-household-a';
const householdB = 'storage-household-b';
let environment: RulesTestEnvironment;

type Identity = { uid: string; email: string };

const users = {
  owner: { uid: 's-owner', email: 's.owner@example.test' },
  member: { uid: 's-member', email: 's.member@example.test' },
  guest: { uid: 's-guest', email: 's.guest@example.test' },
  child: { uid: 's-child', email: 's.child@example.test' },
  admin: { uid: 's-admin', email: 's.admin@example.test' },
  // A member whose owner turned shopping editing off.
  noShopping: { uid: 's-no-shopping', email: 's.noshopping@example.test' },
  pending: { uid: 's-pending', email: 's.pending@example.test' },
  legacy: { uid: 's-legacy', email: 's.legacy@example.test' },
  ownerB: { uid: 's-owner-b', email: 's.ownerb@example.test' },
  stranger: { uid: 's-stranger', email: 's.stranger@example.test' },
} satisfies Record<string, Identity>;

const storageFor = (user: Identity) => environment
  .authenticatedContext(user.uid, { email: user.email })
  .storage();

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pdf = new TextEncoder().encode('%PDF-1.4 test');
const image = { contentType: 'image/png' };

before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync(process.env.HOMEHUB_FIRESTORE_RULES ?? 'firestore.rules', 'utf8') },
    storage: { rules: readFileSync(process.env.HOMEHUB_STORAGE_RULES ?? 'storage.rules', 'utf8') },
  });

  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'households', householdA), {
      name: 'Storage A',
      ownerUid: users.owner.uid,
      ownerEmail: users.owner.email,
      memberEmails: [users.owner.email, users.member.email, users.guest.email, users.pending.email, users.legacy.email],
    });
    for (const [user, role, status] of [
      [users.owner, 'owner', 'active'],
      [users.member, 'member', 'active'],
      [users.guest, 'guest', 'active'],
      [users.pending, 'newuser', 'pending'],
      [users.child, 'child', 'active'],
      [users.admin, 'admin', 'active'],
    ] as const) {
      await setDoc(doc(db, 'households', householdA, 'members', user.uid), { ...user, role, status });
    }
    await setDoc(doc(db, 'households', householdA, 'members', users.noShopping.uid), {
      ...users.noShopping, role: 'member', status: 'active', permissions: { 'shopping.edit': false },
    });
    await setDoc(doc(db, 'households', householdB), {
      name: 'Storage B', ownerUid: users.ownerB.uid, ownerEmail: users.ownerB.email, memberEmails: [users.ownerB.email],
    });
    await setDoc(doc(db, 'households', householdB, 'members', users.ownerB.uid), { ...users.ownerB, role: 'owner', status: 'active' });

    const storage = context.storage();
    await uploadBytes(ref(storage, `households/${householdA}/pets/maple.png`), png, image);
    await uploadBytes(ref(storage, `households/${householdA}/maintenance/home_asset/hvac/manual.pdf`), pdf, { contentType: 'application/pdf' });
    await uploadBytes(ref(storage, `households/${householdB}/pets/b.png`), png, image);
    await uploadBytes(ref(storage, `households/${householdA}/barcode-library/milk.png`), png, image);
    await uploadBytes(ref(storage, `households/${householdA}/barcode-library/keep.png`), png, image);
    await uploadBytes(ref(storage, `households/${householdB}/barcode-library/b.png`), png, image);
  });
});

after(async () => environment?.cleanup());

describe('household files', () => {
  test('approved members read their household files; others cannot', async () => {
    await assertSucceeds(getBytes(ref(storageFor(users.member), `households/${householdA}/pets/maple.png`)));
    await assertSucceeds(getBytes(ref(storageFor(users.guest), `households/${householdA}/maintenance/home_asset/hvac/manual.pdf`)));
    for (const user of [users.pending, users.legacy, users.ownerB, users.stranger]) {
      await assertFails(getBytes(ref(storageFor(user), `households/${householdA}/pets/maple.png`)));
    }
    await assertFails(getBytes(ref(environment.unauthenticatedContext().storage(), `households/${householdA}/pets/maple.png`)));
  });

  test('pet photos need pet-profile permission and must be images', async () => {
    await assertSucceeds(uploadBytes(ref(storageFor(users.owner), `households/${householdA}/pets/new.png`), png, image));
    await assertFails(uploadBytes(ref(storageFor(users.member), `households/${householdA}/pets/member.png`), png, image));
    await assertFails(uploadBytes(ref(storageFor(users.guest), `households/${householdA}/pets/guest.png`), png, image));
    await assertFails(uploadBytes(ref(storageFor(users.owner), `households/${householdA}/pets/doc.pdf`), pdf, { contentType: 'application/pdf' }));
    await assertFails(deleteObject(ref(storageFor(users.member), `households/${householdA}/pets/maple.png`)));
  });

  test('maintenance attachments follow maintenance permissions and size/type limits', async () => {
    await assertSucceeds(uploadBytes(ref(storageFor(users.member), `households/${householdA}/maintenance/vehicle/suv/receipt.pdf`), pdf, { contentType: 'application/pdf' }));
    await assertFails(uploadBytes(ref(storageFor(users.guest), `households/${householdA}/maintenance/vehicle/suv/guest.pdf`), pdf, { contentType: 'application/pdf' }));
    await assertFails(uploadBytes(ref(storageFor(users.member), `households/${householdA}/maintenance/other/x/a.pdf`), pdf, { contentType: 'application/pdf' }));
    await assertFails(uploadBytes(ref(storageFor(users.member), `households/${householdA}/maintenance/vehicle/suv/run.html`), pdf, { contentType: 'text/html' }));
    const tooBig = new Uint8Array(16 * 1024 * 1024);
    await assertFails(uploadBytes(ref(storageFor(users.owner), `households/${householdA}/maintenance/vehicle/suv/huge.pdf`), tooBig, { contentType: 'application/pdf' }));
    await assertFails(deleteObject(ref(storageFor(users.member), `households/${householdA}/maintenance/home_asset/hvac/manual.pdf`)));
    await assertFails(deleteObject(ref(storageFor(users.guest), `households/${householdA}/maintenance/home_asset/hvac/manual.pdf`)));
  });

  test('outsiders cannot write into another household or unknown paths', async () => {
    await assertFails(uploadBytes(ref(storageFor(users.ownerB), `households/${householdA}/pets/b.png`), png, image));
    await assertFails(uploadBytes(ref(storageFor(users.owner), `anything/else.png`), png, image));
    await assertFails(uploadBytes(ref(storageFor(users.owner), `households/${householdA}/random/file.png`), png, image));
  });
});

describe('barcode library images', () => {
  const barcode = (user: Identity, name: string, household = householdA) =>
    ref(storageFor(user), `households/${household}/barcode-library/${name}`);

  test('shopping viewers read them; children, pending members and outsiders cannot', async () => {
    for (const user of [users.owner, users.admin, users.member, users.guest, users.noShopping]) {
      await assertSucceeds(getBytes(barcode(user, 'milk.png')));
    }
    for (const user of [users.child, users.pending, users.legacy, users.ownerB, users.stranger]) {
      await assertFails(getBytes(barcode(user, 'milk.png')));
    }
    await assertFails(getBytes(ref(environment.unauthenticatedContext().storage(), `households/${householdA}/barcode-library/milk.png`)));
    await assertFails(getBytes(barcode(users.owner, 'b.png', householdB)));
  });

  test('only shopping editors upload, including in nested folders', async () => {
    await assertSucceeds(uploadBytes(barcode(users.owner, 'owner.png'), png, image));
    await assertSucceeds(uploadBytes(barcode(users.admin, 'admin.webp'), png, { contentType: 'image/webp' }));
    await assertSucceeds(uploadBytes(barcode(users.member, 'products/0123456789012.jpg'), png, { contentType: 'image/jpeg' }));
    for (const user of [users.guest, users.child, users.pending, users.legacy, users.noShopping, users.stranger]) {
      await assertFails(uploadBytes(barcode(user, `${user.uid}.png`), png, image));
    }
    await assertFails(uploadBytes(barcode(users.ownerB, 'cross.png'), png, image));
  });

  test('an editor may replace an existing image', async () => {
    await assertSucceeds(uploadBytes(barcode(users.member, 'milk.png'), png, image));
    await assertFails(uploadBytes(barcode(users.guest, 'milk.png'), png, image));
  });

  test('uploads must be images of 5 MB or less', async () => {
    for (const contentType of ['image/png', 'image/jpeg', 'image/gif', 'image/heic', 'image/heif', 'image/avif']) {
      await assertSucceeds(uploadBytes(barcode(users.member, `ok-${contentType.split('/')[1]}`), png, { contentType }));
    }
    for (const contentType of ['application/pdf', 'text/html', 'image/svg+xml', 'application/octet-stream']) {
      await assertFails(uploadBytes(barcode(users.owner, `bad-${contentType.replace(/\W/g, '-')}`), pdf, { contentType }));
    }
    await assertSucceeds(uploadBytes(barcode(users.owner, 'limit.png'), new Uint8Array(5 * 1024 * 1024), image));
    await assertFails(uploadBytes(barcode(users.owner, 'over.png'), new Uint8Array(5 * 1024 * 1024 + 1), image));
  });

  test('only owners and admins delete (shopping.delete)', async () => {
    for (const user of [users.member, users.guest, users.child, users.pending, users.noShopping, users.ownerB]) {
      await assertFails(deleteObject(barcode(user, 'keep.png')));
    }
    await assertSucceeds(deleteObject(barcode(users.admin, 'keep.png')));
    await assertSucceeds(deleteObject(barcode(users.owner, 'milk.png')));
  });
});

describe('avatars', () => {
  test('nobody writes new photos under an email, their own included', async () => {
    await assertFails(uploadBytes(ref(storageFor(users.member), `users/${users.member.email}/avatars/me.png`), png, image));
    await assertFails(uploadBytes(ref(storageFor(users.member), `users/${users.owner.email}/avatars/spoof.png`), png, image));
    await assertFails(uploadBytes(ref(storageFor(users.member), `users/${users.member.email}/avatars/doc.pdf`), pdf, { contentType: 'application/pdf' }));
  });

  test('avatars under the account ID: only that account writes; signed-in people read; same limits', async () => {
    const own = (name: string) => ref(storageFor(users.member), `users/${users.member.uid}/avatars/${name}`);
    await assertSucceeds(uploadBytes(own('me.png'), png, image));
    await assertSucceeds(uploadBytes(own('me.png'), png, { contentType: 'image/webp' }));
    await assertSucceeds(getBytes(ref(storageFor(users.owner), `users/${users.member.uid}/avatars/me.png`)));
    await assertSucceeds(getBytes(ref(storageFor(users.stranger), `users/${users.member.uid}/avatars/me.png`)));
    await assertFails(getBytes(ref(environment.unauthenticatedContext().storage(), `users/${users.member.uid}/avatars/me.png`)));
    await assertFails(uploadBytes(ref(storageFor(users.owner), `users/${users.member.uid}/avatars/spoof.png`), png, image));
    await assertFails(uploadBytes(own('doc.pdf'), pdf, { contentType: 'application/pdf' }));
    await assertSucceeds(uploadBytes(own('limit.png'), new Uint8Array(5 * 1024 * 1024), image));
    await assertFails(uploadBytes(own('over.png'), new Uint8Array(5 * 1024 * 1024 + 1), image));
    await assertFails(deleteObject(ref(storageFor(users.owner), `users/${users.member.uid}/avatars/me.png`)));
    await assertSucceeds(deleteObject(own('me.png')));
  });

  test('older photos under the email stay readable and their owner may delete them', async () => {
    await environment.withSecurityRulesDisabled(async context => {
      await uploadBytes(ref(context.storage(), `users/${users.member.email}/avatars/old.png`), png, image);
    });
    const legacy = ref(storageFor(users.member), `users/${users.member.email}/avatars/old.png`);
    await assertSucceeds(getBytes(ref(storageFor(users.guest), `users/${users.member.email}/avatars/old.png`)));
    await assertFails(uploadBytes(legacy, png, image));
    await assertFails(deleteObject(ref(storageFor(users.guest), `users/${users.member.email}/avatars/old.png`)));
    await assertSucceeds(deleteObject(legacy));
  });
});
