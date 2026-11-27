import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { WEEK_SNAPSHOT_KEEP_WEEKS, runHouseholdReminders } from '../../functions/src/reminders';
import { readWeekSummary } from '../../functions/src/shared/chore-points';

// CH-29: upkeep snapshots the closed week (points and payout) once into stats/.
const HOUSE = 'week-snapshot-house';
const ts = (d: Date) => Timestamp.fromDate(d) as never;
const run = (iso: string) => runHouseholdReminders(adminDb as never, HOUSE, new Date(iso), ts);
const house = () => adminDb.collection('households').doc(HOUSE);
const week = () => house().collection('stats').doc('week-2026-11-02');
const done = (id: string, uid: string, day: string, extra: Record<string, unknown> = {}) => house().collection('chores').doc(id).set({
  task: id, assignedToUid: uid, dueDate: day, originalDueDate: day, isCompleted: true,
  completedAt: `${day}T18:00:00.000Z`, completedByUid: uid, templateId: 'lib', sourceType: 'template', ...extra,
});

beforeEach(async () => {
  await adminDb.recursiveDelete(house());
  await house().set({ name: 'Snapshot', ownerUid: 'mom', timeZone: 'America/Chicago', memberEmails: [] });
  await house().collection('members').doc('mom').set({ uid: 'mom', role: 'owner', status: 'active', displayName: 'Mom' });
  await house().collection('members').doc('kid').set({ uid: 'kid', role: 'child', status: 'active', displayName: 'Kid' });
  await house().collection('chore-settings').doc('preferences').set({ leaderboardEnabled: true, centsPerPoint: 10 });
  // Week of Mon Nov 2 - Sun Nov 8, 2026.
  await done('k1', 'kid', '2026-11-03');
  await done('k2', 'kid', '2026-11-08');
  await done('m1', 'mom', '2026-11-04');
  // A one-time chore the kid added for themselves earns nothing (CH-20).
  await done('self', 'kid', '2026-11-05', { templateId: null, sourceType: 'temporary', createdByUid: 'kid' });
});

after(async () => {
  await adminDb.recursiveDelete(house());
});

describe('closed-week snapshot', () => {
  test('is not written before the week closes', async () => {
    await run('2026-11-08T20:00:00Z'); // Sunday 2pm Chicago
    assert.equal((await week().get()).exists, false);
  });

  test('is written once after the week closes, with points and payout at the rate then', async () => {
    await run('2026-11-09T15:00:00Z'); // Monday
    const summary = readWeekSummary((await week().get()).data());
    assert.ok(summary);
    assert.equal(summary.centsPerPoint, 10);
    assert.deepEqual(summary.members.map(m => [m.uid, m.points, m.completed, m.payoutCents, m.stickerMode]), [
      ['kid', 30, 3, 300, true],
      ['mom', 15, 1, 150, false],
    ]);
    // A new rate, a reopened chore and another run never change it.
    await house().collection('chore-settings').doc('preferences').set({ centsPerPoint: 50 }, { merge: true });
    await house().collection('chores').doc('k2').update({ isCompleted: false, completedAt: null, completedByUid: null });
    await run('2026-11-09T16:00:00Z');
    assert.deepEqual(readWeekSummary((await week().get()).data()), summary);
  });

  test('writes nothing for a week nobody earned points, or for a household being deleted', async () => {
    await run('2026-11-16T15:00:00Z'); // the week of Nov 9 had no completions
    assert.equal((await house().collection('stats').doc('week-2026-11-09').get()).exists, false);
    await house().update({ deletingAt: '2026-11-09T00:00:00Z' });
    await run('2026-11-09T15:00:00Z');
    assert.equal((await week().get()).exists, false);
  });

  test('keeps the last WEEK_SNAPSHOT_KEEP_WEEKS weeks and never touches yearly stats', async () => {
    await house().collection('stats').doc('week-2026-01-05').set({ kind: 'week', weekStart: '2026-01-05', weekEnd: '2026-01-11', centsPerPoint: 0, members: [] });
    await house().collection('stats').doc('chores-2026').set({ year: 2026, completed: 4, byAssignee: {}, names: {} });
    await run('2026-11-09T15:00:00Z');
    assert.ok(WEEK_SNAPSHOT_KEEP_WEEKS < 40);
    assert.equal((await house().collection('stats').doc('week-2026-01-05').get()).exists, false);
    assert.equal((await house().collection('stats').doc('chores-2026').get()).exists, true);
    assert.equal((await week().get()).exists, true);
  });
});
