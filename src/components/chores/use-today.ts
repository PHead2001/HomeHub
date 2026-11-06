'use client';

import { useEffect, useState } from 'react';
import { dayKey, msUntilNextMidnight } from '@/lib/chores/dates';

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
