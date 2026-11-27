import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { HISTORY_LIMIT, choreHistory, editableFields, validateDetailEdit } from '../../src/lib/chores/detail';
import type { ChoreRecord } from '../../src/lib/chores/dates';

const chore = (id: string, fields: Partial<ChoreRecord> = {}) => ({ id, task: id, dueDate: '', originalDueDate: '2026-11-27', isCompleted: false, ...fields } as ChoreRecord);
const done = (id: string, at: string, fields: Partial<ChoreRecord> = {}) => chore(id, { isCompleted: true, completedAt: at, ...fields });

describe('chore detail sheet (CH-15)', () => {
  it('lists this chore and the other days of its series, newest first, with who did them', () => {
    const current = chore('dishes|2026-11-27', { templateId: 'dishes' });
    const history = choreHistory(current, [
      current,
      done('dishes|2026-11-25', '2026-11-25T18:00:00.000Z', { templateId: 'dishes', completedByUid: 'u1' }),
      done('dishes|2026-11-26', '2026-11-26T18:00:00.000Z', { templateId: 'dishes', completedByName: 'Kid' }),
      done('laundry|2026-11-26', '2026-11-26T19:00:00.000Z', { templateId: 'laundry' }),
    ], uid => (uid === 'u1' ? 'Sam' : undefined));
    assert.deepEqual(history.map(entry => [entry.id, entry.by]), [['dishes|2026-11-26', 'Kid'], ['dishes|2026-11-25', 'Sam']]);
  });

  it('shows only the chore itself for a one-time chore, and at most the limit', () => {
    const own = done('one', '2026-11-27T08:00:00.000Z');
    assert.deepEqual(choreHistory(own, [own, done('other', '2026-11-27T09:00:00.000Z')], () => undefined).map(entry => entry.current), [true]);
    const many = Array.from({ length: 15 }, (_, index) => done(`t|${index}`, new Date(Date.UTC(2026, 10, index + 1)).toISOString(), { templateId: 't' }));
    assert.equal(choreHistory(chore('x', { templateId: 't' }), many, () => undefined).length, HISTORY_LIMIT);
  });

  it('lets the day change only for an open chore that is not a generated day of a repeat', () => {
    assert.deepEqual(editableFields(chore('a', { sourceType: 'temporary' })), { day: true });
    assert.deepEqual(editableFields(chore('a', { sourceType: 'temporary', isCompleted: true })), { day: false });
    assert.deepEqual(editableFields(chore('tpl|room|2026-11-27', { templateId: 'tpl', occurrenceKey: 'tpl|room|2026-11-27', roomIds: ['room'] })), { day: false });
  });

  it('validates like the rules', () => {
    assert.deepEqual(validateDetailEdit({ task: '  ', notes: '' }), { task: 'Name the chore.' });
    assert.deepEqual(validateDetailEdit({ task: 'x'.repeat(501), notes: '' }), { task: 'Use at most 500 characters.' });
    assert.deepEqual(validateDetailEdit({ task: 'ok', notes: '', dueDay: '' }), { dueDay: 'Pick a day.' });
    assert.deepEqual(validateDetailEdit({ task: 'ok', notes: '', dueDay: '2026-11-28' }), {});
  });

  it('opens from the name of every row', () => {
    const list = readFileSync(resolve(process.cwd(), 'src/components/chores/chore-list.tsx'), 'utf8');
    assert.match(list, /onClick=\{\(\) => handlers\.onOpenDetails\(chore\)\}/);
    assert.doesNotMatch(list, /hasDetails/);
  });
});
