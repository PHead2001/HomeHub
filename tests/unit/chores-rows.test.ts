import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { nextFocusIndex, sameRowEntry } from '../../src/lib/chores/row-focus';
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
