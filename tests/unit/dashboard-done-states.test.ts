import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { reconcileDoneStates, type DoneTracking } from '../../src/lib/dashboard/done-states';

type S = 'saving' | 'done' | 'failed';
const start = (states: Record<string, S>): DoneTracking<S> => ({ states, gone: new Set() });

describe('dashboard Done states follow the live chore list (review finding on #138)', () => {
  test('a done chore still in the list (server change not arrived) stays done', () => {
    const next = reconcileDoneStates(start({ a: 'done' }), ['a', 'b'], 'done');
    assert.equal(next.states.a, 'done');
    assert.equal(next.gone.size, 0);
  });

  test('a done chore that left and then reappears (reopened elsewhere) gets its button back', () => {
    let t = reconcileDoneStates(start({ a: 'done' }), ['b'], 'done');
    assert.equal(t.states.a, 'done');
    assert.ok(t.gone.has('a'));
    t = reconcileDoneStates(t, ['a', 'b'], 'done');
    assert.equal(t.states.a, undefined);
    assert.equal(t.gone.has('a'), false);
  });

  test('saving and failed states are left alone, and nothing changes without a reopen', () => {
    const tracking = start({ a: 'saving', b: 'failed' });
    assert.equal(reconcileDoneStates(tracking, ['a', 'b'], 'done'), tracking);
    const left = reconcileDoneStates(tracking, [], 'done');
    assert.deepEqual(left.states, { a: 'saving', b: 'failed' });
  });

  test('an Undo that cleared the state forgets the chore', () => {
    let t = reconcileDoneStates(start({ a: 'done' }), [], 'done');
    t = reconcileDoneStates({ states: {}, gone: t.gone }, ['a'], 'done');
    assert.deepEqual(t.states, {});
    assert.equal(t.gone.size, 0);
  });
});
