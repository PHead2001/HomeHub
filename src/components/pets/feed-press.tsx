'use client';

import * as React from 'react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { canVibrate, getFeedbackSettings } from '@/lib/feedback';
import {
  FEED_PRESS_IDLE,
  feedPressIndicator,
  feedPressIsDeliberate,
  feedPressJustCompleted,
  feedPressMoved,
  feedPressReducer,
  opensEarlierFromKey,
  type FeedPressEvent,
  type FeedPressState,
} from '@/lib/pets/feed-press';
import { cn } from '@/lib/utils';

/** A contextmenu event this soon after a completed hold belongs to that hold (Android fires one on long press). */
const CONTEXTMENU_AFTER_HOLD_MS = 1500;

/**
 * Press and hold Feed (touch and pen) to choose an earlier time, plus the
 * desktop and keyboard ways in: right-click (contextmenu) and Shift+Enter on
 * the button. The state machine is `src/lib/pets/feed-press.ts`; the hold
 * mechanics are those of hold to feed on the photo (`useHoldToFeed`): a move
 * (more than 10 px), a scroll (pointer cancel) or Escape cancels, `onHold` runs
 * once per press, a quick tap never shows progress and its click goes through
 * (feeds now), and the click after a hold attempt is swallowed (a released hold
 * never also feeds). A mouse press is always a plain click.
 */
export function useFeedPress({ enabled, onHold }: { enabled: boolean; onHold: () => void }) {
  const [press, setPress] = React.useState<FeedPressState>(FEED_PRESS_IDLE);
  const machine = React.useRef<FeedPressState>(FEED_PRESS_IDLE);
  const pointer = React.useRef<{ id: number; x: number; y: number } | null>(null);
  const swallowClick = React.useRef(false);
  const heldAt = React.useRef(0);
  const onHoldRef = React.useRef(onHold);
  React.useEffect(() => { onHoldRef.current = onHold; });

  const send = React.useCallback((event: FeedPressEvent) => {
    const previous = machine.current;
    const next = feedPressReducer(previous, event);
    if (next === previous) return;
    machine.current = next;
    setPress(next);
    if (feedPressJustCompleted(previous, next)) {
      swallowClick.current = true;
      heldAt.current = Date.now();
      try {
        // A short tick where the member allows haptics and the device can vibrate.
        if (getFeedbackSettings().haptics && canVibrate()) navigator.vibrate(15);
      } catch {
        // Haptics are a nicety; never fail the press.
      }
      onHoldRef.current();
    }
  }, []);

  const end = React.useCallback((type: 'release' | 'cancel') => {
    pointer.current = null;
    if (feedPressIsDeliberate(machine.current)) swallowClick.current = true;
    send({ type });
  }, [send]);
  const cancel = React.useCallback(() => end('cancel'), [end]);

  const holding = press.phase === 'holding';
  React.useEffect(() => {
    if (!holding) return;
    let id = 0;
    const loop = () => {
      send({ type: 'tick', at: performance.now() });
      if (machine.current.phase === 'holding') id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('keydown', onKey);
    };
  }, [holding, send, cancel]);

  // Turned off mid-press (saving, permission gone): drop the press.
  React.useEffect(() => {
    if (!enabled && machine.current.phase !== 'idle') cancel();
  }, [enabled, cancel]);

  const handlers = {
    onPointerDown: (event: React.PointerEvent) => {
      swallowClick.current = false;
      // A press whose end never reached the button (the dialog opened over it) is over.
      if (machine.current.phase !== 'idle' && pointer.current?.id !== event.pointerId) {
        pointer.current = null;
        send({ type: 'cancel' });
      }
      if (!enabled || !event.isPrimary || event.pointerType === 'mouse') return;
      pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      send({ type: 'press', at: performance.now() });
    },
    onPointerMove: (event: React.PointerEvent) => {
      const start = pointer.current;
      if (!start || start.id !== event.pointerId || machine.current.phase !== 'holding') return;
      if (feedPressMoved(start, { x: event.clientX, y: event.clientY })) cancel();
    },
    onPointerUp: (event: React.PointerEvent) => {
      if (pointer.current?.id !== event.pointerId) return;
      // Measure at release (the last frame may be up to 16 ms old).
      send({ type: 'tick', at: performance.now() });
      end('release');
    },
    onPointerCancel: (event: React.PointerEvent) => {
      if (pointer.current?.id === event.pointerId) cancel();
    },
    onPointerLeave: (event: React.PointerEvent) => {
      if (pointer.current?.id === event.pointerId) cancel();
    },
    onContextMenu: (event: React.MouseEvent) => {
      if (!enabled) return;
      event.preventDefault();
      // A touch long press also fires contextmenu: the hold handles it (or already did).
      if (pointer.current !== null || machine.current.phase !== 'idle' || Date.now() - heldAt.current < CONTEXTMENU_AFTER_HOLD_MS) return;
      onHoldRef.current();
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (!enabled || !opensEarlierFromKey(event)) return;
      // Enter would click (feed now) on keydown: Shift+Enter chooses a time instead.
      event.preventDefault();
      onHoldRef.current();
    },
    onClickCapture: (event: React.MouseEvent) => {
      if (!swallowClick.current || event.detail === 0) return;
      swallowClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };

  return { press, handlers };
}

/**
 * The fill on the Feed button while it is held (from the tap threshold to the
 * end, so a tap never flashes it). Under reduced motion nothing sweeps: a still
 * outline shows the press is held. Decorative: the button's description names
 * the gesture and the dialog announces itself.
 */
export function FeedPressFill({ press }: { press: FeedPressState }) {
  const reduced = useReducedMotion();
  const view = feedPressIndicator(press, reduced);
  if (!view.shown) return null;
  return (
    <span
      aria-hidden
      data-testid="feed-press-fill"
      data-phase={press.phase}
      data-still={view.still ? '' : undefined}
      data-fill={Math.round(view.fill * 100)}
      className={cn('pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]', view.still && 'ring-2 ring-inset ring-current')}
    >
      <span className="absolute inset-y-0 left-0 bg-current opacity-25" style={{ width: `${view.fill * 100}%` }} />
    </span>
  );
}
