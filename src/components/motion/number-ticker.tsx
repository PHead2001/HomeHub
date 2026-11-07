'use client';

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { animate } from 'motion/react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { DURATION, EASE, tickerFrame } from '@/lib/motion';
import { cn } from '@/lib/utils';
import styles from './number-ticker.module.css';

// Set the starting digits before paint so the first frame never flashes the final value.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

type NumberTickerProps = {
  value: number;
  /** Intl options, e.g. `{ style: 'currency', currency: 'USD' }`. */
  format?: Intl.NumberFormatOptions;
  locale?: string;
  /**
   * Count up from 0 when first shown (default true, for stat tiles). Pass false
   * for counts inside labels ("Unread 3", "Purchased (2)"), which then only tick
   * when the value changes.
   */
  animateOnMount?: boolean;
  /** Seconds; clamped to the 0.4–0.7 s data-change budget. */
  duration?: number;
  className?: string;
};

/**
 * Live number (H12). Ticks to new values in 400–700 ms without blocking anything.
 *
 * Text contract (safe inside any label, button or heading): the element is one
 * inline span whose only text node is the final value, at every moment. Its
 * `textContent`, `innerText` and the accessible name of the label around it read
 * exactly the final value ("To Do (1)", "1 of 2 today"); there is no screen-reader
 * copy, no hidden width copy and no block or grid box in the label. The moving
 * digits are painted by CSS (`number-ticker.module.css`) and add no text, no
 * name and no width, so nothing shifts. Under reduced motion, during SSR and
 * before hydration the final value simply shows.
 */
export function NumberTicker({ value, format, locale, animateOnMount = true, duration = DURATION.data, className }: NumberTickerProps) {
  const reduced = useReducedMotion();
  const formatKey = JSON.stringify(format ?? {});
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the serialized options
  const formatter = useMemo(() => new Intl.NumberFormat(locale, format), [locale, formatKey]);
  const roundToInteger = Number.isInteger(value) && format?.maximumFractionDigits === undefined;
  const final = formatter.format(value);
  const element = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);

  useIsomorphicLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const stop = () => {
      node.removeAttribute('data-counting');
      node.removeAttribute('data-display');
    };
    const from = shown.current ?? (animateOnMount ? 0 : value);
    const text = (latest: number) => formatter.format(roundToInteger ? Math.round(latest) : latest);
    const finalText = text(value);
    if (reduced || from === value || tickerFrame(text(from), finalText, text(from)) === null) {
      shown.current = value;
      stop();
      return;
    }
    // The real text's own width: the pseudo-element is pulled back over it by this much.
    const textNode = node.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE || typeof document.createRange !== 'function') {
      shown.current = value;
      stop();
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(textNode);
    node.style.setProperty('--ticker-w', `${range.getBoundingClientRect().width}px`);
    const startText = text(from);
    const paint = (latest: number) => {
      const frame = tickerFrame(text(latest), finalText, startText);
      if (frame === null) return;
      node.setAttribute('data-display', frame);
    };
    paint(from);
    node.setAttribute('data-counting', '');
    const controls = animate(from, value, {
      duration: Math.min(0.7, Math.max(0.4, duration)),
      ease: EASE.standard,
      onUpdate: (latest) => {
        shown.current = latest;
        paint(latest);
      },
      onComplete: () => {
        shown.current = value;
        stop();
      },
    });
    return () => {
      controls.stop();
      stop();
    };
  }, [value, reduced, animateOnMount, duration, formatter, roundToInteger]);

  return (
    <span ref={element} className={cn(styles.ticker, className)}>
      {final}
    </span>
  );
}
