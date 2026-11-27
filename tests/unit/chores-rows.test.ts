import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { ROW_CHECK, focusCandidates, nextFocusIndex, pickFocusTarget, sameRowEntry } from '../../src/lib/chores/row-focus';
import { keepUnchangedRows } from '../../src/lib/chores/live';
import type { ChoreRecord } from '../../src/lib/chores/dates';

const chore = (id: string, fields: Partial<ChoreRecord> = {}) => ({ id, task: id, dueDate: '', originalDueDate: '2026-11-27', isCompleted: false, ...fields } as ChoreRecord);
const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

describe('chore rows: focus after completing (CH-16)', () => {
  it('moves to the next row, else the one before, else nowhere', () => {
    assert.equal(nextFocusIndex(3, 0), 1);
    assert.equal(nextFocusIndex(3, 2), 1);
    assert.equal(nextFocusIndex(1, 0), -1);
    assert.equal(nextFocusIndex(3, -1), -1);
  });
});

describe('chore rows: focus targets (CH-16, review of PR #262)', () => {
  const el = (attributes: Record<string, string>) => ({
    name: attributes.name,
    hasAttribute: (key: string) => key in attributes,
    getAttribute: (key: string) => attributes[key] ?? null,
  });

  it('only a row\'s own done check is a candidate, never a step checkbox of the chore being completed', () => {
    // Row A (being completed) with an open step in its details, then row B.
    const doneA = el({ name: 'done A', 'data-chore-row-check': '', 'aria-checked': 'false' });
    const stepA = el({ name: 'step A', 'aria-checked': 'false', role: 'checkbox' });
    const doneB = el({ name: 'done B', 'data-chore-row-check': '', 'aria-checked': 'false' });
    const candidates = focusCandidates([doneA, stepA, doneB]);
    assert.deepEqual(candidates.map(c => c.name), ['done A', 'done B']);
    assert.equal(candidates[nextFocusIndex(candidates.length, candidates.indexOf(doneA))].name, 'done B');
  });

  it('never picks another copy of the chore being completed (a chore in several rooms)', () => {
    // Kitchen group: dishes, wipe (in Kitchen and Living Room); Living Room group: wipe, dust.
    const rows = [
      { item: 'kitchen/dishes', choreId: 'dishes' },
      { item: 'kitchen/wipe', choreId: 'wipe' },
      { item: 'living/wipe', choreId: 'wipe' },
      { item: 'living/dust', choreId: 'dust' },
    ];
    assert.equal(pickFocusTarget(rows, 'kitchen/wipe'), 'living/dust');
    assert.equal(pickFocusTarget(rows, 'living/wipe'), 'living/dust');
    // Last open chore with copies before it: the one before that is not a copy.
    assert.equal(pickFocusTarget([{ item: 'a', choreId: 'x' }, { item: 'b', choreId: 'y' }, { item: 'c', choreId: 'y' }], 'c'), 'a');
    // Only copies of itself left: nothing to focus.
    assert.equal(pickFocusTarget([{ item: 'a', choreId: 'y' }, { item: 'b', choreId: 'y' }], 'a'), null);
    assert.equal(pickFocusTarget(rows, 'missing'), null);
  });

  it('skips disabled (not due) and checked (completed) row checks', () => {
    const candidates = focusCandidates([
      el({ name: 'future', 'data-chore-row-check': '', disabled: '' }),
      el({ name: 'done', 'data-chore-row-check': '', 'aria-checked': 'true' }),
      el({ name: 'open', 'data-chore-row-check': '', 'aria-checked': 'false' }),
    ]);
    assert.deepEqual(candidates.map(c => c.name), ['open']);
  });

  it('queries the marked checks, which the rows set and the step boxes do not', () => {
    assert.equal(ROW_CHECK, '[data-chore-id] button[data-chore-row-check]');
    const check = read('src/components/chores/completion-check.tsx');
    assert.match(check, /data-chore-row-check=\{rowCheck \? '' : undefined\}/);
    const list = read('src/components/chores/chore-list.tsx');
    assert.match(list, /<CompletionCheck\s+ref=\{checkRef\}\s+rowCheck/);
  });
});

describe('room cards on a narrow phone (CH-13, review of PR #262)', () => {
  it('lets the always-visible assignee shrink before the chore name does', () => {
    const list = read('src/components/chores/chore-list.tsx');
    assert.match(list, /const assigneeBox = large \? 'min-w-0 shrink' : 'shrink-0';/);
    assert.match(list, /'min-w-0 max-w-\[5rem\] truncate text-sm font-medium text-foreground sm:max-w-\[10rem\] md:text-base'/);
    // Both the reassign menu and the read-only assignee use it; the avatar itself never shrinks.
    assert.equal((list.match(/assigneeBox\)\}/g) ?? []).length, 2);
    assert.match(list, /decorative className="shrink-0" \/>/);
  });
});

describe('chore rows: memoised (CH-26)', () => {
  it('treats an entry with the same chore and missed days as unchanged', () => {
    const a = chore('a');
    const m = chore('m');
    assert.equal(sameRowEntry({ chore: a, missed: [m] }, { chore: a, missed: [m] }), true);
    assert.equal(sameRowEntry({ chore: a, missed: [m] }, { chore: { ...a }, missed: [m] }), false);
    assert.equal(sameRowEntry({ chore: a, missed: [m] }, { chore: a, missed: [] }), false);
  });

  it('keeps the previous object for unchanged chores and the previous array when nothing changed', () => {
    const previous = [chore('a', { completedSubTasks: ['x'] }), chore('b')];
    const same = keepUnchangedRows([chore('a', { completedSubTasks: ['x'] }), chore('b')], previous);
    assert.equal(same, previous);
    const next = keepUnchangedRows([chore('a', { completedSubTasks: ['x'] }), chore('b', { isCompleted: true })], previous);
    assert.notEqual(next, previous);
    assert.equal(next[0], previous[0]);
    assert.notEqual(next[1], previous[1]);
    assert.equal(next[1].isCompleted, true);
  });

  it('notices a removed field and a reordered list', () => {
    const previous = [chore('a', { notes: 'n' }), chore('b')];
    const removed = keepUnchangedRows([chore('a'), chore('b')], previous);
    assert.notEqual(removed[0], previous[0]);
    const reordered = keepUnchangedRows([previous[1], previous[0]], previous);
    assert.notEqual(reordered, previous);
    assert.equal(reordered[0], previous[1]);
  });

  it('memoises rows, measures layout per group and shows one skeleton', () => {
    const list = read('src/components/chores/chore-list.tsx');
    assert.match(list, /const MemoRow = memo\(ChoreRow/);
    assert.match(list, /layoutDependency=\{props\.layoutKey\}/);
    const page = read('src/components/chore-chart-client.tsx');
    assert.match(page, /return frame\(<ChoresSkeleton inPage \/>\)/);
    assert.match(read('src/app/chores/loading.tsx'), /<ChoresSkeleton \/>/);
  });
});

describe('chore rows: targets (CH-16)', () => {
  it('puts delete behind a menu, makes the select cell and each step row a label, and the ring % 12 px', () => {
    const list = read('src/components/chores/chore-list.tsx');
    assert.match(list, /aria-label=\{`More actions for \$\{chore\.task\}`\}/);
    assert.doesNotMatch(list, /aria-label=\{`Delete \$\{chore\.task\}`\}/);
    assert.match(list, /<label className=\{cn\('grid h-\[var\(--target-min\)\] w-\[var\(--target-min\)\]/);
    assert.match(list, /<label htmlFor=\{id\} className=\{cn\('flex min-h-\[var\(--target-min\)\] w-full/);
    const board = read('src/components/chores/chore-leaderboard.tsx');
    assert.doesNotMatch(board, /text-\[10px\]/);
  });
});
