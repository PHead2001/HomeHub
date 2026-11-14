'use client';

import * as React from 'react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { HOLD_IDLE, holdIsDeliberate, holdJustCompleted, holdReducer, type HoldEvent, type HoldState } from '@/lib/pets/hold';
import { cn } from '@/lib/utils';
import { steppedHoldProgress } from '@/lib/pets/board';
import { PawBurst, type QuickFeedController } from './quick-feed-button';
import { markHoldCaptionDone } from './use-pets-layout';

const R = 26;
const CIRCUMFERENCE = 2 * Math.PI * R;

const inside = (rect: DOMRect, x: number, y: number) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

/**
 * Hold to feed (H09) for a pet card. Press and hold the photo for 800 ms to log a
 * feeding through the card's shared feed controller (the same writer as the Feed
 * button). Releasing early, pointer cancel (a scroll), leaving the photo and
 * Escape all cancel without logging. Works with mouse, pen and touch.
 *
 * The handlers go on the photo's frame (`HoldPhoto` in living-pet-card.tsx),
 * and only presses inside the photo's box count. With a mouse the photo is a
 * link and a short click (under 150 ms) still opens the pet; on touch it is not
 * a link (PE-11a). After a hold attempt (completed, released or cancelled) the
 * following click is swallowed so nothing navigates.
 */
export function useHoldToFeed(feed: QuickFeedController, photoRef: React.RefObject<HTMLElement | null>) {
  const [hold, setHold] = React.useState<HoldState>(HOLD_IDLE);
  const machine = React.useRef<HoldState>(HOLD_IDLE);
  const pointer = React.useRef<number | null>(null);
  const swallowClick = React.useRef(false);
  const feedRef = React.useRef(feed);
  React.useEffect(() => { feedRef.current = feed; });
  const enabled = feed.allowed;

  const send = React.useCallback((event: HoldEvent) => {
    const previous = machine.current;
    const next = holdReducer(previous, event);
    if (next === previous) return;
    machine.current = next;
    setHold(next);
    if (holdJustCompleted(previous, next)) {
      swallowClick.current = true;
      void feedRef.current.feed('hold');
      // The one-time "Hold the photo to feed" caption is done in this browser (PE-12a, D-P17).
      markHoldCaptionDone();
    }
  }, []);

  // Ending a hold attempt (anything past a tap) swallows the click that follows,
  // so a cancelled or released hold never opens the pet page.
  const end = React.useCallback((type: 'release' | 'cancel') => {
    pointer.current = null;
    if (holdIsDeliberate(machine.current)) swallowClick.current = true;
    send({ type });
  }, [send]);
  const cancel = React.useCallback(() => end('cancel'), [end]);

  // While holding: advance the progress every frame, and Escape cancels.
  const holding = hold.phase === 'holding';
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

  const onPointerDown = (event: React.PointerEvent) => {
    swallowClick.current = false;
    const photo = photoRef.current;
    // No hold before the feeding history (the food type) has loaded.
    if (!enabled || feed.saving || !feed.ready || !photo || !event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const target = event.target as Element;
    // Other controls (menu, Feed button) sit above the link and are never a hold.
    if (!(photo.contains(target) || target.closest('a[data-hold-to-feed]'))) return;
    if (!inside(photo.getBoundingClientRect(), event.clientX, event.clientY)) return;
    pointer.current = event.pointerId;
    send({ type: 'press', at: performance.now() });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (pointer.current !== event.pointerId || machine.current.phase !== 'holding') return;
    const photo = photoRef.current;
    if (!photo || !inside(photo.getBoundingClientRect(), event.clientX, event.clientY)) cancel();
  };

  const onPointerEnd = (event: React.PointerEvent) => {
    if (pointer.current !== event.pointerId) return;
    // Measure the hold at release time (the last frame may be up to 16 ms old).
    send({ type: 'tick', at: performance.now() });
    end('release');
  };

  const onPointerCancel = (event: React.PointerEvent) => {
    if (pointer.current === event.pointerId) cancel();
  };

  const handlers = {
    onPointerDown,
    onPointerMove,
    onPointerUp: onPointerEnd,
    onPointerCancel,
    onPointerLeave: onPointerCancel,
    // A long press on touch opens the link's context menu; not while holding.
    onContextMenu: (event: React.MouseEvent) => {
      if (machine.current.phase !== 'idle' || pointer.current !== null) event.preventDefault();
    },
    onClickCapture: (event: React.MouseEvent) => {
      // Keyboard activation (detail 0) is never part of a hold.
      if (!swallowClick.current || event.detail === 0) return;
      swallowClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };

  return { hold, enabled, handlers };
}

/**
 * The fill ring over the photo while holding (progress over `HOLD_MS`, 800 ms) and the paw
 * burst when the hold logs a feeding. Decorative: the Feed button's description
 * explains the gesture and the toast announces the result. Under reduced motion
 * the ring does not sweep: it fills in three discrete steps (PE-20a), so progress
 * is still visible without continuous motion.
 */
export function HoldToFeedOverlay({ hold, feed }: { hold: HoldState; feed: QuickFeedController }) {
  const reduced = useReducedMotion();
  const progress = hold.phase === 'complete' ? 1 : hold.phase === 'holding' ? hold.progress : 0;
  const active = holdIsDeliberate(hold);
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
      {active && (
        <div
          className="relative flex h-16 w-16 items-center justify-center rounded-full bg-background/80 shadow-overlay"
          data-testid="hold-to-feed-ring"
          data-progress={Math.round(progress * 100)}
          data-shown-progress={Math.round((reduced ? steppedHoldProgress(progress) : progress) * 100)}
        >
          <svg viewBox="0 0 64 64" className="absolute inset-0 h-full w-full -rotate-90">
            <circle cx="32" cy="32" r={R} fill="none" strokeWidth="5" className="stroke-muted" />
            <circle
              cx="32"
              cy="32"
              r={R}
              fill="none"
              strokeWidth="5"
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - (reduced ? steppedHoldProgress(progress) : progress))}
              className={hold.phase === 'complete' ? 'stroke-success' : 'stroke-primary'}
            />
          </svg>
          <span className={cn('relative text-xs font-semibold', hold.phase === 'complete' ? 'text-success' : 'text-foreground')}>
            {hold.phase === 'complete' ? 'Fed' : 'Hold'}
          </span>
        </div>
      )}
      {feed.burst?.source === 'hold' ? <PawBurst key={feed.burst.key} /> : null}
    </div>
  );
}

