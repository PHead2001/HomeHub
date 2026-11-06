import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { ChoreRecord } from '../../src/lib/chores/dates';
import { restoreChoreFields, completionFields } from '../../src/lib/chores/patch';
import { msUntilNextMidnight } from '../../src/lib/chores/dates';
import { choreCapabilities, collapseMissedRecurring, confettiCount, isToDoClear, openSubTasks, uniqueTemplateId } from '../../src/lib/chores/list';
import { getRolePresetPermissions } from '../../src/lib/permissions';

const chore = (overrides: Partial<ChoreRecord>): ChoreRecord => ({
  id: overrides.id || 'c',
  task: 'Reset the kitchen',
  assignedToEmail: 'alex@example.test',
  dueDate: '2026-08-01',
  originalDueDate: '2026-08-01',
  isCompleted: false,
  ...overrides,
});

describe('collapseMissedRecurring', () => {
  const recurring = new Set(['kitchen', 'laundry']);

  it('keeps only the latest instance of a recurring series and folds older ones', () => {
    const entries = collapseMissedRecurring([
      chore({ id: 'jul30', templateId: 'kitchen', roomIds: ['kitchen'], originalDueDate: '2026-07-30' }),
      chore({ id: 'aug1', templateId: 'kitchen', roomIds: ['kitchen'], originalDueDate: '2026-08-01' }),
      chore({ id: 'jul31', templateId: 'kitchen', roomIds: ['kitchen'], originalDueDate: '2026-07-31' }),
      chore({ id: 'laundry', templateId: 'laundry', originalDueDate: '2026-07-29' }),
    ], recurring);
    assert.deepEqual(entries.map(e => e.chore.id), ['laundry', 'aug1']);
    assert.deepEqual(entries[1].missed.map(c => c.id), ['jul30', 'jul31']);
  });

  it('never folds one-time library assignments', () => {
    // Assigned once on two dates from a library chore that does not repeat.
    const notRepeating = collapseMissedRecurring([
      chore({ id: 'a', templateId: 'filter', originalDueDate: '2026-07-30' }),
      chore({ id: 'b', templateId: 'filter', originalDueDate: '2026-07-31' }),
    ], new Set());
    assert.deepEqual(notRepeating.map(e => [e.chore.id, e.missed.length]), [['a', 0], ['b', 0]]);
    // New one-time assignments are marked sourceType 'template' and stay separate even if the template repeats.
    const marked = collapseMissedRecurring([
      chore({ id: 'a', templateId: 'kitchen', sourceType: 'template', originalDueDate: '2026-07-30' }),
      chore({ id: 'b', templateId: 'kitchen', sourceType: 'template', originalDueDate: '2026-07-31' }),
    ], recurring);
    assert.equal(marked.length, 2);
    assert.ok(marked.every(e => e.missed.length === 0));
  });

  it('does not count a same-day instance as missed', () => {
    const entries = collapseMissedRecurring([
      chore({ id: 'seeded', templateId: 'kitchen', roomIds: ['kitchen'], originalDueDate: '2026-08-01' }),
      chore({ id: 'generated', templateId: 'kitchen', roomIds: ['kitchen'], originalDueDate: '2026-08-01' }),
      chore({ id: 'older', templateId: 'kitchen', roomIds: ['kitchen'], originalDueDate: '2026-07-31' }),
    ], recurring);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map(e => e.missed.map(c => c.id)), [['older'], []]);
  });

  it('never collapses temporary chores, other rooms or other assignees', () => {
    const entries = collapseMissedRecurring([
      chore({ id: 't1', sourceType: 'temporary', originalDueDate: '2026-07-30' }),
      chore({ id: 't2', sourceType: 'temporary', originalDueDate: '2026-07-31' }),
      chore({ id: 'k1', templateId: 'k', roomIds: ['kitchen'], originalDueDate: '2026-07-30' }),
      chore({ id: 'k2', templateId: 'k', roomIds: ['garage'], originalDueDate: '2026-07-31' }),
      chore({ id: 'k3', templateId: 'k', roomIds: ['kitchen'], assignedToEmail: 'sam@example.test', originalDueDate: '2026-07-31' }),
    ], new Set(['k']));
    assert.equal(entries.length, 5);
    assert.ok(entries.every(e => e.missed.length === 0));
  });
});

describe('chore list helpers', () => {
  it('knows when everything due today is done', () => {
    assert.equal(isToDoClear([chore({ originalDueDate: '2026-08-02' })], '2026-08-01'), true);
    assert.equal(isToDoClear([chore({ originalDueDate: '2026-07-31' })], '2026-08-01'), false);
    assert.equal(isToDoClear([chore({ originalDueDate: '2026-08-01', isCompleted: true })], '2026-08-01'), true);
  });

  it('lists open sub-tasks and scales confetti with effort', () => {
    assert.deepEqual(openSubTasks({ subTasks: ['a', 'b', 'c'], completedSubTasks: ['b'] }), ['a', 'c']);
    assert.ok(confettiCount({ subTasks: ['a', 'b', 'c'] }) > confettiCount({}));
    assert.ok(confettiCount({ subTasks: Array.from({ length: 20 }, (_, i) => String(i)) }) <= 40);
  });

  it('picks a free template id', () => {
    assert.equal(uniqueTemplateId('trash', new Set()), 'trash');
    assert.equal(uniqueTemplateId('trash', new Set(['trash', 'trash-2'])), 'trash-3');
    assert.equal(uniqueTemplateId('', new Set()), 'chore');
  });
});

describe('chore capabilities follow the role presets', () => {
  const none = { canComplete: false, canCreate: false, canEdit: false, canDelete: false, canAssign: false };
  it('children complete only; members do not delete; guests only view', () => {
    assert.deepEqual(choreCapabilities(getRolePresetPermissions('child')), { ...none, canComplete: true });
    const member = choreCapabilities(getRolePresetPermissions('member'));
    assert.equal(member.canCreate && member.canEdit && member.canComplete && member.canAssign, true);
    assert.equal(member.canDelete, false);
    assert.deepEqual(choreCapabilities(getRolePresetPermissions('guest')), none);
    assert.equal(choreCapabilities(getRolePresetPermissions('owner')).canDelete, true);
    assert.deepEqual(choreCapabilities(null), none);
  });
});

describe('chore UI source checks', () => {
  const files = [
    'src/components/chore-chart-client.tsx',
    'src/components/chores/chore-list.tsx',
    'src/components/chores/chore-dialogs.tsx',
    'src/components/chores/chore-leaderboard.tsx',
    'src/components/chores/completion-check.tsx',
    'src/components/chores/confetti.tsx',
    'src/components/chores/house-clean-moment.tsx',
    'src/components/chores/calendar/household-calendar.tsx',
  ];

  it('uses design tokens only (no raw hex or rgb colors)', () => {
    for (const file of files) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, `${file} uses a raw hex color`);
      assert.doesNotMatch(source, /rgba?\(/, `${file} uses a raw rgb color`);
    }
  });

  it('completes chores only through the server-stamped helper', () => {
    for (const file of files) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      assert.doesNotMatch(source, /isCompleted:\s*true/, `${file}: complete chores with completionUpdate()`);
    }
  });

  it('shows field problems inline, not as toasts', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/chores/chore-dialogs.tsx'), 'utf8');
    assert.doesNotMatch(source, /toast\(/, 'chore dialogs must use FieldError for validation');
  });
});

describe('targeted rollback and day rollover', () => {
  it('restores only the failed chores and keeps changes made meanwhile', () => {
    const first = chore({ id: 'first' });
    const saved = new Map([['first', completionFields(first)]]);
    // Both chores were completed optimistically; the second write succeeded.
    const current = [
      { ...first, isCompleted: true, completedAt: '2026-08-01T12:00:00.000Z' },
      chore({ id: 'second', isCompleted: true, completedAt: '2026-08-01T12:00:05.000Z' }),
    ];
    const restored = restoreChoreFields(current, saved);
    assert.equal(restored[0].isCompleted, false);
    assert.equal(restored[0].completedAt, undefined);
    assert.equal(restored[1].isCompleted, true);
    assert.equal(restored[1], current[1]);
  });

  it('waits until the next local midnight', () => {
    assert.equal(msUntilNextMidnight(new Date(2026, 7, 1, 23, 59, 0)), 60_000);
    assert.equal(msUntilNextMidnight(new Date(2026, 7, 31, 12, 0, 0)), 12 * 60 * 60 * 1000);
    assert.ok(msUntilNextMidnight(new Date(2026, 7, 1, 23, 59, 59, 999)) >= 1000);
  });
});
