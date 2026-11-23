/**
 * The press-and-hold state machine behind holding the Feed button (Feed
 * earlier, `src/lib/pets/feed-press.ts`, with its own duration). It was first
 * written for hold to feed on the pet photo (H09), which is gone (Android
 * Chrome answers a long press on an image with its copy menu). Pure (time is
 * passed in), so it is unit tested.
 *
 *   idle --press--> holding --tick (elapsed >= HOLD_MS)--> complete
 *                     |  release / cancel (pointer cancel, moving, Escape)
 *                     v
 *                   idle
 *
 * `complete` is reached exactly once per press; only a new press (after the
 * pointer comes up) can start another hold, so one hold acts once.
 */

/** The default hold duration (ms); Feed earlier passes its own (`FEED_PRESS_MS`). */
export const HOLD_MS = 800;

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

/** True when `next` is the transition that completes the hold (fires once). */
export function holdJustCompleted(previous: HoldState, next: HoldState): boolean {
  return previous.phase === 'holding' && next.phase === 'complete';
}
