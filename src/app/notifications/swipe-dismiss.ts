'use client';

import { useCallback, useRef, useState } from 'react';
import type React from 'react';

/**
 * Swipe-to-dismiss for notification cards (H11).
 *
 * The hook's handlers go on a wrapper that never moves (the hit target), and
 * `visualStyle` goes on the inner visual layer, which is the only thing that
 * slides. Only touch (and pens on coarse-pointer devices) can swipe; mouse
 * users keep the dismiss button. Under reduced motion nothing slides: the
 * dismiss hint fades in with the drag and the card is dismissed in place.
 */

/** Leftward travel (px) past which releasing the card dismisses it. */
export const SWIPE_DISMISS_DISTANCE = 70;
/** Movement (px) before a press becomes a swipe instead of a tap. */
export const SWIPE_SLOP = 6;
/** Slide-out time; within the 250 ms UI-transition budget. */
export const SWIPE_OUT_MS = 200;

/** Which pointers may swipe: touch always, pens only on coarse-pointer devices, never a mouse. */
export function isSwipePointer(pointerType: string, coarsePointer: boolean): boolean {
  if (pointerType === 'touch') return true;
  if (pointerType === 'pen') return coarsePointer;
  return false;
}

/**
 * Where the visual layer sits for a horizontal drag of `deltaX`: free to the
 * left, resisting to the right (a fifth of the travel, at most 10 px).
 */
export function swipeOffset(deltaX: number): number {
  if (deltaX <= 0) return deltaX;
  return Math.min(deltaX / 5, 10);
}

/** Whether releasing at `offset` dismisses. */
export function swipeDismisses(offset: number): boolean {
  return offset <= -SWIPE_DISMISS_DISTANCE;
}

/** Opacity of the dismiss hint behind the card for a drag of `offset`. */
export function swipeHintOpacity(offset: number): number {
  return Math.min(Math.max(-offset / SWIPE_DISMISS_DISTANCE, 0), 1);
}

const coarsePointer = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;

export function useSwipeDismiss({
  disabled,
  reducedMotion,
  onDismiss,
}: {
  disabled: boolean;
  reducedMotion: boolean;
  onDismiss: () => void;
}) {
  // Where the drag is (drives the hint) and where the visual layer is drawn.
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [sliding, setSliding] = useState(false);
  const startX = useRef(0);
  const offsetRef = useRef(0);
  const active = useRef(false);
  const swiped = useRef(false);
  const pointerId = useRef<number | null>(null);

  const move = (next: number) => {
    offsetRef.current = next;
    setOffset(next);
  };

  const reset = (element: HTMLElement | null) => {
    if (element && pointerId.current !== null && element.hasPointerCapture?.(pointerId.current)) {
      element.releasePointerCapture(pointerId.current);
    }
    active.current = false;
    pointerId.current = null;
    setDragging(false);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    swiped.current = false;
    if (disabled || sliding || !event.isPrimary || !isSwipePointer(event.pointerType, coarsePointer())) return;
    // A swipe may start anywhere on the card, including on the dismiss button
    // (always shown on touch screens, at the right edge where a left swipe
    // naturally starts). A tap on the button still clicks it: the pointer is
    // captured only after the slop, and a completed swipe's click is swallowed.
    active.current = true;
    pointerId.current = event.pointerId;
    startX.current = event.clientX;
    offsetRef.current = 0;
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (!active.current || event.pointerId !== pointerId.current) return;
    const deltaX = event.clientX - startX.current;
    if (!swiped.current && Math.abs(deltaX) > SWIPE_SLOP) {
      swiped.current = true;
      // Capture only once a swipe has started; capturing on press would
      // retarget a plain tap away from the card's link.
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    if (swiped.current) {
      event.preventDefault();
      move(swipeOffset(deltaX));
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    if (!active.current || event.pointerId !== pointerId.current) return;
    const dismiss = swiped.current && swipeDismisses(offsetRef.current);
    reset(event.currentTarget);
    // The click that follows this release (if any) is swallowed below; clear
    // the flag afterwards so a later keyboard activation is never blocked.
    if (swiped.current) window.setTimeout(() => { swiped.current = false; }, 0);
    if (!dismiss) {
      move(0);
      return;
    }
    if (reducedMotion) {
      move(0);
      onDismiss();
      return;
    }
    setSliding(true);
    move(-(event.currentTarget.offsetWidth || 400));
    window.setTimeout(() => {
      onDismiss();
      // The card stays mounted under the "All" and "Dismissed" filters.
      setSliding(false);
      move(0);
    }, SWIPE_OUT_MS);
  };

  const onPointerCancel = (event: React.PointerEvent<HTMLElement>) => {
    if (!active.current) return;
    swiped.current = false;
    reset(event.currentTarget);
    move(0);
  };

  // A swipe must not also open the card's link.
  const onClickCapture = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!swiped.current) return;
    swiped.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const moved = offset !== 0;
  const visualStyle: React.CSSProperties = reducedMotion
    ? {}
    : {
        transform: moved ? `translateX(${offset}px)` : undefined,
        transition: dragging ? 'none' : `transform ${SWIPE_OUT_MS}ms var(--ease-standard, ease-out)`,
      };

  return {
    /** Spread on the wrapper that never moves. */
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture },
    /** Style for the visual layer (no transform under reduced motion). */
    visualStyle,
    /** Opacity of the dismiss hint behind the card. */
    hintOpacity: disabled ? 0 : swipeHintOpacity(offset),
    /** True while a finger is down on the card or it is sliding out. */
    engaged: dragging || sliding || moved,
    dragging,
  };
}
