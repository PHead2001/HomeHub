import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, deleteField, doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { restoreItemData } from '../../src/lib/shopping/items';

// Items a wall tablet wrote (docs/modules/devices/README.md, "Device actions: shopping";
// section 12): the server's `shopping.add` stores `deviceAttribution` on a new item and
// `shopping.tick` stores `purchaseDeviceAttribution` on a ticked one. A phone keeps working
// on those items exactly as on any other (tick, un-tick, Undo of a tick, edit, delete, and the
// Undo of a delete, which drops both fields), and no personal client may add, change or
// remove either field.
const projectId = 'demo-homehub-e2e';
const HOUSE = 'shopping-device-rules-house';
const LIST = 'groceries';
let environment: RulesTestEnvironment;

type Identity = { uid: string; email: string };
const users = {
  member: { uid: 'sdr-member', email: 'sdr.member@example.test' },
  other: { uid: 'sdr-other', email: 'sdr.other@example.test' },
} satisfies Record<string, Identity>;

const DEVICE = { deviceId: 'tablet-1', deviceName: 'Kitchen tablet', generation: 1, actorUid: users.other.uid, level: 'face' };

const dbFor = (user: Identity) => environment.authenticatedContext(user.uid, { email: user.email }).firestore();
const itemRef = (user: Identity, id: string) => doc(dbFor(user), 'households', HOUSE, 'shopping-lists', LIST, 'items', id);

/** An item as the server's device add writes it (Admin SDK: no rules). */
const deviceItem = (id: string, extra: Record<string, unknown> = {}) => ({
  name: `Item ${id}`, nameKey: `item ${id}`, quantity: 1, category: 'Other', categorySource: 'fallback', status: 'needed',
  createdAt: new Date('2026-11-20T10:00:00Z'), addedByUid: users.other.uid, deviceAttribution: DEVICE, ...extra,
});

const seed = (id: string, data: Record<string, unknown>) => environment.withSecurityRulesDisabled(async (context) => {
  await setDoc(doc(context.firestore(), 'households', HOUSE, 'shopping-lists', LIST, 'items', id), data);
});

before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync(process.env.HOMEHUB_FIRESTORE_RULES ?? 'firestore.rules', 'utf8') },
  });
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'households', HOUSE), { name: 'Shopping devices', ownerUid: 'nobody', memberEmails: [] });
    for (const user of [users.member, users.other]) {
      // The phone may also delete items (a member's default does not include it), so the
      // delete-and-Undo case runs as it does for someone allowed to delete.
      await setDoc(doc(db, 'households', HOUSE, 'members', user.uid), {
        uid: user.uid, role: 'member', status: 'active', displayName: user.uid,
        ...(user === users.member ? { permissions: { 'shopping.delete': true } } : {}),
      });
    }
    await setDoc(doc(db, 'households', HOUSE, 'shopping-lists', LIST), { name: 'Groceries', type: 'Grocery' });
  });
});

after(async () => {
  await environment?.cleanup();
});

describe('a phone on items a wall tablet added or ticked', () => {
  test('ticks, un-ticks and undoes its own tick on a tablet-added item; the attribution stays', async () => {
    await seed('tick', deviceItem('tick'));
    const ref = itemRef(users.member, 'tick');
    await assertSucceeds(updateDoc(ref, { status: 'purchased', purchasedByUid: users.member.uid, purchasedAt: serverTimestamp(), purchaseOpId: 'phone-1', undoOpId: deleteField() }));
    await assertSucceeds(updateDoc(ref, { status: 'needed', undoOpId: 'phone-1', purchasedByUid: null, purchasedAt: null }));
    await assertSucceeds(updateDoc(ref, { name: 'Renamed', nameKey: 'renamed', editedByUid: users.member.uid, editedAt: serverTimestamp() }));
  });

  test('un-ticks and re-ticks an item a tablet ticked (the purchase attribution is left as it is)', async () => {
    await seed('ticked', deviceItem('ticked', {
      status: 'purchased', purchasedByUid: users.other.uid, purchasedAt: new Date(), purchaseOpId: 'device-op',
      purchaseDeviceAttribution: { ...DEVICE, purchaseOpId: 'device-op' },
    }));
    const ref = itemRef(users.member, 'ticked');
    await assertSucceeds(updateDoc(ref, { status: 'needed', purchasedByUid: null, purchasedAt: null }));
    await assertSucceeds(updateDoc(ref, { status: 'purchased', purchasedByUid: users.member.uid, purchasedAt: serverTimestamp(), purchaseOpId: 'phone-2', undoOpId: deleteField() }));
  });

  test('may not remove or change either attribution, nor add one', async () => {
    await seed('stamps', deviceItem('stamps', { purchaseDeviceAttribution: { ...DEVICE, purchaseOpId: 'device-op' } }));
    const ref = itemRef(users.member, 'stamps');
    await assertFails(updateDoc(ref, { deviceAttribution: deleteField() }));
    await assertFails(updateDoc(ref, { deviceAttribution: { ...DEVICE, actorUid: users.member.uid } }));
    await assertFails(updateDoc(ref, { purchaseDeviceAttribution: deleteField() }));
    await assertFails(updateDoc(ref, { purchaseDeviceAttribution: { ...DEVICE, purchaseOpId: 'forged' } }));
    await seed('plain', deviceItem('plain', { deviceAttribution: null }));
    await assertFails(updateDoc(itemRef(users.member, 'plain'), { deviceAttribution: DEVICE }));
    await assertFails(setDoc(itemRef(users.member, 'forged-create'), { ...deviceItem('forged-create'), addedByUid: users.member.uid }));
    await assertFails(setDoc(itemRef(users.member, 'forged-purchase'), {
      name: 'Forged', nameKey: 'forged', quantity: 1, category: 'Other', status: 'needed', createdAt: new Date(), addedByUid: users.member.uid,
      purchaseDeviceAttribution: { ...DEVICE, purchaseOpId: 'x' },
    }));
  });

  test('deletes it, and its Undo re-creates it without the tablet fields (restoreItemData drops them)', async () => {
    await seed('restore', deviceItem('restore', { purchaseDeviceAttribution: { ...DEVICE, purchaseOpId: 'device-op' } }));
    const ref = itemRef(users.member, 'restore');
    const snapshot = (await getDoc(ref)).data()!;
    await assertSucceeds(deleteDoc(ref));
    const restored = restoreItemData(snapshot, users.member.uid, 'restore-op-1');
    await assertSucceeds(setDoc(ref, { ...restored, restoredAt: serverTimestamp() }));
  });
});
