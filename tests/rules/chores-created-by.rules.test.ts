import { after, before, describe, test } from 'node:test';
import { assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteField, doc, setDoc, updateDoc } from 'firebase/firestore';
import { choreRulesEnvironment, choreUsers as users, firestoreAs } from './chore-rules-env';

// CH-20: createdByUid on chores is the writer, set only on create, never changed or removed.
const HOUSE = 'chores-created-by-house';
let environment: RulesTestEnvironment;
before(async () => { environment = await choreRulesEnvironment(HOUSE); });
after(async () => { await environment?.cleanup(); });

const chore = (user: typeof users.owner, id: string) => doc(firestoreAs(environment, user), 'households', HOUSE, 'chores', id);
const oneTime = (assignee: string, createdByUid?: string) => ({
  task: 'Tidy', assignedToUid: assignee, dueDate: '2026-08-05', originalDueDate: '2026-08-05', isCompleted: false, sourceType: 'temporary',
  ...(createdByUid !== undefined ? { createdByUid } : {}),
});

describe('chores: who added a one-time chore (CH-20)', () => {
  test('the creator is the writer, or absent (older clients)', async () => {
    await assertSucceeds(setDoc(chore(users.member, 'mine'), oneTime(users.member.uid, users.member.uid)));
    await assertSucceeds(setDoc(chore(users.member, 'older'), oneTime(users.member.uid)));
    // Pretending someone else made it (so it would earn points) is refused.
    await assertFails(setDoc(chore(users.member, 'forged'), oneTime(users.member.uid, users.owner.uid)));
  });

  test('it is never changed or removed afterwards, even by an editor', async () => {
    await assertSucceeds(setDoc(chore(users.member, 'fixed'), oneTime(users.member.uid, users.member.uid)));
    await assertFails(updateDoc(chore(users.member, 'fixed'), { createdByUid: users.owner.uid }));
    await assertFails(updateDoc(chore(users.owner, 'fixed'), { createdByUid: users.owner.uid }));
    await assertFails(updateDoc(chore(users.owner, 'fixed'), { createdByUid: deleteField() }));
    await assertFails(updateDoc(chore(users.member, 'older'), { createdByUid: users.owner.uid }));
    await assertSucceeds(updateDoc(chore(users.owner, 'fixed'), { task: 'Tidy up' }));
  });
});
