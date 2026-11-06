'use client';

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { animate } from 'motion/react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { DURATION, EASE } from '@/lib/motion';
import { cn } from '@/lib/utils';

// Set the starting digits before paint so the first frame never flashes the final value.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

// Update React's own text node in place (never replace it) so reconciliation stays valid.
function setText(node: HTMLElement, text: string) {
  if (node.firstChild && node.firstChild.nodeType === Node.TEXT_NODE) node.firstChild.nodeValue = text;
  else node.textContent = text;
}

type NumberTickerProps = {
  value: number;
  /** Intl options, e.g. `{ style: 'currency', currency: 'USD' }`. */
  format?: Intl.NumberFormatOptions;
  locale?: string;
  /** Animate up from 0 on first mount (default true). Later changes always tick. */
  animateOnMount?: boolean;
  /** Seconds; clamped to the 0.4–0.7 s data-change budget. */
  duration?: number;
  className?: string;
};

/**
 * Live number (H12). Ticks to new values in 400–700 ms without blocking anything.
 * Screen readers get the final value immediately (the animated digits are
 * aria-hidden), and the final value reserves the width so nothing shifts.
 * Under reduced motion the final value renders instantly.
 */
export function NumberTicker({ value, format, locale, animateOnMount = true, duration = DURATION.data, className }: NumberTickerProps) {
  const reduced = useReducedMotion();
  const formatKey = JSON.stringify(format ?? {});
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the serialized options
  const formatter = useMemo(() => new Intl.NumberFormat(locale, format), [locale, formatKey]);
  const roundToInteger = Number.isInteger(value) && format?.maximumFractionDigits === undefined;
  const final = formatter.format(value);
  const display = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);

  useIsomorphicLayoutEffect(() => {
    const node = display.current;
    if (!node) return;
    const from = shown.current ?? (animateOnMount ? 0 : value);
    if (reduced || from === value) {
      shown.current = value;
      setText(node, formatter.format(value));
      return;
    }
    setText(node, formatter.format(roundToInteger ? Math.round(from) : from));
    const controls = animate(from, value, {
      duration: Math.min(0.7, Math.max(0.4, duration)),
      ease: EASE.standard,
      onUpdate: (latest) => {
        shown.current = latest;
        setText(node, formatter.format(roundToInteger ? Math.round(latest) : latest));
      },
      onComplete: () => {
        shown.current = value;
        setText(node, formatter.format(value));
      },
    });
    return () => controls.stop();
  }, [value, reduced, animateOnMount, duration, formatter, roundToInteger]);

  return (
    <span className={cn('inline-grid tabular-nums', className)}>
      <span className="sr-only">{final}</span>
      {/* Reserves the final width so the ticking digits never shift layout. */}
      <span aria-hidden className="invisible col-start-1 row-start-1">{final}</span>
      <span aria-hidden ref={display} className="col-start-1 row-start-1 text-right">
        {final}
      </span>
    </span>
  );
}
