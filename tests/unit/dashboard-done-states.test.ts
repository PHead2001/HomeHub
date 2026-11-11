import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  emptyDoneTracking,
  reconcileDoneStates,
  setDoneState,
  settleDone,
  type DoneTracking,
} from '../../src/lib/dashboard/done-states';

type S = 'saving' | 'done' | 'failed';
const names = { saving: 'saving', done: 'done' } as const;
const start = (states: Record<string, S>): DoneTracking<S> => ({ states, gone: new Set(), returned: new Set() });
const reconcile = (tracking: DoneTracking<S>, live: string[]) => reconcileDoneStates(tracking, live, names);

describe('dashboard Done states follow the live chore list (review finding on #138)', () => {
  test('a done chore still in the list (server change not arrived) stays done', () => {
    const next = reconcile(start({ a: 'done' }), ['a', 'b']);
    assert.equal(next.states.a, 'done');
    assert.equal(next.gone.size, 0);
  });

  test('a done chore that left and then reappears (reopened elsewhere) gets its button back', () => {
    let t = reconcile(start({ a: 'done' }), ['b']);
    assert.equal(t.states.a, 'done');
    assert.ok(t.gone.has('a'));
    t = reconcile(t, ['a', 'b']);
    assert.equal(t.states.a, undefined);
    assert.equal(t.gone.has('a'), false);
  });

  test('failed states are left alone, and nothing changes without a departure', () => {
    const tracking = start({ a: 'saving', b: 'failed' });
    assert.equal(reconcile(tracking, ['a', 'b']), tracking);
    const left = reconcile(tracking, []);
    assert.deepEqual(left.states, { a: 'saving', b: 'failed' });
    assert.deepEqual([...left.gone], ['a'], 'a saving row that leaves is remembered; a failed one is not');
    assert.equal(reconcile(left, []), left, 'settles: same tracking back');
  });

  test('an Undo that cleared the state forgets the chore', () => {
    let t = reconcile(start({ a: 'done' }), []);
    t = setDoneState(t, 'a', null);
    t = reconcile(t, ['a']);
    assert.deepEqual(t.states, {});
    assert.equal(t.gone.size, 0);
  });
});

describe('dashboard Done: departures while the completion is still saving (review finding on #150)', () => {
  test('the usual order: the chore leaves before the answer, then is reopened elsewhere: its button works again', () => {
    let t = setDoneState(emptyDoneTracking<S>(), 'a', 'saving');
    t = reconcile(t, ['b']); // the server's change arrives first
    t = settleDone(t, 'a', names); // then the action's answer
    assert.equal(t.states.a, 'done');
    t = reconcile(t, ['a', 'b']); // reopened elsewhere
    assert.equal(t.states.a, undefined, 'not stuck as done');
  });

  test('left and came back before the answer: the answer does not mark it done', () => {
    let t = setDoneState(emptyDoneTracking<S>(), 'a', 'saving');
    t = reconcile(t, []);
    t = reconcile(t, ['a']);
    assert.equal(t.states.a, 'saving', 'still saving until the answer');
    assert.ok(t.returned.has('a'));
    assert.equal(reconcile(t, ['a']), t, 'settles');
    t = settleDone(t, 'a', names);
    assert.equal(t.states.a, undefined, 'the button works again');
    assert.equal(t.gone.size + t.returned.size, 0);
  });

  test('the answer arrives before the return is reconciled: the return still re-enables it', () => {
    let t = setDoneState(emptyDoneTracking<S>(), 'a', 'saving');
    t = reconcile(t, []);
    t = settleDone(t, 'a', names);
    t = reconcile(t, ['a']);
    assert.equal(t.states.a, undefined);
  });

  test('came back, then left again (completed elsewhere) before the answer: reads done until it returns', () => {
    let t = setDoneState(emptyDoneTracking<S>(), 'a', 'saving');
    t = reconcile(t, []);
    t = reconcile(t, ['a']);
    t = reconcile(t, []);
    assert.equal(t.returned.size, 0);
    t = settleDone(t, 'a', names);
    assert.equal(t.states.a, 'done');
    t = reconcile(t, ['a']);
    assert.equal(t.states.a, undefined);
  });

  test('an answer for a row no longer saving (Undo cleared it, or it failed) changes nothing', () => {
    const cleared = setDoneState(setDoneState(emptyDoneTracking<S>(), 'a', 'saving'), 'a', null);
    assert.equal(settleDone(cleared, 'a', names), cleared);
    const failed = setDoneState(emptyDoneTracking<S>(), 'a', 'failed');
    assert.equal(settleDone(failed, 'a', names), failed);
  });

  test('a new attempt (Retry) starts with no departure history', () => {
    let t = setDoneState(emptyDoneTracking<S>(), 'a', 'saving');
    t = reconcile(t, []);
    t = reconcile(t, ['a']);
    t = setDoneState(t, 'a', 'failed');
    t = setDoneState(t, 'a', 'saving');
    assert.equal(t.gone.size + t.returned.size, 0);
    t = settleDone(t, 'a', names);
    assert.equal(t.states.a, 'done');
  });
});
