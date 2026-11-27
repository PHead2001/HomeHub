import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, deleteField, doc, setDoc, updateDoc, writeBatch } from 'firebase/firestore';

// CH-24: whoever created a chore or a library chore manages it without chores.delete.
// `createdByUid` is optional (older clients, quick add), the writer on create, and never
// changed or removed. With chores.create the creator may edit, stop and delete their
// library chore and delete its OPEN generated days, and delete their own OPEN one-time
// chores; completed chores (someone's points) stay for everyone without chores.delete.
const projectId = 'demo-homehub-e2e';
const HOUSE = 'chores-creators-rules-house';
let environment: RulesTestEnvironment;

type Identity = { uid: string; email: string };
const users = {
  owner: { uid: 'ccr-owner', email: 'ccr.owner@example.test' },
  member: { uid: 'ccr-member', email: 'ccr.member@example.test' },
  other: { uid: 'ccr-other', email: 'ccr.other@example.test' },
  kid: { uid: 'ccr-kid', email: 'ccr.kid@example.test' },
  noEdit: { uid: 'ccr-noedit', email: 'ccr.noedit@example.test' },
} satisfies Record<string, Identity>;

const dbFor = (user: Identity) => environment.authenticatedContext(user.uid, { email: user.email }).firestore();
const templateRef = (user: Identity, id: string) => doc(dbFor(user), 'households', HOUSE, 'chore-templates', id);
const choreRef = (user: Identity, id: string) => doc(dbFor(user), 'households', HOUSE, 'chores', id);

const seed = (path: string[], data: Record<string, unknown>) => environment.withSecurityRulesDisabled(async (context) => {
  await setDoc(doc(context.firestore(), 'households', HOUSE, ...path), data);
});

const template = (createdByUid?: string) => ({
  task: 'Dishes', notes: '', roomIds: [], subTasks: [], assignedToUid: users.member.uid,
  recurrence: { frequency: 'daily', interval: 1 },
  ...(createdByUid ? { createdByUid } : {}),
});
/** A day upkeep generated (Admin SDK): no sourceType, no creator. */
const generatedDay = (templateId: string, day: string, extra: Record<string, unknown> = {}) => ({
  task: 'Dishes', assignedToUid: users.member.uid, dueDate: `${day}T06:00:00.000Z`, originalDueDate: day,
  isCompleted: false, notes: '', subTasks: [], completedSubTasks: [], roomIds: [], templateId,
  occurrenceKey: `${templateId}|general|${day}`, ...extra,
});
const oneTime = (createdByUid: string, extra: Record<string, unknown> = {}) => ({
  task: 'Fix the gate', assignedToUid: createdByUid, dueDate: '2026-11-27T18:00:00.000Z', originalDueDate: '2026-11-27',
  isCompleted: false, notes: '', completedSubTasks: [], roomIds: [], sourceType: 'temporary', createdByUid, ...extra,
});

before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync(process.env.HOMEHUB_FIRESTORE_RULES ?? 'firestore.rules', 'utf8') },
  });
});

beforeEach(async () => {
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'households', HOUSE), { name: 'Creators', ownerUid: users.owner.uid, memberEmails: [] });
    const roles: [Identity, string, Record<string, boolean>?][] = [
      [users.owner, 'owner'], [users.member, 'member'], [users.other, 'member'], [users.kid, 'child'],
      // A member whose role was narrowed: may create, not edit.
      [users.noEdit, 'member', { 'chores.edit': false }],
    ];
    for (const [user, role, permissions] of roles) {
      await setDoc(doc(db, 'households', HOUSE, 'members', user.uid), {
        uid: user.uid, role, status: 'active', displayName: user.uid, ...(permissions ? { permissions } : {}),
      });
    }
  });
});

after(async () => {
  await environment?.cleanup();
});

describe('createdByUid on chores and library chores (CH-24)', () => {
  test('is optional, and when written it is the writer', async () => {
    await assertSucceeds(setDoc(templateRef(users.member, 'legacy-shape'), template()));
    await assertSucceeds(setDoc(templateRef(users.member, 'mine'), template(users.member.uid)));
    await assertFails(setDoc(templateRef(users.member, 'forged'), template(users.other.uid)));
    await assertSucceeds(setDoc(choreRef(users.member, 'one'), oneTime(users.member.uid)));
    await assertFails(setDoc(choreRef(users.member, 'forged-one'), oneTime(users.member.uid, { createdByUid: users.other.uid })));
  });

  test('is never changed, added or removed afterwards, even by the owner', async () => {
    await seed(['chore-templates', 'dishes'], template(users.member.uid));
    await seed(['chore-templates', 'old'], template());
    await assertFails(updateDoc(templateRef(users.owner, 'dishes'), { createdByUid: users.owner.uid }));
    await assertFails(updateDoc(templateRef(users.owner, 'dishes'), { createdByUid: deleteField() }));
    await assertFails(updateDoc(templateRef(users.member, 'old'), { createdByUid: users.member.uid }));
    await assertSucceeds(updateDoc(templateRef(users.owner, 'dishes'), { task: 'Dishes and pans' }));
    await seed(['chores', 'one'], oneTime(users.member.uid));
    await assertFails(updateDoc(choreRef(users.owner, 'one'), { createdByUid: users.owner.uid }));
  });
});

describe('creators manage their own chores without chores.delete (CH-24)', () => {
  test('stop the repeat and remove its open days in one batch; completed days stay', async () => {
    await seed(['chore-templates', 'dishes'], template(users.noEdit.uid));
    await seed(['chores', 'd1'], generatedDay('dishes', '2026-11-28'));
    await seed(['chores', 'd2'], generatedDay('dishes', '2026-11-29'));
    await seed(['chores', 'done'], generatedDay('dishes', '2026-11-26', { isCompleted: true, completedAt: '2026-11-26T10:00:00.000Z', completedByUid: users.member.uid }));
    const db = dbFor(users.noEdit);
    const batch = writeBatch(db);
    batch.update(doc(db, 'households', HOUSE, 'chore-templates', 'dishes'), { recurrence: null, assignedToUid: null });
    batch.delete(doc(db, 'households', HOUSE, 'chores', 'd1'));
    batch.delete(doc(db, 'households', HOUSE, 'chores', 'd2'));
    await assertSucceeds(batch.commit());
    await assertFails(deleteDoc(choreRef(users.noEdit, 'done')));
    // chores.delete still removes anything.
    await assertSucceeds(deleteDoc(choreRef(users.owner, 'done')));
  });

  test('delete their own library chore and their own open one-time chore', async () => {
    await seed(['chore-templates', 'mine'], template(users.member.uid));
    await seed(['chores', 'gate'], oneTime(users.member.uid));
    await seed(['chores', 'gate-done'], oneTime(users.member.uid, { isCompleted: true, completedAt: '2026-11-27T10:00:00.000Z' }));
    await assertSucceeds(deleteDoc(choreRef(users.member, 'gate')));
    await assertFails(deleteDoc(choreRef(users.member, 'gate-done')));
    await assertSucceeds(deleteDoc(templateRef(users.member, 'mine')));
  });

  test("someone else's, older (no creator) and one-time library assignments are not theirs", async () => {
    await seed(['chore-templates', 'theirs'], template(users.other.uid));
    await seed(['chore-templates', 'old'], template());
    await seed(['chores', 't1'], generatedDay('theirs', '2026-11-28'));
    await seed(['chores', 'o1'], generatedDay('old', '2026-11-28'));
    await seed(['chores', 'gate'], oneTime(users.other.uid));
    await seed(['chore-templates', 'mine'], template(users.member.uid));
    // A one-time assignment of my library chore made by someone else (sourceType 'template').
    await seed(['chores', 'assigned'], { ...generatedDay('mine', '2026-11-28'), sourceType: 'template', createdByUid: users.other.uid });
    for (const id of ['t1', 'o1', 'gate', 'assigned']) await assertFails(deleteDoc(choreRef(users.member, id)));
    await assertFails(deleteDoc(templateRef(users.member, 'theirs')));
    await assertFails(deleteDoc(templateRef(users.member, 'old')));
    await assertFails(updateDoc(templateRef(users.noEdit, 'theirs'), { task: 'Renamed' }));
  });

  test('a kid (no chores.create) gets no creator rights, even on a document naming them', async () => {
    await seed(['chore-templates', 'kids'], template(users.kid.uid));
    await seed(['chores', 'k1'], generatedDay('kids', '2026-11-28'));
    await seed(['chores', 'kgate'], oneTime(users.kid.uid));
    await assertFails(deleteDoc(choreRef(users.kid, 'k1')));
    await assertFails(deleteDoc(choreRef(users.kid, 'kgate')));
    await assertFails(deleteDoc(templateRef(users.kid, 'kids')));
    await assertFails(updateDoc(templateRef(users.kid, 'kids'), { recurrence: null }));
  });

  test("a creator still needs chores.assign to give their library chore to someone else", async () => {
    await seed(['chore-templates', 'mine'], template(users.noEdit.uid));
    await environment.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'households', HOUSE, 'members', users.noEdit.uid), { permissions: { 'chores.edit': false, 'chores.assign': false } });
    });
    await assertFails(updateDoc(templateRef(users.noEdit, 'mine'), { assignedToUid: users.other.uid }));
    await assertSucceeds(updateDoc(templateRef(users.noEdit, 'mine'), { assignedToUid: users.noEdit.uid }));
  });
});
