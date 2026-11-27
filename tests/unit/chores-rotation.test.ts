import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeRecurrence, upcomingOccurrences } from '../../functions/src/shared/recurrence';
import { MAX_ROTATION, occurrenceNumber, rotationAnchor, rotationOf, rotationTurn, ROTATION_EPOCH } from '../../functions/src/shared/rotation';
import { moveRotationMember, rotationFieldsFor, rotationText, toggleRotationMember } from '../../src/lib/chores/rotation';
import { plannedRecurringEvents } from '../../src/lib/chores/calendar';

// CH-28: rotations. Mon/Wed/Fri trash, counted from Monday Aug 3, 2026.
const recurrence = normalizeRecurrence({ frequency: 'weekly', weeklyOptions: { daysOfWeek: [1, 3, 5] } }, '2026-08-03')!;
const rotation = ['a', 'b', 'c'];
const everyone = () => true;
const turnOn = (day: string, anchor = '2026-08-03') => rotationTurn(rotation, occurrenceNumber(recurrence, anchor, day), everyone);

describe('CH-28: rotation turns', () => {
  it('reads a rotation: unique uids, two or more, at most MAX_ROTATION', () => {
    assert.deepEqual(rotationOf({ rotation: ['a', ' b ', 'a', 3, ''] }), ['a', 'b']);
    assert.deepEqual(rotationOf({ rotation: ['a'] }), [], 'one person is no rotation');
    assert.equal(rotationOf({ rotation: Array.from({ length: 12 }, (_, i) => `u${i}`) }).length, MAX_ROTATION);
    assert.equal(rotationAnchor({}), ROTATION_EPOCH);
    assert.equal(rotationAnchor({ rotationStart: '2026-08-03' }), '2026-08-03');
  });

  it('gives occurrences in order from the start day', () => {
    assert.deepEqual(['2026-08-03', '2026-08-05', '2026-08-07', '2026-08-10', '2026-08-12'].map(day => turnOn(day)), ['a', 'b', 'c', 'a', 'b']);
  });

  it('is the same whichever day upkeep runs (stable across runs)', () => {
    const fromMonday = upcomingOccurrences(recurrence, '2026-08-03', 10);
    const fromThursday = upcomingOccurrences(recurrence, '2026-08-06', 7);
    const turns = (days: string[]) => {
      const first = occurrenceNumber(recurrence, '2026-08-03', days[0]);
      return new Map(days.map((day, index) => [day, rotationTurn(rotation, first + index, everyone)]));
    };
    const a = turns(fromMonday);
    for (const [day, uid] of turns(fromThursday)) assert.equal(uid, a.get(day), day);
  });

  it('counts backwards before the start day', () => {
    assert.equal(occurrenceNumber(recurrence, '2026-08-03', '2026-07-31'), -1);
    assert.equal(turnOn('2026-07-31'), 'c');
  });

  it('passes the turn of someone who left (or a kid profile) to the next person, keeping everyone else\'s days', () => {
    const noB = (uid: string) => uid !== 'b';
    assert.equal(rotationTurn(rotation, 1, noB), 'c');
    assert.equal(rotationTurn(rotation, 0, noB), 'a');
    assert.equal(rotationTurn(rotation, 2, noB), 'c');
    assert.equal(rotationTurn(rotation, 0, () => false), null);
  });

  it('keeps rotationStart while the order is unchanged and restarts it on a new order', () => {
    const previous = { rotation: ['a', 'b'], rotationStart: '2026-08-03' };
    assert.deepEqual(rotationFieldsFor(previous, ['a', 'b'], '2026-08-20'), { rotation: ['a', 'b'], rotationStart: '2026-08-03' });
    assert.deepEqual(rotationFieldsFor(previous, ['b', 'a'], '2026-08-20'), { rotation: ['b', 'a'], rotationStart: '2026-08-20' });
    assert.equal(rotationFieldsFor(previous, ['a'], '2026-08-20'), null);
  });

  it('edits the list and describes it', () => {
    assert.deepEqual(toggleRotationMember(['a', 'b'], 'c'), ['a', 'b', 'c']);
    assert.deepEqual(toggleRotationMember(['a', 'b'], 'a'), ['b']);
    assert.deepEqual(moveRotationMember(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b']);
    assert.deepEqual(moveRotationMember(['a', 'b'], 0, -1), ['a', 'b']);
    assert.equal(rotationText(['a', 'b', 'c'], uid => uid.toUpperCase()), 'A, B and C take turns');
  });

  it('plans calendar days past the lookahead with the same person upkeep would pick', () => {
    const template = { id: 'trash', task: 'Trash', recurrence: { frequency: 'weekly', weeklyOptions: { daysOfWeek: [1, 3, 5] } }, rotation, rotationStart: '2026-08-03' };
    const members = [{ uid: 'a', name: 'A' }, { uid: 'b', name: 'B' }, { uid: 'c', name: 'C', kind: 'identity' }];
    const events = plannedRecurringEvents([template], [], members, '2026-08-03', '2026-08-03', '2026-08-12');
    // C is a kid profile (not assignable yet), so C's turns go to the next person.
    assert.deepEqual(events.map(event => [event.day, event.memberUid]), [
      ['2026-08-03', 'a'], ['2026-08-05', 'b'], ['2026-08-07', 'a'], ['2026-08-10', 'a'], ['2026-08-12', 'b'],
    ]);
  });
});
