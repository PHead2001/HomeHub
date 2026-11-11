import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  CHORE_UNDO_MS, completerLabel, completionEligibility, householdDueDay, planCompletion, planReopen, planUndo,
} from '../../src/lib/chores/completion';
import { computeChoreStats, creditedUid, statsMemberFrom } from '../../src/lib/chores/stats';
import { approvedPeople } from '../../src/lib/member-directory';
import { streakMembersFrom } from '../../src/lib/dashboard/streaks';
import { occurrences, plannedRecurringEvents } from '../../src/lib/chores/calendar';
import type { ChoreRecord } from '../../src/lib/chores/dates';
import { choreOccurrenceKey, choreStatsAssigneeKey, recurringChoreId, storedOccurrenceKey } from '../../functions/src/shared/ids';
import { addPurgedChores, readChoreStats } from '../../functions/src/shared/chore-stats';
import { occurrenceKeyDecision, storedOccurrenceKey as opsStoredOccurrenceKey } from '../../scripts/ops/occurrence-key.mjs';

const ZONE = 'America/Chicago';
// 23:30 Thu Nov 5 in Chicago (already Nov 6 in UTC), and 00:30 Fri Nov 6.
const BEFORE_MIDNIGHT = new Date('2026-11-06T05:30:00Z');
const AFTER_MIDNIGHT = new Date('2026-11-06T06:30:00Z');
const completer = { uid: 'u-sam', email: 'sam@example.test', name: 'Sam' };

describe('completion eligibility (CH-2)', () => {
  it('uses the household day, not UTC or the device', () => {
    const friday = { originalDueDate: '2026-11-06', dueDate: '2026-11-06T06:00:00.000Z' };
    assert.equal(completionEligibility(friday, BEFORE_MIDNIGHT, ZONE), 'early');
    assert.equal(completionEligibility(friday, AFTER_MIDNIGHT, ZONE), 'ok');
    // In UTC the same instant is already Friday.
    assert.equal(completionEligibility(friday, BEFORE_MIDNIGHT, 'UTC'), 'ok');
  });

  it('allows today, overdue and undated chores', () => {
    assert.equal(completionEligibility({ originalDueDate: '2026-11-05' }, BEFORE_MIDNIGHT, ZONE), 'ok');
    assert.equal(completionEligibility({ originalDueDate: '2026-10-01' }, BEFORE_MIDNIGHT, ZONE), 'ok');
    assert.equal(completionEligibility({}, BEFORE_MIDNIGHT, ZONE), 'ok');
  });

  it('reads an ISO due date in the household zone when there is no day', () => {
    assert.equal(householdDueDay({ dueDate: '2026-11-06T03:00:00.000Z' }, ZONE), '2026-11-05');
    assert.equal(householdDueDay({ dueDate: '2026-11-06' }, ZONE), '2026-11-06');
    assert.equal(householdDueDay({ dueDate: 'not a date' }, ZONE), null);
  });
});

describe('completion planning', () => {
  const base = { isCompleted: false, originalDueDate: '2026-11-05', subTasks: ['Rinse', 'Dry'], completedSubTasks: ['Rinse'] };
  const options = { completer, now: AFTER_MIDNIGHT, timeZone: ZONE, completeSubTasks: true, completionId: 'c-1' };

  it('records the completer and ticks open steps', () => {
    const plan = planCompletion(base, options);
    assert.equal(plan.kind, 'complete');
    if (plan.kind !== 'complete') return;
    assert.deepEqual(plan.fields, {
      isCompleted: true, completedAt: AFTER_MIDNIGHT.toISOString(), completedByUid: 'u-sam', completedByEmail: 'sam@example.test',
      completedByName: 'Sam', completionId: 'c-1', completedSubTasks: ['Rinse', 'Dry'],
    });
    assert.deepEqual(plan.previousCompletedSubTasks, ['Rinse']);
  });

  it('leaves steps alone when asked or when none are open', () => {
    const plan = planCompletion(base, { ...options, completeSubTasks: false });
    assert.ok(plan.kind === 'complete' && plan.fields.completedSubTasks === undefined && plan.previousCompletedSubTasks === null);
    const allDone = planCompletion({ ...base, completedSubTasks: ['Rinse', 'Dry'] }, options);
    assert.ok(allDone.kind === 'complete' && allDone.previousCompletedSubTasks === null);
  });

  it('is idempotent and says who did it', () => {
    const plan = planCompletion({ ...base, isCompleted: true, completedByName: 'Alex', completedByEmail: 'alex@example.test', completionId: 'c-0' }, options);
    assert.equal(plan.kind, 'already');
    assert.ok(plan.kind === 'already' && plan.completion.completedByName === 'Alex' && plan.completion.completionId === 'c-0');
  });

  it('refuses a chore due after today', () => {
    assert.deepEqual(planCompletion({ ...base, originalDueDate: '2026-11-07' }, options), { kind: 'early', dueDay: '2026-11-07' });
  });
});

describe('undo and reopen planning', () => {
  const done = { isCompleted: true, completionId: 'c-1', subTasks: ['Rinse', 'Dry'], completedSubTasks: ['Rinse', 'Dry'] };
  const restore = { from: ['Rinse', 'Dry'], to: ['Rinse'] };

  it('undoes only the named completion', () => {
    assert.deepEqual(planUndo(done, 'c-1', restore), { kind: 'undo', completedSubTasks: ['Rinse'] });
    assert.deepEqual(planUndo(done, 'c-2', restore), { kind: 'noop', reason: 'stale' });
    assert.deepEqual(planUndo({ ...done, isCompleted: false }, 'c-1', restore), { kind: 'noop', reason: 'open' });
    assert.deepEqual(planUndo({ ...done, completionId: undefined }, 'c-1'), { kind: 'noop', reason: 'stale' });
  });

  it('restores steps only when unchanged since the completion, and only real steps', () => {
    assert.deepEqual(planUndo({ ...done, completedSubTasks: ['Dry'] }, 'c-1', restore), { kind: 'undo', completedSubTasks: null });
    assert.deepEqual(planUndo(done, 'c-1', null), { kind: 'undo', completedSubTasks: null });
    assert.deepEqual(planUndo(done, 'c-1', { from: ['Rinse', 'Dry'], to: ['Rinse', 'Gone'] }), { kind: 'undo', completedSubTasks: ['Rinse'] });
  });

  it('reopens only completed chores', () => {
    assert.deepEqual(planReopen(done), { kind: 'reopen' });
    assert.deepEqual(planReopen({ isCompleted: false }), { kind: 'noop' });
  });

  it('keeps a 10 s Undo', () => {
    assert.equal(CHORE_UNDO_MS, 10_000);
  });
});

describe('the completer gets the points (CH-12, D-7)', () => {
  const members = [
    { email: 'alex@example.test', uid: 'u-alex', name: 'Alex' },
    { email: 'sam@example.test', uid: 'u-sam', name: 'Sam' },
  ];
  const now = new Date(2026, 10, 5, 20, 0, 0);
  const chore = (overrides: Partial<ChoreRecord>): ChoreRecord => ({
    id: 'c', task: 'Dishes', assignedToEmail: 'alex@example.test', dueDate: '2026-11-05', originalDueDate: '2026-11-05',
    isCompleted: true, completedAt: new Date(2026, 10, 5, 12).toISOString(), ...overrides,
  });

  it('credits the completer, else the assignee', () => {
    assert.equal(creditedUid(chore({ completedByEmail: 'sam@example.test' }), members), 'u-sam');
    assert.equal(creditedUid(chore({ completedByUid: 'u-sam', completedByEmail: 'old@example.test' }), members), 'u-sam');
    assert.equal(creditedUid(chore({}), members), 'u-alex');
    // The assignee is resolved by uid when the chore carries no email (HO-9).
    assert.equal(creditedUid(chore({ assignedToEmail: '', assignedToUid: 'u-sam' }), members), 'u-sam');
    // A completer who is no longer a member is not credited, nor is the assignee.
    assert.equal(creditedUid(chore({ completedByUid: 'u-gone', completedByEmail: 'gone@example.test' }), members), null);
    const stats = computeChoreStats([chore({ completedByEmail: 'sam@example.test', completedByUid: 'u-sam' })], members, now);
    const sam = stats.members.find(m => m.uid === 'u-sam')!;
    const alex = stats.members.find(m => m.uid === 'u-alex')!;
    assert.equal(sam.weekPoints, 15);
    assert.equal(sam.streak, 1);
    assert.equal(alex.weekPoints, 0);
    assert.equal(alex.weekAssigned, 1, 'fair share still counts the assignment');
  });

  it('credits an older completedByEmail-only completion the same on the Chores page and the dashboard', () => {
    const records = [
      { uid: 'u-alex', email: 'alex@example.test', displayName: 'Alex', role: 'owner', status: 'active' },
      { uid: 'u-sam', email: 'sam@example.test', displayName: 'Sam', role: 'member', status: 'active' },
    ];
    // Chores page: approved people from the member records, then statsMemberFrom.
    const choresPage = approvedPeople(records.map(data => ({ id: data.uid, data }))).map(statsMemberFrom);
    const dashboard = streakMembersFrom(records);
    assert.deepEqual(choresPage, dashboard);
    // No completedByUid: the completer's email is the only link to Sam.
    const older = chore({ completedByEmail: 'SAM@example.test' });
    assert.equal(creditedUid(older, choresPage), 'u-sam');
    const pageStats = computeChoreStats([older], choresPage, now);
    const dashStats = computeChoreStats([older], dashboard, now);
    assert.deepEqual(pageStats, dashStats);
    const sam = pageStats.members.find(m => m.uid === 'u-sam')!;
    assert.equal(sam.weekPoints, 15);
    assert.equal(sam.stickers, 1);
    assert.equal(sam.streak, 1);
    // The email is a matching key only: it never reaches the stats output or a name.
    assert.ok(!JSON.stringify(pageStats).includes('@'));
  });

  it('labels who did it', () => {
    assert.equal(completerLabel({ completedByName: 'Sam', completedByUid: 'u-sam' }), 'Sam');
    assert.equal(completerLabel({ completedByName: 'Sam', completedByUid: 'u-sam' }, uid => (uid === 'u-sam' ? 'Sammy' : undefined)), 'Sammy');
    assert.equal(completerLabel({}), null);
    // Never an email (HO-9): a stored email-like name is not shown.
    assert.equal(completerLabel({ completedByName: 'sam@example.test' }), null);
  });

  it('yearly stats credit the completer too', () => {
    const next = addPurgedChores(readChoreStats(undefined, 2026), [
      { assignedToEmail: 'alex@example.test', assignedToDisplayName: 'Alex', completedByEmail: 'sam@example.test', completedByName: 'Sam', completedAt: '2026-08-01T12:00:00.000Z' },
      { assignedToEmail: 'alex@example.test', assignedToDisplayName: 'Alex', completedAt: '2026-08-01T12:00:00.000Z' },
    ]);
    assert.equal(next.byAssignee[choreStatsAssigneeKey('sam@example.test')], 1);
    assert.equal(next.byAssignee[choreStatsAssigneeKey('alex@example.test')], 1);
    assert.equal(next.names[choreStatsAssigneeKey('sam@example.test')], 'Sam');
  });
});

describe('occurrence identity (CH-3)', () => {
  it('builds the key from template, room and day, ignoring the assignee', () => {
    assert.equal(choreOccurrenceKey('trash', 'general', '2026-11-05'), 'trash|general|2026-11-05');
    assert.deepEqual(occurrences({ id: 'trash', roomIds: ['kitchen'] }, '2026-11-05', 'sam@example.test'), [
      { id: recurringChoreId('trash', 'kitchen', '2026-11-05', 'sam@example.test'), key: 'trash|kitchen|2026-11-05' },
    ]);
  });

  it('reads a stored key, or recovers it from a generated id (even after a move)', () => {
    assert.equal(storedOccurrenceKey('x', { occurrenceKey: 'a|b|2026-01-01' }), 'a|b|2026-01-01');
    const id = recurringChoreId('Take out trash', 'kitchen', '2026-11-05', 'alex@example.test');
    assert.equal(storedOccurrenceKey(id, { templateId: 'Take out trash', roomIds: ['kitchen'] }), 'Take out trash|kitchen|2026-11-05');
    const general = recurringChoreId('trash', 'general', '2026-11-05', 'alex@example.test');
    assert.equal(storedOccurrenceKey(general, { templateId: 'trash', roomIds: [] }), 'trash|general|2026-11-05');
    // One-time chores and auto ids have none.
    assert.equal(storedOccurrenceKey(general, { templateId: 'trash', roomIds: [], sourceType: 'template' }), null);
    assert.equal(storedOccurrenceKey('AbCdEf123', { templateId: 'trash', roomIds: [] }), null);
    assert.equal(storedOccurrenceKey(general, {}), null);
  });

  it('the calendar never plans a day whose chore was reassigned', () => {
    const template = { id: 'trash', task: 'Trash', roomIds: [], assignedToEmail: 'sam@example.test', recurrence: { frequency: 'daily' as const, interval: 1 } };
    const members = [{ email: 'sam@example.test', uid: 'u-sam', name: 'Sam' }];
    const alexDone: ChoreRecord = {
      id: recurringChoreId('trash', 'general', '2026-11-05', 'alex@example.test'), task: 'Trash', assignedToEmail: 'alex@example.test',
      dueDate: '2026-11-05', originalDueDate: '2026-11-05', isCompleted: true, templateId: 'trash', roomIds: [],
      occurrenceKey: 'trash|general|2026-11-05',
    };
    const events = plannedRecurringEvents([template], [alexDone], members, '2026-11-05', '2026-11-05', '2026-11-06');
    assert.deepEqual(events.map(event => event.day), ['2026-11-06']);
  });

  it('upkeep writes and checks the key', () => {
    const source = readFileSync(resolve(process.cwd(), 'functions/src/reminders.ts'), 'utf8');
    assert.match(source, /choreOccurrenceKey\(templateDoc\.id, roomId, day\)/);
    assert.match(source, /occurrenceKeys\.has\(occurrenceKey\)/);
    assert.match(source, /where\("occurrenceKey", "in"/);
  });
});

describe('every completion entry point uses the server', () => {
  it('the Chores page completes, undoes and reopens through complete-client', () => {
    const page = readFileSync(resolve(process.cwd(), 'src/components/chore-chart-client.tsx'), 'utf8');
    assert.match(page, /from '@\/lib\/chores\/complete-client'/);
    for (const call of ['completeChoresOnServer(', 'undoCompletionOnServer(', 'reopenChoreOnServer(']) {
      assert.ok(page.includes(call), `uses ${call}`);
    }
    assert.doesNotMatch(page, /completedAtServer: deleteField\(\)|completionUpdate\(/);
  });

  it('offline completion is refused, not queued', () => {
    const client = readFileSync(resolve(process.cwd(), 'src/lib/chores/complete-client.ts'), 'utf8');
    assert.match(client, /"You're offline\. Not completed\."/);
    assert.match(client, /navigator\.onLine === false/);
  });
});

describe('occurrence key backfill (scripts/ops)', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    [recurringChoreId('trash', 'kitchen', '2026-11-05', 'a@example.test'), { templateId: 'trash', roomIds: ['kitchen'], originalDueDate: '2026-11-07' }],
    [recurringChoreId('Take Out Trash', 'general', '2026-11-05', 'a@example.test'), { templateId: 'Take Out Trash', roomIds: [], originalDueDate: '2026-11-05' }],
    ['auto-id-123', { templateId: 'trash', roomIds: [], originalDueDate: '2026-11-05' }],
    ['one-time', { templateId: 'trash', sourceType: 'template', originalDueDate: '2026-11-05' }],
    ['keyed', { occurrenceKey: 'x|y|2026-01-01' }],
    ['plain', { task: 'No template' }],
  ];

  it('agrees with the TypeScript rule case by case', () => {
    for (const [id, chore] of cases) assert.equal(opsStoredOccurrenceKey(id, chore), storedOccurrenceKey(id, chore), id);
  });

  it('writes only missing keys of generated chores, from the id day', () => {
    assert.deepEqual(occurrenceKeyDecision(cases[0][0], cases[0][1]), { kind: 'write', occurrenceKey: 'trash|kitchen|2026-11-05' });
    assert.deepEqual(occurrenceKeyDecision(cases[2][0], cases[2][1]), { kind: 'unrecognized' });
    assert.deepEqual(occurrenceKeyDecision(cases[3][0], cases[3][1]), { kind: 'oneTime' });
    assert.deepEqual(occurrenceKeyDecision(cases[4][0], cases[4][1]), { kind: 'present' });
    assert.deepEqual(occurrenceKeyDecision(cases[5][0], cases[5][1]), { kind: 'oneTime' });
  });
});

describe('one actionable row per chore', () => {
  it('a row leaving To Do (exit slide) is hidden and inert while the chore shows in Completed', () => {
    const list = readFileSync(resolve(process.cwd(), 'src/components/chores/chore-list.tsx'), 'utf8');
    assert.match(list, /const leaving = !useIsPresent\(\)/);
    assert.match(list, /aria-hidden=\{leaving \|\| undefined\}/);
    // Through the shared helper, which sets the attribute under React 18 and 19 (tests/unit/inert.test.ts).
    assert.match(list, /\{\.\.\.inertProps\(leaving\)\}/);
  });
});
