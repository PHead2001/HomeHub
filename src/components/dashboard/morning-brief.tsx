'use client';

/**
 * Morning brief (H04): one line from exact dashboard facts, no model call. It types
 * itself out on the first visit of the day (at most ~1.2 s; any key or click skips)
 * and renders instantly afterwards and under reduced motion. Screen readers get
 * the whole sentence at once; every noun phrase is a link once shown. The full
 * sentence reserves its space while typing, so nothing below it moves.
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { buildMorningBrief } from '@/lib/dashboard/brief';
import { greeting } from '@/lib/dashboard/ambience';
import { dayKey } from '@/lib/dashboard/dates';
import type { DashboardFacts } from '@/lib/dashboard/facts';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { cn } from '@/lib/utils';
import styles from './dashboard.module.css';

const SEEN_KEY = 'homehub.dashboard.briefTyped';
const MAX_TYPE_MS = 1200;
const LINE_CLASS = 'mb-6 min-h-[3.5rem] font-headline text-lg leading-snug sm:min-h-[2rem] sm:text-xl';

const typedToday = () => {
  try {
    return window.localStorage.getItem(SEEN_KEY) === dayKey(new Date());
  } catch {
    return true;
  }
};

function BriefLine({ facts, name, now }: { facts: DashboardFacts; name?: string | null; now: Date }) {
  const reduced = useReducedMotion();
  const brief = useMemo(() => buildMorningBrief(facts, { greeting: greeting(now), name }), [facts, name, now]);
  // Mounted on the client once facts are ready, so storage can be read at init.
  const [typed, setTyped] = useState<number | null>(() => (reduced || typedToday() ? null : 0));
  const typing = typed !== null;

  useEffect(() => {
    try {
      window.localStorage.setItem(SEEN_KEY, dayKey(new Date()));
    } catch {
      // Without storage the brief simply types again next visit.
    }
  }, []);

  useEffect(() => {
    if (!typing) return;
    const total = brief.text.length;
    const step = Math.max(1, Math.ceil(total / (MAX_TYPE_MS / 16)));
    let count = 0;
    const finish = () => {
      window.clearInterval(id);
      setTyped(null);
    };
    const id = window.setInterval(() => {
      count += step;
      if (count >= total) finish();
      else setTyped(count);
    }, 16);
    window.addEventListener('keydown', finish, { once: true });
    window.addEventListener('pointerdown', finish, { once: true });
    return () => {
      window.clearInterval(id);
      window.removeEventListener('keydown', finish);
      window.removeEventListener('pointerdown', finish);
    };
    // Types once per mount; later fact changes render instantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typing]);

  return (
    <p className={LINE_CLASS} data-testid="morning-brief">
      {typed !== null && !reduced ? (
        <span className="relative block">
          <span className="sr-only">{brief.text}</span>
          <span aria-hidden className="invisible">{brief.text}</span>
          <span aria-hidden className={cn(styles.caret, 'absolute inset-0')}>{brief.text.slice(0, typed)}</span>
        </span>
      ) : (
        brief.segments.map((segment, index) => segment.href ? (
          <Link key={index} href={segment.href} className="text-primary underline-offset-4 hover:underline">
            {segment.text}
          </Link>
        ) : (
          <span key={index}>{segment.text}</span>
        ))
      )}
    </p>
  );
}

export function MorningBrief({ facts, name, now, ready }: { facts: DashboardFacts; name?: string | null; now: Date; ready: boolean }) {
  if (!ready) return <div aria-hidden className={cn(LINE_CLASS, 'w-3/4 max-w-xl animate-pulse rounded bg-muted')} />;
  return <BriefLine facts={facts} name={name} now={now} />;
}
