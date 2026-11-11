'use client';

import { useEffect, useState } from 'react';
import { householdToday, msUntilHouseholdMidnight } from './pantry-batches';

/**
 * Today in the household's zone (`yyyy-MM-dd`, D-6), re-keyed at household
 * midnight on an open page (SH-10b: the always-on kitchen tablet). A timer fires
 * just after midnight; showing the page again (a tablet waking) re-checks at once,
 * since timers are throttled while a page is hidden.
 */
export function useHouseholdToday(timeZone?: string | null): string {
  const [today, setToday] = useState(() => householdToday(new Date(), timeZone));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      const now = new Date();
      setToday(householdToday(now, timeZone));
      if (timer) clearTimeout(timer);
      // Re-check at least hourly, so a clock or zone change is picked up too.
      timer = setTimeout(refresh, Math.min(msUntilHouseholdMidnight(now, timeZone) + 1000, 60 * 60_000));
    };
    refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [timeZone]);

  return today;
}
