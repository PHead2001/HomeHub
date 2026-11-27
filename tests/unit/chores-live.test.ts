import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { choreLiveReducer, choreLiveStatus, initialChoreLiveState, mergeLiveRows, type ChoreLiveState } from '../../src/lib/chores/live';

const answer = (state: ChoreLiveState, collection: 'members' | 'chores' | 'chore-templates' | 'rooms', ids: string[], key = 'h1|u1', session = 1) =>
  choreLiveReducer(state, { type: 'answer', key, session, collection, docs: ids.map(id => ({ id, data: {} })) });

describe('chores live data (CH-1, CH-8)', () => {
  test('ready once every collection answered; a failure before that is the error state', () => {
    let state = initialChoreLiveState();
    state = answer(state, 'members', ['u1']);
    assert.equal(choreLiveStatus(state), 'loading');
    state = choreLiveReducer(state, { type: 'failure', key: 'h1|u1', session: 1, collection: 'chores', failure: 'retrying' });
    assert.equal(choreLiveStatus(state), 'error', 'never a false empty household');
    state = answer(state, 'chores', []);
    state = answer(state, 'chore-templates', []);
    assert.equal(choreLiveStatus(state), 'loading', 'the retry answered: loading the rest');
    state = answer(state, 'rooms', []);
    assert.equal(choreLiveStatus(state), 'ready');
    state = choreLiveReducer(state, { type: 'failure', key: 'h1|u1', session: 1, collection: 'chores', failure: 'retrying' });
    assert.equal(choreLiveStatus(state), 'ready', 'a later failure keeps what loaded');
  });

  test('another household or session starts over', () => {
    let state = answer(initialChoreLiveState(), 'chores', ['a']);
    state = answer(state, 'rooms', ['r'], 'h2|u1');
    assert.equal(state.key, 'h2|u1');
    assert.equal(state.docs.chores, null);
    assert.deepEqual(state.docs.rooms?.map(d => d.id), ['r']);
  });

  test('rows with a write in flight keep the page version until it settles', () => {
    const server = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 1 }];
    const local = [{ id: 'a', v: 9 }, { id: 'd', v: 9 }];
    assert.deepEqual(mergeLiveRows(server, local, new Set()), server);
    assert.deepEqual(mergeLiveRows(server, local, new Set(['a', 'b', 'd'])), [{ id: 'a', v: 9 }, { id: 'c', v: 1 }, { id: 'd', v: 9 }],
      'a keeps the optimistic version; b was removed locally and stays hidden; d is kept until its write settles');
  });
});
