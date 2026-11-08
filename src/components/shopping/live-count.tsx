'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { animate } from 'motion/react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { DURATION, EASE } from '@/lib/motion';
import { cn } from '@/lib/utils';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * A count inside running text ("Purchased (2)", "3 to buy") that ticks to new
 * values (H12, 400–700 ms data-change budget) without ever changing what the
 * text says. At rest it is one plain text node with the final value, so the
 * label's text and accessible name read exactly "Purchased (2)". Only while a
 * change animates are the moving digits shown, `aria-hidden`, next to a
 * visually hidden final value, so assistive tech never hears an in-between
 * number. The animation box holds the final value's width, so nothing shifts.
 * Under reduced motion the value changes at once.
 *
 * `NumberTicker` always renders three copies of the value, which breaks labels
 * whose text is matched or read as a whole; use this one inside text.
 */
export function LiveCount({
  value,
  format,
  locale = 'en-US',
  animateOnMount = false,
  className,
}: {
  value: number;
  format?: Intl.NumberFormatOptions;
  locale?: string;
  /** Tick up from 0 when first shown (stat tiles); labels default to no. */
  animateOnMount?: boolean;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const formatKey = JSON.stringify(format ?? {});
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the serialized options
  const formatter = useMemo(() => new Intl.NumberFormat(locale, format), [locale, formatKey]);
  const final = formatter.format(value);
  const roundToInteger = Number.isInteger(value) && format?.maximumFractionDigits === undefined;
  const [from, setFrom] = useState<number | null>(() => (animateOnMount && !reduced && value !== 0 ? 0 : null));
  const digits = useRef<HTMLSpanElement>(null);

  // Start an animation when the value changes (render-phase state update, so the
  // first frame of a change already shows the old number in the hidden layer).
  const [lastValue, setLastValue] = useState(value);
  if (lastValue !== value) {
    setLastValue(value);
    // From the previous value (an interrupted tick restarts from there).
    setFrom(reduced ? null : lastValue);
  }

  useIsomorphicLayoutEffect(() => {
    if (from === null) return;
    const node = digits.current;
    if (!node || from === value) {
      setFrom(null);
      return;
    }
    const controls = animate(from, value, {
      duration: Math.min(0.7, Math.max(0.4, DURATION.data)),
      ease: EASE.standard,
      onUpdate: (latest) => {
        // Update React's own text node in place, so reconciliation stays valid.
        const text = formatter.format(roundToInteger ? Math.round(latest) : latest);
        if (node.firstChild?.nodeType === Node.TEXT_NODE) node.firstChild.nodeValue = text;
        else node.textContent = text;
      },
      onComplete: () => {
        setFrom(null);
      },
    });
    return () => controls.stop();
  }, [from, value, formatter, roundToInteger]);

  if (from === null) return <span className={cn('tabular-nums', className)}>{final}</span>;
  return (
    <span className={cn('inline-grid tabular-nums', className)}>
      <span className="sr-only">{final}</span>
      <span aria-hidden className="invisible col-start-1 row-start-1">{final}</span>
      <span aria-hidden ref={digits} className="col-start-1 row-start-1 text-right">
        {formatter.format(roundToInteger ? Math.round(from) : from)}
      </span>
    </span>
  );
}
