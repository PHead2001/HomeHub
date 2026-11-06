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
    ] as const) {
      await setDoc(doc(db, 'households', householdA, 'members', user.uid), { ...user, role, status });
    }
    await setDoc(doc(db, 'households', householdB), {
      name: 'Storage B', ownerUid: users.ownerB.uid, ownerEmail: users.ownerB.email, memberEmails: [users.ownerB.email],
    });
    await setDoc(doc(db, 'households', householdB, 'members', users.ownerB.uid), { ...users.ownerB, role: 'owner', status: 'active' });

    const storage = context.storage();
    await uploadBytes(ref(storage, `households/${householdA}/pets/maple.png`), png, image);
    await uploadBytes(ref(storage, `households/${householdA}/maintenance/home_asset/hvac/manual.pdf`), pdf, { contentType: 'application/pdf' });
    await uploadBytes(ref(storage, `households/${householdB}/pets/b.png`), png, image);
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

describe('avatars', () => {
  test('users manage only their own avatar images', async () => {
    await assertSucceeds(uploadBytes(ref(storageFor(users.member), `users/${users.member.email}/avatars/me.png`), png, image));
    await assertFails(uploadBytes(ref(storageFor(users.member), `users/${users.owner.email}/avatars/spoof.png`), png, image));
    await assertFails(uploadBytes(ref(storageFor(users.member), `users/${users.member.email}/avatars/doc.pdf`), pdf, { contentType: 'application/pdf' }));
  });
});
