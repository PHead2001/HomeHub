import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteField, doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { deleteObject, getBytes, ref, uploadBytes } from 'firebase/storage';

// CH-30: photo proof for kids. Firestore: `requiresPhoto` on a library chore is a bool;
// `proof` on a chore is server-only; a chore whose library chore asks for a photo is
// never completed by a client write. Storage: a kid uploads an image named for
// themselves and marked as theirs into the chore's proof folder; approvers and the
// uploader read it; nobody overwrites it.
const projectId = 'demo-homehub-e2e';
const HOUSE = 'chores-proof-rules-house';
let environment: RulesTestEnvironment;

type Identity = { uid: string; email: string };
const users = {
  owner: { uid: 'cpr-owner', email: 'cpr.owner@example.test' },
  member: { uid: 'cpr-member', email: 'cpr.member@example.test' },
  kid: { uid: 'cpr-kid', email: 'cpr.kid@example.test' },
  guest: { uid: 'cpr-guest', email: 'cpr.guest@example.test' },
} satisfies Record<string, Identity>;

const contextOf = (user: Identity) => environment.authenticatedContext(user.uid, { email: user.email });
const choreRef = (user: Identity, id: string) => doc(contextOf(user).firestore(), 'households', HOUSE, 'chores', id);
const templateRef = (user: Identity, id: string) => doc(contextOf(user).firestore(), 'households', HOUSE, 'chore-templates', id);
const proofObject = (user: Identity, choreId: string, file: string) => ref(contextOf(user).storage(), `households/${HOUSE}/chore-proofs/${choreId}/${file}`);

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const asKid = (uid: string) => ({ contentType: 'image/png', customMetadata: { uploadedByUid: uid } });

const chore = (templateId: string) => ({
  task: 'Dishes', assignedToUid: users.kid.uid, dueDate: '2026-11-27T06:00:00.000Z', originalDueDate: '2026-11-27',
  isCompleted: false, notes: '', subTasks: [], completedSubTasks: [], roomIds: [], templateId,
});

before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync(process.env.HOMEHUB_FIRESTORE_RULES ?? 'firestore.rules', 'utf8') },
    storage: { rules: readFileSync(process.env.HOMEHUB_STORAGE_RULES ?? 'storage.rules', 'utf8') },
  });
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'households', HOUSE), { name: 'Proof', ownerUid: users.owner.uid, memberEmails: [] });
    for (const [user, role] of [[users.owner, 'owner'], [users.member, 'member'], [users.kid, 'child'], [users.guest, 'guest']] as const) {
      await setDoc(doc(db, 'households', HOUSE, 'members', user.uid), { uid: user.uid, role, status: 'active', displayName: user.uid });
    }
    await setDoc(doc(db, 'households', HOUSE, 'chore-templates', 'photo'), { task: 'Dishes', requiresPhoto: true, roomIds: [], subTasks: [] });
    await setDoc(doc(db, 'households', HOUSE, 'chore-templates', 'plain'), { task: 'Bins', roomIds: [], subTasks: [] });
    await setDoc(doc(db, 'households', HOUSE, 'chores', 'photo-day'), chore('photo'));
    await setDoc(doc(db, 'households', HOUSE, 'chores', 'plain-day'), chore('plain'));
    await setDoc(doc(db, 'households', HOUSE, 'chores', 'pending-day'), {
      ...chore('photo'), proof: { status: 'pending', submittedByUid: users.kid.uid, submittedAt: '2026-11-27T18:00:00.000Z', photoPath: 'x' },
    });
  });
});

after(async () => {
  await environment?.cleanup();
});

describe('photo proof in Firestore (CH-30)', () => {
  test('requiresPhoto is a bool that editors set on a library chore', async () => {
    await assertSucceeds(updateDoc(templateRef(users.member, 'plain'), { requiresPhoto: false }));
    await assertFails(updateDoc(templateRef(users.member, 'plain'), { requiresPhoto: 'yes' }));
    await assertFails(updateDoc(templateRef(users.kid, 'plain'), { requiresPhoto: true }));
  });

  test('no client completes a chore that asks for a photo, not even an adult on an older client', async () => {
    const completion = { isCompleted: true, completedAt: '2026-11-27T18:00:00.000Z', completedAtServer: serverTimestamp() };
    await assertFails(updateDoc(choreRef(users.kid, 'photo-day'), completion));
    await assertFails(updateDoc(choreRef(users.owner, 'photo-day'), completion));
    await assertSucceeds(updateDoc(choreRef(users.kid, 'plain-day'), completion));
  });

  test('proof is written only by the server', async () => {
    await assertFails(updateDoc(choreRef(users.kid, 'photo-day'), { proof: { status: 'pending', submittedByUid: users.kid.uid, submittedAt: 'now' } }));
    await assertFails(updateDoc(choreRef(users.owner, 'pending-day'), { proof: deleteField() }));
    await assertFails(updateDoc(choreRef(users.owner, 'pending-day'), { 'proof.status': 'approved' }));
    // Other edits of a chore with a proof keep working.
    await assertSucceeds(updateDoc(choreRef(users.owner, 'pending-day'), { notes: 'Use the blue sponge' }));
    await assertFails(setDoc(doc(contextOf(users.member).firestore(), 'households', HOUSE, 'chores', 'forged'), {
      ...chore('plain'), assignedToUid: users.member.uid, proof: { status: 'pending' },
    }));
  });
});

describe('photo proof in Storage (CH-30)', () => {
  test('a kid uploads their own image into the chore folder; others read it only as approvers', async () => {
    const mine = `${users.kid.uid}-AbCdEf123456.png`;
    await assertSucceeds(uploadBytes(proofObject(users.kid, 'photo-day', mine), png, asKid(users.kid.uid)));
    await assertSucceeds(getBytes(proofObject(users.kid, 'photo-day', mine)));
    await assertSucceeds(getBytes(proofObject(users.owner, 'photo-day', mine)));
    await assertSucceeds(getBytes(proofObject(users.member, 'photo-day', mine)));
    await assertFails(getBytes(proofObject(users.guest, 'photo-day', mine)));
    // Never overwritten, and only chores.delete removes it.
    await assertFails(uploadBytes(proofObject(users.kid, 'photo-day', mine), png, asKid(users.kid.uid)));
    await assertFails(deleteObject(proofObject(users.kid, 'photo-day', mine)));
    await assertSucceeds(deleteObject(proofObject(users.owner, 'photo-day', mine)));
  });

  test('refuses a file named or marked for someone else, a non-image, and guests', async () => {
    await assertFails(uploadBytes(proofObject(users.kid, 'photo-day', `${users.member.uid}-AbCdEf123456.png`), png, asKid(users.kid.uid)));
    await assertFails(uploadBytes(proofObject(users.kid, 'photo-day', `${users.kid.uid}-AbCdEf123457.png`), png, asKid(users.member.uid)));
    await assertFails(uploadBytes(proofObject(users.kid, 'photo-day', `${users.kid.uid}-AbCdEf123458.png`), png, { contentType: 'application/pdf', customMetadata: { uploadedByUid: users.kid.uid } }));
    await assertFails(uploadBytes(proofObject(users.guest, 'photo-day', `${users.guest.uid}-AbCdEf123459.png`), png, asKid(users.guest.uid)));
  });
});
