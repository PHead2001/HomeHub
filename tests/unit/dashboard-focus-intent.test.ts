import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFocusIntent } from '../../src/lib/dashboard/focus-intent';

/** A field that can be mounted, focused and have focus taken away. */
function field() {
  const state = { mounted: false, focused: false, focusCalls: 0 };
  const focus = () => {
    state.focusCalls += 1;
    if (state.mounted) state.focused = true;
    return state.focused;
  };
  return { state, focus };
}

describe('createFocusIntent (H02 weather city field)', () => {
  it('without a request the menu returns focus to its trigger and the field is left alone', () => {
    const intent = createFocusIntent();
    const { state, focus } = field();
    state.mounted = true;
    intent.fieldReady(focus);
    assert.equal(state.focusCalls, 0);
    assert.equal(intent.menuClosed(focus), false);
    assert.equal(state.focusCalls, 0);
  });

  it('focuses the field on mount and keeps the request until the menu has closed', () => {
    const intent = createFocusIntent();
    const { state, focus } = field();
    intent.request();
    state.mounted = true;
    intent.fieldReady(focus);
    assert.equal(state.focused, true);
    assert.equal(intent.isPending(), true);
    assert.equal(intent.menuClosed(focus), true);
    assert.equal(intent.isPending(), false);
  });

  it('puts focus back in the field when the closing menu took it after the field was focused', () => {
    const intent = createFocusIntent();
    const { state, focus } = field();
    intent.request();
    state.mounted = true;
    intent.fieldReady(focus);
    // A pointer leaving the disabled item focuses the menu content.
    state.focused = false;
    intent.fieldBlurred(false);
    assert.equal(intent.isPending(), true);
    assert.equal(intent.menuClosed(focus), true);
    assert.equal(state.focused, true);
    assert.equal(intent.isPending(), false);
  });

  it('re-applies focus when the field re-mounts while the request is pending', () => {
    const intent = createFocusIntent();
    const { state, focus } = field();
    intent.request();
    state.mounted = true;
    intent.fieldReady(focus);
    state.mounted = false;
    state.focused = false;
    state.mounted = true;
    intent.fieldReady(focus);
    assert.equal(state.focused, true);
  });

  it('when the field shows only after the menu closed, the menu still leaves focus alone and the field takes it on mount', () => {
    const intent = createFocusIntent();
    const { state, focus } = field();
    intent.request();
    assert.equal(intent.menuClosed(focus), true);
    assert.equal(intent.isPending(), true);
    state.mounted = true;
    intent.fieldReady(focus);
    assert.equal(state.focused, true);
    assert.equal(intent.isPending(), false);
    // Settled: a later re-mount does not steal focus back.
    state.focused = false;
    intent.fieldReady(focus);
    assert.equal(state.focused, false);
  });

  it('ends when the member moves focus elsewhere, or when it is cancelled', () => {
    const moved = createFocusIntent();
    const a = field();
    moved.request();
    a.state.mounted = true;
    moved.fieldReady(a.focus);
    a.state.focused = false;
    moved.fieldBlurred(true);
    assert.equal(moved.isPending(), false);
    assert.equal(moved.menuClosed(a.focus), false);
    assert.equal(a.state.focused, false);

    const cancelled = createFocusIntent();
    const b = field();
    cancelled.request();
    cancelled.cancel();
    b.state.mounted = true;
    cancelled.fieldReady(b.focus);
    assert.equal(b.state.focusCalls, 0);
    assert.equal(cancelled.menuClosed(b.focus), false);
  });
});
