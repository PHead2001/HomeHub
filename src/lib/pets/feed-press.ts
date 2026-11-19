/**
 * Press and hold Feed (owner request "Feed earlier"): the gesture on the Feed
 * button itself, on touch and pen. A quick tap still feeds now (the button's
 * own click); holding for `FEED_PRESS_MS` opens "When did <pet> eat?" instead.
 * Pure (time is passed in), so it is unit tested; the hook is
 * `useFeedPress` in src/components/pets/feed-press.tsx.
 *
 * It is the hold-to-feed machine (`holdReducer` in ./hold.ts) with a shorter
 * duration and a longer tap threshold:
 *
 *   idle --press--> holding --tick (elapsed >= FEED_PRESS_MS)--> complete (opens the dialog, once)
 *                     |  release / cancel (moved, scrolled, pointer cancel, Escape)
 *                     v
 *                   idle
 *
 * Released before `FEED_PRESS_TAP_MS` it was a tap: the click goes through and
 * feeds now, and no progress was ever shown. Released or cancelled later it
 * was a hold attempt: the click is swallowed, so a released hold never also
 * feeds. A completed hold never feeds either (it opened the dialog).
 */
import { holdJustCompleted, holdProgress, holdReducer, HOLD_IDLE, type HoldEvent, type HoldState } from './hold';

/** How long Feed must be held to open the earlier-time dialog (ms). */
export const FEED_PRESS_MS = 500;
/** A press released sooner is a tap (feeds now); the fill appears only after this. */
export const FEED_PRESS_TAP_MS = 200;
/** A finger that moves further than this (px) is scrolling or dragging: the press is cancelled. */
export const FEED_PRESS_MOVE_PX = 10;

export type FeedPressState = HoldState;
export type FeedPressEvent = HoldEvent;
export const FEED_PRESS_IDLE: FeedPressState = HOLD_IDLE;

export function feedPressReducer(state: FeedPressState, event: FeedPressEvent): FeedPressState {
  return holdReducer(state, event, FEED_PRESS_MS);
}

/** True on the one transition that opens the dialog. */
export const feedPressJustCompleted = holdJustCompleted;

/** The press lasted past a tap: show the fill, and swallow the click when it ends. */
export function feedPressIsDeliberate(state: FeedPressState): boolean {
  if (state.phase === 'complete') return true;
  return state.phase === 'holding' && state.progress * FEED_PRESS_MS >= FEED_PRESS_TAP_MS;
}

/** What letting go means: `tap` feeds now (the click goes through); `none` does nothing more. */
export function feedPressRelease(state: FeedPressState): 'tap' | 'none' {
  return state.phase === 'holding' && !feedPressIsDeliberate(state) ? 'tap' : 'none';
}

/** True when the pointer has moved far enough from where it went down to cancel. */
export function feedPressMoved(start: { x: number; y: number }, point: { x: number; y: number }): boolean {
  return Math.hypot(point.x - start.x, point.y - start.y) > FEED_PRESS_MOVE_PX;
}

export type FeedPressIndicator = {
  /** Something is drawn on the button (never for a tap). */
  shown: boolean;
  /** 0..1 of the button's width; sweeps from the tap threshold to the end. */
  fill: number;
  /** Reduced motion: a still outline instead of a sweep (the end state is still shown). */
  still: boolean;
};

/**
 * What the button shows while pressed. The fill starts at the tap threshold, so
 * a quick tap never flashes it. Under reduced motion nothing sweeps: a still
 * outline says the press is held, and the full state shows once complete.
 */
export function feedPressIndicator(state: FeedPressState, reducedMotion: boolean): FeedPressIndicator {
  if (!feedPressIsDeliberate(state)) return { shown: false, fill: 0, still: reducedMotion };
  if (state.phase === 'complete') return { shown: true, fill: 1, still: reducedMotion };
  const elapsed = state.phase === 'holding' ? state.progress * FEED_PRESS_MS : 0;
  const sweep = holdProgress(FEED_PRESS_TAP_MS, elapsed, FEED_PRESS_MS - FEED_PRESS_TAP_MS);
  return { shown: true, fill: reducedMotion ? 0 : sweep, still: reducedMotion };
}

/** True for a keyboard press that opens the dialog from the Feed button (Shift+Enter). */
export function opensEarlierFromKey(event: { key: string; shiftKey: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }): boolean {
  return event.key === 'Enter' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
}
