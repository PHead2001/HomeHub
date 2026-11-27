import { after, before, describe, test } from 'node:test';
import { assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { choreRulesEnvironment, choreUsers as users, firestoreAs } from './chore-rules-env';

// CH-29: the allowance rate lives in chore-settings/preferences (owners and admins
// only, whole cents 0-100); week snapshots under stats/ are written only by upkeep.
const HOUSE = 'chores-allowance-house';
let environment: RulesTestEnvironment;
before(async () => { environment = await choreRulesEnvironment(HOUSE); });
after(async () => { await environment?.cleanup(); });

const prefs = (user: typeof users.owner) => doc(firestoreAs(environment, user), 'households', HOUSE, 'chore-settings', 'preferences');
const week = (user: typeof users.owner) => doc(firestoreAs(environment, user), 'households', HOUSE, 'stats', 'week-2026-08-03');

describe('chore preferences: allowance rate (CH-29)', () => {
  test('owners and admins set whole cents 0-100, merged with the leaderboard switch', async () => {
    await assertSucceeds(setDoc(prefs(users.owner), { centsPerPoint: 5, updatedAt: '2026-08-01T12:00:00.000Z' }, { merge: true }));
    await assertSucceeds(setDoc(prefs(users.admin), { leaderboardEnabled: false }, { merge: true }));
    await assertSucceeds(setDoc(prefs(users.owner), { centsPerPoint: 0 }, { merge: true }));
    await assertSucceeds(setDoc(prefs(users.owner), { centsPerPoint: 100 }, { merge: true }));
  });

  test('members and children cannot, and odd values are refused', async () => {
    await assertFails(setDoc(prefs(users.member), { centsPerPoint: 5 }, { merge: true }));
    await assertFails(setDoc(prefs(users.child), { centsPerPoint: 100 }, { merge: true }));
    for (const bad of [101, -1, 2.5, '5']) await assertFails(setDoc(prefs(users.owner), { centsPerPoint: bad }, { merge: true }));
    await assertFails(setDoc(prefs(users.owner), { leaderboardEnabled: 'yes' }, { merge: true }));
  });

  test('week snapshots are read-only for clients', async () => {
    await environment.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'households', HOUSE, 'stats', 'week-2026-08-03'), { kind: 'week', weekStart: '2026-08-03', weekEnd: '2026-08-09', centsPerPoint: 5, members: [] });
    });
    await assertSucceeds(getDoc(week(users.child)));
    await assertFails(setDoc(week(users.owner), { kind: 'week', weekStart: '2026-08-03', weekEnd: '2026-08-09', centsPerPoint: 100, members: [] }));
  });
});
