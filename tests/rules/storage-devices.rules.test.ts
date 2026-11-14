import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
  type TokenOptions,
} from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import { deleteObject, getBytes, ref, uploadBytes } from 'firebase/storage';

// Storage rules for registered wall tablets (docs/modules/devices/README.md, 5.3):
// reads only, per enabled section, for the PATH's household only (R6: household A's
// tablet never reads household B's files, even when B has a record with its id);
// profile photos from account-ID folders only; no uploads or deletes.

const projectId = 'demo-homehub-e2e';
const A = 'storage-dev-a';
const B = 'storage-dev-b';
let environment: RulesTestEnvironment;

const id20 = (prefix: string) => prefix.padEnd(20, '0');
const D = { active: id20('SDevActive'), off: id20('SDevOff'), removed: id20('SDevRemoved'), b: id20('SDevB') };
const allOn = { chores: true, shopping: true, pets: true, calendar: true, maintenance: true };
const allOff = { chores: false, shopping: false, pets: false, calendar: false, maintenance: false };

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const image = { contentType: 'image/png' };
const memberUid = 'sdev-member';
const memberEmail = 'sdev.member@example.test';

const deviceStorage = (deviceId: string, household = A, gen = 2, extra: Record<string, unknown> = {}, uid = `device_${deviceId}`) =>
  environment.authenticatedContext(uid, {
    hh_kind: 'device', hh_household: household, hh_device: deviceId, hh_gen: gen,
    firebase: { sign_in_provider: 'custom', identities: {} },
    ...extra,
  } as unknown as TokenOptions).storage();

/** One file per household-scoped clause and the section that opens it. */
const FILES = [
  { section: 'pets', path: (h: string) => `households/${h}/pets/p1/photo.png` },
  { section: 'shopping', path: (h: string) => `households/${h}/barcode-library/milk.png` },
  { section: 'maintenance', path: (h: string) => `households/${h}/maintenance/home_asset/hvac/manual.png` },
] as const;

before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync(process.env.HOMEHUB_FIRESTORE_RULES ?? 'firestore.rules', 'utf8') },
    storage: { rules: readFileSync(process.env.HOMEHUB_STORAGE_RULES ?? 'storage.rules', 'utf8') },
  });
  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    const record = (status: string, generation: number, sections = allOn) => ({ name: 'Hall', room: 'Hall', status, generation, sections });
    await setDoc(doc(db, 'households', A), { name: 'A', ownerUid: 'x' });
    await setDoc(doc(db, 'households', B), { name: 'B', ownerUid: 'y' });
    await setDoc(doc(db, 'households', A, 'devices', D.active), record('active', 2));
    await setDoc(doc(db, 'households', A, 'devices', D.off), record('active', 2, allOff));
    await setDoc(doc(db, 'households', A, 'devices', D.removed), record('removed', 3));
    await setDoc(doc(db, 'households', B, 'devices', D.b), record('active', 2));
    // Household A's tablet id also registered (active) in B: only the path's household counts.
    await setDoc(doc(db, 'households', B, 'devices', D.active), record('active', 2));

    const storage = context.storage();
    for (const household of [A, B]) {
      for (const file of FILES) await uploadBytes(ref(storage, file.path(household)), png, image);
    }
    await uploadBytes(ref(storage, `users/${memberUid}/avatars/me.png`), png, image);
    await uploadBytes(ref(storage, `users/${memberEmail}/avatars/old.png`), png, image);
  });
});

after(async () => environment?.cleanup());

describe('household files for tablets', () => {
  for (const file of FILES) {
    test(`${file.section}: an active tablet with the section on reads its own household's file`, async () => {
      await assertSucceeds(getBytes(ref(deviceStorage(D.active), file.path(A))));
      await assertSucceeds(getBytes(ref(deviceStorage(D.b, B), file.path(B))));
    });

    test(`${file.section}: household A's tablet never reads household B's file (cross-household)`, async () => {
      await assertFails(getBytes(ref(deviceStorage(D.active), file.path(B))));
      // And household B's tablet never reads household A's file.
      await assertFails(getBytes(ref(deviceStorage(D.b, B), file.path(A))));
    });

    test(`${file.section}: refused when the section is off, the tablet is removed, the generation is old, or signed out`, async () => {
      await assertFails(getBytes(ref(deviceStorage(D.off), file.path(A))));
      await assertFails(getBytes(ref(deviceStorage(D.removed, A, 3), file.path(A))));
      await assertFails(getBytes(ref(deviceStorage(D.active, A, 1), file.path(A))));
      await assertFails(getBytes(ref(environment.unauthenticatedContext().storage(), file.path(A))));
    });

    test(`${file.section}: forged device tokens are refused`, async () => {
      await assertFails(getBytes(ref(deviceStorage(D.active, A, 2, {}, `device_${D.off}`), file.path(A))));
      await assertFails(getBytes(ref(deviceStorage(D.active, A, 2, { email: 'tablet@example.test' }), file.path(A))));
      await assertFails(getBytes(ref(deviceStorage(D.active, A, 2, { firebase: { identities: {} } }), file.path(A))));
      await assertFails(getBytes(ref(deviceStorage(D.active, A, 2, { hh_gen: '2' }), file.path(A))));
    });

    test(`${file.section}: a tablet never uploads, replaces or deletes`, async () => {
      const storage = deviceStorage(D.active);
      await assertFails(uploadBytes(ref(storage, file.path(A).replace(/[^/]+$/, 'new.png')), png, image));
      await assertFails(uploadBytes(ref(storage, file.path(A)), png, image));
      await assertFails(deleteObject(ref(storage, file.path(A))));
    });
  }
});

describe('profile photos for the face row', () => {
  test('an active tablet reads account-ID folders, never email-named ones', async () => {
    await assertSucceeds(getBytes(ref(deviceStorage(D.active), `users/${memberUid}/avatars/me.png`)));
    await assertFails(getBytes(ref(deviceStorage(D.active), `users/${memberEmail}/avatars/old.png`)));
  });

  test('a removed or outdated tablet reads no photos, and never uploads one', async () => {
    await assertFails(getBytes(ref(deviceStorage(D.removed, A, 3), `users/${memberUid}/avatars/me.png`)));
    await assertFails(getBytes(ref(deviceStorage(D.active, A, 1), `users/${memberUid}/avatars/me.png`)));
    await assertFails(uploadBytes(ref(deviceStorage(D.active), `users/device_${D.active}/avatars/me.png`), png, image));
    await assertFails(uploadBytes(ref(deviceStorage(D.active), `users/${memberUid}/avatars/x.png`), png, image));
  });
});
