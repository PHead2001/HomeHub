'use client';

/**
 * AU-15: the dashboard's "Home status" card ("All doors closed · 2 lights on · 71 °F
 * inside", with warnings for leaks, doors open 10+ min and low batteries), and AU-13's
 * house marks, from one server read of the household's Home Assistant states (cached
 * server-side, AU-10). Only asked for when the household is connected and the member
 * may view automation; never on a registered wall tablet (its token can't reach Home
 * Assistant). Refreshes every minute while the page is visible.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, House } from 'lucide-react';
import { auth } from '@/lib/firebase';
import { useAuth } from '@/hooks/use-auth';
import { getHomeStatus, type HomeStatusResult } from '@/app/automation/actions';
import { STATUS_POLL_INTERVAL_MS, pollDue, updatedLabel } from '@/lib/automation/refresh';
import { cn } from '@/lib/utils';

type Connected = Extract<HomeStatusResult, { connected: true }>;

export function useHomeStatus(enabled: boolean): Connected | null {
  const { currentUser, permissions, household } = useAuth();
  const householdId = currentUser?.householdId ?? null;
  const active = enabled && Boolean(householdId) && Boolean(permissions['automation.view']) && household?.homeAssistant?.connected === true;
  const [data, setData] = useState<Connected | null>(null);
  const inFlight = useRef(false);
  const lastAttempt = useRef<number | null>(null);

  const load = useCallback(async () => {
    const user = auth.currentUser;
    if (!user || !householdId || inFlight.current) return;
    inFlight.current = true;
    lastAttempt.current = Date.now();
    try {
      const result = await getHomeStatus({ idToken: await user.getIdToken(), householdId });
      if (result.ok) setData(result.data.connected ? result.data : null);
    } catch {
      // Keep the last answer; the next poll tries again.
    } finally {
      inFlight.current = false;
    }
  }, [householdId]);

  useEffect(() => {
    if (!active) {
      lastAttempt.current = null;
      return;
    }
    const tick = () => {
      if (pollDue({ visible: document.visibilityState === 'visible', inFlight: inFlight.current, lastAttempt: lastAttempt.current, now: Date.now(), interval: STATUS_POLL_INTERVAL_MS })) void load();
    };
    tick();
    const id = window.setInterval(tick, 10_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [active, load]);

  return active ? data : null;
}

export function HomeStatusCard({ data, now }: { data: Connected; now: Date }) {
  const { status } = data;
  const warn = status.warnings.length > 0;
  return (
    <Link
      href="/automation"
      data-testid="home-status-card"
      className={cn('flex min-h-[var(--target-min)] items-start gap-3 rounded-xl border bg-card px-3 py-2 text-sm transition-ui hover:bg-accent', warn && 'border-warning')}
    >
      {warn ? <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-warning" /> : <House aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
      <span className="min-w-0">
        <span className="block font-medium">Home status</span>
        <span className="block text-muted-foreground">{status.line}</span>
        {warn && (
          <span className="mt-1 block text-foreground">{status.warnings.slice(0, 3).join(' · ')}{status.warnings.length > 3 ? ` · ${status.warnings.length - 3} more` : ''}</span>
        )}
        <span className="sr-only">{updatedLabel(data.fetchedAt, now.getTime())}</span>
      </span>
    </Link>
  );
}
