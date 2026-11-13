import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  completionEligibility, householdToday, isChoreDocId, isDueAfterHouseholdDay, MAX_DOC_ID_BYTES, msUntilHouseholdMidnight,
} from '../../src/lib/chores/completion';
import { applyRefreshedChores, applyUndoSettlement, settleUndo } from '../../src/lib/chores/patch';
import type { ChoreRecord } from '../../src/lib/chores/dates';
import { newChoreDocId } from '../../src/lib/chores/list';
import { summarizeChores } from '../../src/lib/dashboard/wrapped';
import { addPurgedChores, readChoreStats } from '../../functions/src/shared/chore-stats';
import { choreStatsMemberKey, recurringChoreId } from '../../functions/src/shared/ids';

describe('completion controls use the household day (browser vs household timezone)', () => {
  // 23:30 Thu Nov 5 in Los Angeles is already 01:30 Fri Nov 6 in Chicago.
  const now = new Date('2026-11-06T07:30:00Z');
  const friday = { originalDueDate: '2026-11-06', dueDate: '2026-11-06T06:00:00.000Z' };

  it('a Friday chore in a Chicago household is completable while it is still Thursday in Los Angeles', () => {
    assert.equal(householdToday(now, 'America/Chicago'), '2026-11-06');
    assert.equal(householdToday(now, 'America/Los_Angeles'), '2026-11-05');
    assert.equal(isDueAfterHouseholdDay(friday, householdToday(now, 'America/Chicago'), 'America/Chicago'), false);
    // The browser's (Los Angeles) day would have disabled it.
    assert.equal(isDueAfterHouseholdDay(friday, householdToday(now, 'America/Los_Angeles'), 'America/Chicago'), true);
  });

  it('agrees with the server eligibility for the same instant', () => {
    for (const zone of ['America/Chicago', 'America/Los_Angeles', 'Asia/Tokyo', 'UTC']) {
      const disabled = isDueAfterHouseholdDay(friday, householdToday(now, zone), zone);
      assert.equal(disabled, completionEligibility(friday, now, zone) === 'early', zone);
    }
  });

  it('reads a due instant in the household zone and treats an invalid zone as the default', () => {
    const instantOnly = { dueDate: '2026-11-06T05:30:00.000Z' }; // Nov 5, 23:30 in Chicago
    assert.equal(isDueAfterHouseholdDay(instantOnly, '2026-11-05', 'America/Chicago'), false);
    assert.equal(householdToday(now, 'Not/AZone'), householdToday(now, 'America/Chicago'));
    assert.equal(isDueAfterHouseholdDay({}, '2026-11-05', 'America/Chicago'), false);
  });

  it('rolls over at the household midnight', () => {
    const lateThursday = new Date('2026-11-06T05:30:00Z'); // 23:30 Chicago
    assert.equal(msUntilHouseholdMidnight(lateThursday, 'America/Chicago'), 30 * 60 * 1000);
    assert.ok(msUntilHouseholdMidnight(new Date('2026-11-06T05:59:59.900Z'), 'America/Chicago') >= 1000);
  });
});

describe('Home Wrapped credits retained completions like the stats (retention boundary)', () => {
  const completion = {
    id: 'c1', isCompleted: true, completedAt: '2026-03-01T10:00:00Z',
    assignedToUid: 'u-sam', assignedToDisplayName: 'Sam Member',
    completedByUid: 'u-alex', completedByName: 'Alex Helper',
  };

  it('credits the completer, before and after the chore moves into the stats', () => {
    const before = summarizeChores([completion], 2026, { timeZone: 'UTC' });
    assert.deepEqual(before.champion, { name: 'Alex', count: 1 });

    const stats = addPurgedChores(readChoreStats({}, 2026), [completion]);
    const after = summarizeChores([], 2026, { stats, timeZone: 'UTC' });
    assert.deepEqual(after.champion, before.champion);
    assert.equal(stats.byAssignee[choreStatsMemberKey('u-alex')], 1);
  });

  it('falls back to the assignee for completions without a recorded completer', () => {
    const legacy = { ...completion, completedByUid: undefined, completedByName: undefined };
    assert.deepEqual(summarizeChores([legacy], 2026, { timeZone: 'UTC' }).champion, { name: 'Sam', count: 1 });
  });
});

describe('Undo reconciliation (reopened or changed before Undo)', () => {
  const ok = (choreId: string, status: 'undone' | 'stale' | 'open' | 'missing', completedSubTasks?: string[]) =>
    ({ ok: true as const, data: { choreId, status, ...(completedSubTasks ? { completedSubTasks } : {}) } });

  it('keeps open chores open, re-reads changed ones and restores only requests that never ran', () => {
    const settled = settleUndo(
      ['a', 'b', 'c', 'd', 'e'],
      [ok('a', 'undone', ['step']), ok('b', 'open'), ok('c', 'stale'), ok('d', 'missing'), { ok: false }],
    );
    assert.deepEqual(settled.restore, ['e']);
    assert.deepEqual(settled.refresh, ['c', 'd']);
    assert.deepEqual([...settled.steps], [['a', ['step']]]);
  });

  it('applies the authoritative chore: completed by someone else, or deleted', () => {
    const local = [
      { id: 'c', task: 'Dishes', isCompleted: false, assignedToDisplayName: 'Sam' },
      { id: 'd', task: 'Bins', isCompleted: false },
      { id: 'x', task: 'Other', isCompleted: true, completionId: 'keep' },
    ] as unknown as ChoreRecord[];
    const fresh = new Map<string, Record<string, unknown> | null>([
      ['c', { task: 'Dishes', isCompleted: true, completionId: 'theirs', completedByEmail: 'alex@example.test' }],
      ['d', null],
    ]);
    const next = applyRefreshedChores(local, fresh);
    assert.deepEqual(next.map(chore => chore.id), ['c', 'x']);
    assert.equal(next[0].isCompleted, true);
    assert.equal(next[0].completionId, 'theirs');
    assert.equal(next[0].assignedToDisplayName, 'Sam');
    assert.equal(next[1], local[2]);
  });

  it('an undone chore shows the steps the server kept, not the optimistic all-ticked list', () => {
    // Completed with every step ticked; meanwhile someone else unticked "Rinse".
    // The server keeps that edit and returns the stored steps.
    const local = [
      { id: 'a', task: 'Dishes', isCompleted: false, subTasks: ['Rinse', 'Dry'], completedSubTasks: ['Rinse', 'Dry'] },
      { id: 'e', task: 'Bins', isCompleted: false, completedSubTasks: [] },
      { id: 'x', task: 'Other', isCompleted: true, completedSubTasks: ['Keep'] },
    ] as unknown as ChoreRecord[];
    const settled = settleUndo(['a', 'e'], [ok('a', 'undone', ['Dry']), { ok: false }]);
    const saved = new Map([['e', { isCompleted: true, completionId: 'mine', completedSubTasks: [] }]]);
    const next = applyUndoSettlement(local, settled, saved);
    assert.equal(next[0].isCompleted, false);
    assert.deepEqual(next[0].completedSubTasks, ['Dry']);
    assert.equal(next[1].isCompleted, true, 'a request that never ran puts its completion back');
    assert.equal(next[1].completionId, 'mine');
    assert.equal(next[2], local[2]);
    // An empty stored list is applied too (every step unticked since).
    const [cleared] = applyUndoSettlement(local.slice(0, 1), settleUndo(['a'], [ok('a', 'undone', [])]), new Map());
    assert.deepEqual(cleared.completedSubTasks, []);
  });

  it('drops local completion fields the stored chore no longer has', () => {
    const local = [{ id: 'c', task: 'Dishes', isCompleted: true, completionId: 'mine', completedByEmail: 'sam@example.test' }] as unknown as ChoreRecord[];
    const [chore] = applyRefreshedChores(local, new Map([['c', { task: 'Dishes', isCompleted: false }]]));
    assert.equal(chore.isCompleted, false);
    assert.equal(chore.completionId, undefined);
    assert.equal(chore.completedByEmail, undefined);
  });
});

describe('chore ID validation (long recurring IDs)', () => {
  it('accepts the longest IDs upkeep generates', () => {
    const template = newChoreDocId('x'.repeat(200), 'A'.repeat(20));
    const room = newChoreDocId('y'.repeat(200), 'B'.repeat(20));
    const id = recurringChoreId(template, room, '2026-11-06', `${'someone.with.a.long.name'.repeat(4)}@example.test`);
    assert.ok(id.length > 200, `expected over 200 characters, got ${id.length}`);
    assert.equal(isChoreDocId(id), true);
  });

  it('allows up to 1500 UTF-8 bytes and rejects what Firestore rejects', () => {
    assert.equal(isChoreDocId('a'.repeat(MAX_DOC_ID_BYTES)), true);
    assert.equal(isChoreDocId('a'.repeat(MAX_DOC_ID_BYTES + 1)), false);
    assert.equal(isChoreDocId('é'.repeat(751)), false); // 1502 bytes, 751 characters
    for (const bad of ['', '.', '..', 'a/b', '/', '__id__', '__x__', 42, null, undefined]) {
      assert.equal(isChoreDocId(bad), false, String(bad));
    }
    assert.equal(isChoreDocId('a.b'), true);
    assert.equal(isChoreDocId('__half'), true);
  });
});
