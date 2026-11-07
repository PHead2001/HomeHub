import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HOLD_IDLE, HOLD_MS, holdJustCompleted, holdProgress, holdReducer, type HoldEvent, type HoldState } from '../../src/lib/pets/hold';

const run = (events: HoldEvent[], start: HoldState = HOLD_IDLE) => {
  let state = start;
  let completions = 0;
  for (const event of events) {
    const next = holdReducer(state, event);
    if (holdJustCompleted(state, next)) completions += 1;
    state = next;
  }
  return { state, completions };
};

describe('hold to feed state machine', () => {
  it('holds for about 800 ms', () => assert.equal(HOLD_MS, 800));

  it('reports progress from 0 to 1', () => {
    assert.equal(holdProgress(100, 100), 0);
    assert.equal(holdProgress(100, 500), 0.5);
    assert.equal(holdProgress(100, 5000), 1);
    assert.equal(holdProgress(100, 50), 0);
  });

  it('completes exactly once for a full hold', () => {
    const { state, completions } = run([
      { type: 'press', at: 0 },
      { type: 'tick', at: 400 },
      { type: 'tick', at: 800 },
      { type: 'tick', at: 900 },
      { type: 'press', at: 950 },
    ]);
    assert.equal(state.phase, 'complete');
    assert.equal(completions, 1);
  });

  it('tracks progress while holding', () => {
    const { state } = run([{ type: 'press', at: 0 }, { type: 'tick', at: 200 }]);
    assert.deepEqual(state, { phase: 'holding', startedAt: 0, progress: 0.25 });
  });

  for (const ending of ['release', 'cancel'] as const) {
    it(`${ending} before the end cancels without completing`, () => {
      const { state, completions } = run([
        { type: 'press', at: 0 },
        { type: 'tick', at: 700 },
        { type: ending },
        { type: 'tick', at: 2000 },
      ]);
      assert.equal(state.phase, 'idle');
      assert.equal(completions, 0);
    });
  }

  it('a new press after release starts a fresh hold', () => {
    const { state, completions } = run([
      { type: 'press', at: 0 }, { type: 'tick', at: 800 }, { type: 'release' },
      { type: 'press', at: 1000 }, { type: 'tick', at: 1400 },
    ]);
    assert.equal(completions, 1);
    assert.deepEqual(state, { phase: 'holding', startedAt: 1000, progress: 0.5 });
  });

  it('ignores ticks while idle and a second press while holding', () => {
    assert.equal(holdReducer(HOLD_IDLE, { type: 'tick', at: 10 }), HOLD_IDLE);
    const holding: HoldState = { phase: 'holding', startedAt: 0, progress: 0 };
    assert.equal(holdReducer(holding, { type: 'press', at: 500 }), holding);
  });
});
