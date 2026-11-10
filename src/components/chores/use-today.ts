'use client';

import { useEffect, useState } from 'react';
import { dayKey, msUntilNextMidnight } from '@/lib/chores/dates';
import { householdToday, msUntilHouseholdMidnight } from '@/lib/chores/completion';

/**
 * Today's local day key, kept current: it rolls over at midnight and is re-read
 * when the page becomes visible or focused again (a phone resuming an open tab
 * the next morning), so "today", overdue and the Today button never go stale.
 */
export function useToday(): string {
  const [today, setToday] = useState(() => dayKey(new Date()));

  useEffect(() => {
    let timer: number | undefined;
    const refresh = () => {
      setToday(dayKey(new Date()));
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, msUntilNextMidnight(new Date()));
    };
    timer = window.setTimeout(refresh, msUntilNextMidnight(new Date()));
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  return today;
}

/**
 * Today's day key in the household's timezone, kept current the same way. This
 * is the day the server judges completion on (`completionEligibility`), so the
 * completion controls use it rather than the browser's own day: a member in
 * another timezone can complete a chore exactly when the server will accept it.
 */
export function useHouseholdToday(timeZone: unknown): string {
  const [today, setToday] = useState(() => householdToday(new Date(), timeZone));

  useEffect(() => {
    let timer: number | undefined;
    const refresh = () => {
      setToday(householdToday(new Date(), timeZone));
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, msUntilHouseholdMidnight(new Date(), timeZone));
    };
    refresh();
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refresh);
    };
  }, [timeZone]);

  return today;
}
