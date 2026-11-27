import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isGeneratedInstance, roomDeletionPlan, skipsForDeletion } from '../../src/lib/chores/recurrence-edits';
import { MAX_SKIPPED_OCCURRENCES, occurrenceKeyDay, skippedOccurrenceKeys, withSkippedOccurrences } from '../../functions/src/shared/skips';
import { occurrenceChoreId } from '../../functions/src/shared/ids';
import { plannedRecurringEvents } from '../../src/lib/chores/calendar';

const generated = (templateId: string, roomId: string, day: string, extra: Record<string, unknown> = {}) => ({
  id: occurrenceChoreId(templateId, roomId, day), templateId, roomIds: roomId === 'general' ? [] : [roomId],
  occurrenceKey: `${templateId}|${roomId}|${day}`, isCompleted: false, ...extra,
});

describe('skipped occurrences (CH-3)', () => {
  test('keys name their day; the stored list is read defensively', () => {
    assert.equal(occurrenceKeyDay('trash|general|2026-08-02'), '2026-08-02');
    assert.equal(occurrenceKeyDay('nonsense'), null);
    assert.deepEqual([...skippedOccurrenceKeys({ skippedOccurrences: ['a|b|2026-08-02', 3, null] })], ['a|b|2026-08-02']);
    assert.equal(skippedOccurrenceKeys({ skippedOccurrences: 'x' }).size, 0);
    assert.equal(skippedOccurrenceKeys(undefined).size, 0);
  });

  test('adding keys drops past days and duplicates, sorts by day and caps the list', () => {
    const next = withSkippedOccurrences(['t|general|2026-07-30', 't|general|2026-08-05'], ['t|general|2026-08-03', 't|general|2026-08-05'], '2026-08-01');
    assert.deepEqual(next, ['t|general|2026-08-03', 't|general|2026-08-05']);
    const many = Array.from({ length: MAX_SKIPPED_OCCURRENCES + 10 }, (_, i) => `t|r${i}|2026-09-01`);
    assert.equal(withSkippedOccurrences([], many, '2026-08-01').length, MAX_SKIPPED_OCCURRENCES);
  });

  test('deleting chores skips only generated days from today on, per template', () => {
    const chores = [
      generated('trash', 'general', '2026-08-03'),
      generated('trash', 'kitchen', '2026-07-30'), // past: upkeep never regenerates it
      { id: 'one-time', templateId: 'trash', sourceType: 'template', roomIds: [], isCompleted: false }, // a library assignment
      { id: 'temp', sourceType: 'temporary', roomIds: [] },
      generated('dishes', 'kitchen', '2026-08-01'),
    ];
    const plan = skipsForDeletion(chores, '2026-08-01');
    assert.deepEqual(Object.fromEntries(plan), { trash: ['trash|general|2026-08-03'], dishes: ['dishes|kitchen|2026-08-01'] });
  });

  test('a skipped day is never planned on the calendar (CA-5)', () => {
    const members = [{ uid: 'sam', name: 'Sam', email: 'sam@example.test' }] as never;
    const template = { id: 'trash', task: 'Trash', roomIds: [], assignedToUid: 'sam', recurrence: { frequency: 'daily', interval: 1 } } as never;
    const before = plannedRecurringEvents([template], [], members, '2026-08-01', '2026-08-01', '2026-08-03');
    assert.deepEqual(before.map(e => e.day), ['2026-08-01', '2026-08-02', '2026-08-03']);
    const skipped = { ...(template as object), skippedOccurrences: ['trash|general|2026-08-02'] } as never;
    assert.deepEqual(plannedRecurringEvents([skipped], [], members, '2026-08-01', '2026-08-01', '2026-08-03').map(e => e.day), ['2026-08-01', '2026-08-03']);
  });
});

describe('repeat edits (CH-4)', () => {
  test('only chores without a source type that carry an occurrence are a series\' generated days', () => {
    assert.equal(isGeneratedInstance(generated('trash', 'general', '2026-08-03')), true);
    assert.equal(isGeneratedInstance({ ...generated('trash', 'kitchen', '2026-08-03'), occurrenceKey: undefined }), true, 'an older generated id');
    assert.equal(isGeneratedInstance({ ...generated('trash', 'general', '2026-08-03'), sourceType: null }), true);
    assert.equal(isGeneratedInstance({ id: 'x1', templateId: 'trash', sourceType: 'template' }), false);
    assert.equal(isGeneratedInstance({ id: 'legacy-random-id', templateId: 'trash', roomIds: [] }), false, 'an older one-time assignment');
    assert.equal(isGeneratedInstance({ id: 't', sourceType: 'temporary' }), false);
    assert.equal(isGeneratedInstance({ id: 'y' }), false);
  });

  test('deleting a room removes its open generated days and keeps everything else without the room', () => {
    const chores = [
      generated('trash', 'garage', '2026-08-03'),
      generated('trash', 'garage', '2026-08-01', { isCompleted: true }),
      { id: 'one-time', sourceType: 'temporary', roomIds: ['garage', 'kitchen'], isCompleted: false },
      generated('dishes', 'kitchen', '2026-08-01'),
    ];
    const plan = roomDeletionPlan(chores, 'garage');
    assert.deepEqual(plan.remove, [occurrenceChoreId('trash', 'garage', '2026-08-03')]);
    assert.deepEqual(plan.detach, [
      { id: occurrenceChoreId('trash', 'garage', '2026-08-01'), roomIds: [] },
      { id: 'one-time', roomIds: ['kitchen'] },
    ]);
  });
});
