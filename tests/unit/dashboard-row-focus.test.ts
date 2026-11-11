import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { actionAfterLeave, focusCandidates, nextActionKey, rowFocusStep, type RowFocusFrame } from '../../src/lib/dashboard/row-focus';

describe('dashboard one-tap focus: which control next', () => {
  test('the next action in the tile first, then the previous one', () => {
    assert.deepEqual(focusCandidates(['a', 'b', 'c'], 'b'), ['c', 'a']);
    assert.deepEqual(focusCandidates(['a', 'b', 'c'], 'a'), ['b']);
    assert.deepEqual(focusCandidates(['a', 'b', 'c'], 'c'), ['b']);
    assert.equal(nextActionKey(['a', 'b', 'c'], 'b'), 'c');
    assert.equal(nextActionKey(['a', 'b', 'c'], 'c'), 'b');
  });

  test('the only action (or one not on screen) leaves the tile link next', () => {
    assert.deepEqual(focusCandidates(['a'], 'a'), []);
    assert.deepEqual(focusCandidates(['a', 'b'], 'x'), []);
    assert.equal(nextActionKey(['a'], 'a'), null);
    assert.equal(nextActionKey([], 'a'), null);
  });
});

describe('dashboard one-tap focus: the action once the row has left', () => {
  test('a candidate still in the tile, the next before the previous', () => {
    assert.equal(actionAfterLeave(['c', 'a'], 1, ['a', 'c']), 'c');
    // The next one left too (or is saving): the previous one.
    assert.equal(actionAfterLeave(['c', 'a'], 1, ['a']), 'a');
  });

  test('beside the house (first row only): the row that moved into its place', () => {
    assert.equal(actionAfterLeave([], 0, ['b']), 'b');
    assert.equal(actionAfterLeave(['b'], 0, ['d']), 'd');
  });

  test('the last of several gone: the one before its place', () => {
    assert.equal(actionAfterLeave([], 2, ['a', 'b']), 'b');
  });

  test('nothing left, or the control was never listed: the tile link', () => {
    assert.equal(actionAfterLeave([], 0, []), null);
    assert.equal(actionAfterLeave([], -1, ['a']), null);
  });
});

describe('dashboard one-tap focus: each frame after the press', () => {
  const frame = (overrides: Partial<RowFocusFrame>): RowFocusFrame => ({
    connected: true, disabled: true, focusLost: true, wasDisabled: true, expired: false, ...overrides,
  });

  test('waits while the control is saving or done and still listed', () => {
    assert.equal(rowFocusStep(frame({})), 'wait');
    assert.equal(rowFocusStep(frame({ wasDisabled: false })), 'wait');
  });

  test('moves focus once the control has left and focus fell to the page', () => {
    assert.equal(rowFocusStep(frame({ connected: false })), 'move');
    // Even after the wait: the row may leave late, and focus is still nowhere.
    assert.equal(rowFocusStep(frame({ connected: false, expired: true })), 'move');
  });

  test('never moves focus the member has moved elsewhere', () => {
    assert.equal(rowFocusStep(frame({ connected: false, focusLost: false })), 'stop');
    assert.equal(rowFocusStep(frame({ disabled: false, focusLost: false })), 'wait');
  });

  test('back onto the control when it returns from saving (failed, refused, or still needed)', () => {
    assert.equal(rowFocusStep(frame({ disabled: false })), 'refocus');
    // Not disabled at any point: focus on the body was the member's doing.
    assert.equal(rowFocusStep(frame({ disabled: false, wasDisabled: false })), 'wait');
  });

  test('stops when the wait is over and the control is still there', () => {
    assert.equal(rowFocusStep(frame({ expired: true })), 'stop');
    assert.equal(rowFocusStep(frame({ expired: true, disabled: false })), 'stop');
  });
});
