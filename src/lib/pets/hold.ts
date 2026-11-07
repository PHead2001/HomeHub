/**
 * Hold to feed (H09): the press-and-hold state machine behind the pet photo.
 * Pure (time is passed in), so it is unit tested.
 *
 *   idle --press--> holding --tick (elapsed >= HOLD_MS)--> complete
 *                     |  release / cancel (pointer cancel, leaving the photo, Escape)
 *                     v
 *                   idle   (nothing is logged)
 *
 * `complete` is reached exactly once per press; only a new press (after the
 * pointer comes up) can start another hold, so one hold logs one feeding.
 */

/** How long the photo must be held (ms). */
export const HOLD_MS = 800;
/**
 * A press released sooner than this is a tap (it opens the pet as before); a
 * longer press that is released or cancelled was a hold attempt, so its click is
 * swallowed. The ring appears only after this, so a tap never flashes it.
 */
export const HOLD_TAP_MS = 150;

export type HoldState =
  | { phase: 'idle' }
  | { phase: 'holding'; startedAt: number; progress: number }
  | { phase: 'complete' };

export type HoldEvent =
  | { type: 'press'; at: number }
  | { type: 'tick'; at: number }
  | { type: 'release' }
  | { type: 'cancel' };

export const HOLD_IDLE: HoldState = { phase: 'idle' };

/** Progress 0..1 for a hold that started at `startedAt`. */
export function holdProgress(startedAt: number, at: number, duration = HOLD_MS): number {
  if (duration <= 0) return 1;
  return Math.min(1, Math.max(0, (at - startedAt) / duration));
}

export function holdReducer(state: HoldState, event: HoldEvent, duration = HOLD_MS): HoldState {
  switch (event.type) {
    case 'press':
      // A press while holding (second finger) or after completing (before release) is ignored.
      return state.phase === 'idle' ? { phase: 'holding', startedAt: event.at, progress: 0 } : state;
    case 'tick': {
      if (state.phase !== 'holding') return state;
      const progress = holdProgress(state.startedAt, event.at, duration);
      return progress >= 1 ? { phase: 'complete' } : { ...state, progress };
    }
    case 'release':
    case 'cancel':
      return HOLD_IDLE;
    default:
      return state;
  }
}

/** True when `next` is the transition that should log the feeding (fires once). */
export function holdJustCompleted(previous: HoldState, next: HoldState): boolean {
  return previous.phase === 'holding' && next.phase === 'complete';
}


/** True once a hold has lasted past a tap: show the ring, and swallow the click on release. */
export function holdIsDeliberate(state: HoldState, duration = HOLD_MS): boolean {
  if (state.phase === 'complete') return true;
  return state.phase === 'holding' && state.progress * duration >= HOLD_TAP_MS;
}
