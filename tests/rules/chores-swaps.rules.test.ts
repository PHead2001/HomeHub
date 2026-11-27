import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

// CH-31: swap offers are written only by the server; the two people in one and members
// who may edit chores read it.
const projectId = 'demo-homehub-e2e';
const HOUSE = 'chores-swaps-rules-house';
let environment: RulesTestEnvironment;

type Identity = { uid: string; email: string };
const users = {
  owner: { uid: 'csr-owner', email: 'csr.owner@example.test' },
  sam: { uid: 'csr-sam', email: 'csr.sam@example.test' },
  ada: { uid: 'csr-ada', email: 'csr.ada@example.test' },
  kid: { uid: 'csr-kid', email: 'csr.kid@example.test' },
} satisfies Record<string, Identity>;

const offerRef = (user: Identity, id = 'offer-1') => doc(environment.authenticatedContext(user.uid, { email: user.email }).firestore(), 'households', HOUSE, 'chore-swaps', id);
const offer = { fromUid: users.sam.uid, toUid: users.ada.uid, fromChoreId: 'x', toChoreId: 'y', status: 'pending', createdAt: '2026-11-27T00:00:00.000Z', expiresAt: '2026-11-30T00:00:00.000Z' };

before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync(process.env.HOMEHUB_FIRESTORE_RULES ?? 'firestore.rules', 'utf8') },
  });
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'households', HOUSE), { name: 'Swaps', ownerUid: users.owner.uid, memberEmails: [] });
    for (const [user, role] of [[users.owner, 'owner'], [users.sam, 'member'], [users.ada, 'member'], [users.kid, 'child']] as const) {
      await setDoc(doc(db, 'households', HOUSE, 'members', user.uid), { uid: user.uid, role, status: 'active', displayName: user.uid });
    }
    await setDoc(doc(db, 'households', HOUSE, 'chore-swaps', 'offer-1'), offer);
  });
});

after(async () => {
  await environment?.cleanup();
});

describe('chore swap offers (CH-31)', () => {
  test('the two people and editors read it; a third member without chores.edit does not', async () => {
    await assertSucceeds(getDoc(offerRef(users.sam)));
    await assertSucceeds(getDoc(offerRef(users.ada)));
    await assertSucceeds(getDoc(offerRef(users.owner)));
    await assertFails(getDoc(offerRef(users.kid)));
  });

  test('no client writes one, not even the people in it', async () => {
    await assertFails(setDoc(offerRef(users.sam, 'forged'), offer));
    await assertFails(updateDoc(offerRef(users.ada), { status: 'accepted' }));
    await assertFails(updateDoc(offerRef(users.owner), { status: 'cancelled' }));
  });
});
