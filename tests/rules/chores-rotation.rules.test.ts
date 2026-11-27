import { after, before, beforeEach, describe, test } from 'node:test';
import { assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteField, doc, setDoc, updateDoc } from 'firebase/firestore';
import { choreRulesEnvironment, choreUsers as users, firestoreAs } from './chore-rules-env';

// CH-28: a rotation names other people, so setting or changing one needs chores.assign.
const HOUSE = 'chores-rotation-house';
let environment: RulesTestEnvironment;
before(async () => { environment = await choreRulesEnvironment(HOUSE); });
after(async () => { await environment?.cleanup(); });

const template = (user: typeof users.owner, id = 'trash') => doc(firestoreAs(environment, user), 'households', HOUSE, 'chore-templates', id);
const recurrence = { frequency: 'weekly', weeklyOptions: { daysOfWeek: [1, 3, 5] } };

beforeEach(async () => {
  await environment.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'households', HOUSE, 'chore-templates', 'trash'), {
      task: 'Trash', notes: '', roomIds: [], subTasks: [], assignedToUid: users.noAssign.uid, recurrence,
    });
    await setDoc(doc(context.firestore(), 'households', HOUSE, 'chore-templates', 'rotating'), {
      task: 'Dishes', notes: '', roomIds: [], subTasks: [], assignedToUid: users.member.uid, recurrence,
      rotation: [users.member.uid, users.noAssign.uid], rotationStart: '2026-08-03',
    });
  });
});

describe('chore templates: rotations (CH-28)', () => {
  test('someone who may assign sets, reorders and removes a rotation', async () => {
    await assertSucceeds(updateDoc(template(users.owner), { rotation: [users.member.uid, users.child.uid, users.noAssign.uid], rotationStart: '2026-08-05', assignedToUid: users.member.uid }));
    await assertSucceeds(updateDoc(template(users.owner, 'rotating'), { rotation: [users.noAssign.uid, users.member.uid], rotationStart: '2026-08-06' }));
    await assertSucceeds(updateDoc(template(users.owner, 'rotating'), { rotation: deleteField(), rotationStart: deleteField() }));
  });

  test('without chores.assign a rotation cannot be set or changed, but can be removed', async () => {
    await assertFails(updateDoc(template(users.noAssign), { rotation: [users.noAssign.uid, users.member.uid], rotationStart: '2026-08-05' }));
    await assertFails(updateDoc(template(users.noAssign, 'rotating'), { rotation: [users.noAssign.uid, users.member.uid] }));
    // Editing the schedule keeps the rotation as it is.
    await assertSucceeds(updateDoc(template(users.noAssign, 'rotating'), { task: 'Dishes and pans' }));
    await assertSucceeds(updateDoc(template(users.noAssign, 'rotating'), { recurrence: null, rotation: deleteField(), rotationStart: deleteField() }));
  });

  test('a rotation is two to eight people and a day string', async () => {
    await assertFails(updateDoc(template(users.owner), { rotation: [users.member.uid] }));
    await assertFails(updateDoc(template(users.owner), { rotation: Array.from({ length: 9 }, (_, i) => `u${i}`) }));
    await assertFails(updateDoc(template(users.owner), { rotation: 'everyone' }));
    await assertFails(updateDoc(template(users.owner), { rotation: [users.member.uid, users.owner.uid], rotationStart: '2026-08-05T00:00:00.000Z' }));
    await assertFails(updateDoc(template(users.child), { rotation: [users.member.uid, users.owner.uid] }));
  });
});
