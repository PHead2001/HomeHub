'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { auth } from '@/lib/firebase';
import { householdServerTimeAction } from '@/app/household/actions';

/** How often the time moves on while something on the page depends on it. */
const TICK_MS = 15_000;

/**
 * The current time by the server's clock (HO-8: invite expiry neither trusts the
 * device clock nor freezes at the first render). While `enabled`, the offset is
 * learned once from `householdServerTimeAction`; until it answers, or if it
 * fails, the device clock is used. The time moves on every 15 seconds while
 * `liveKey` is not empty (something can still expire), and at once when
 * `liveKey` changes, so a newly created invite is measured against a fresh time.
 */
export function useServerNow(enabled: boolean, liveKey: string): Date {
  const [offsetMs, setOffsetMs] = useState(0);
  const [tick, setTick] = useState(() => Date.now());
  const learned = useRef(false);

  useEffect(() => {
    if (!enabled || learned.current) return;
    let cancelled = false;
    void (async () => {
      const user = auth.currentUser;
      if (!user) return;
      try {
        const idToken = await user.getIdToken();
        const sentAt = Date.now();
        const result = await householdServerTimeAction({ idToken });
        if (cancelled || !result.ok) return;
        const serverMs = new Date(result.data.serverNow).getTime();
        if (Number.isNaN(serverMs)) return;
        learned.current = true;
        // The server read its clock about halfway through the round trip.
        setOffsetMs(serverMs - (sentAt + Date.now()) / 2);
      } catch {
        // The device clock stays in use; the server still enforces expiry.
      }
    })();
    return () => { cancelled = true; };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !liveKey) return;
    const now = () => setTick(Date.now());
    const kick = window.setTimeout(now, 0);
    const timer = window.setInterval(now, TICK_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') now(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(kick);
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, liveKey]);

  return useMemo(() => new Date(tick + offsetMs), [tick, offsetMs]);
}
