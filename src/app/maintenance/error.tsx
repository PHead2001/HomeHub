'use client';

import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { crashTime, useCrashRecovery } from '@/components/shell/use-crash-recovery';

/**
 * Maintenance route error boundary (SL-1 for Maintenance): a crash on `/maintenance`
 * (any tab, or an asset or vehicle deep link) replaces only the Maintenance view, so
 * the header and tab bar stay. The copy is honest: services, logs and reminders
 * already saved are safe (every completion is confirmed by the server), and a form
 * that was open may need to be filled in again. "Try again" re-renders the route;
 * "Go home" leaves it. A stale-build chunk failure reloads once on its own (the shared
 * crash recovery: never while busy, never twice in ten minutes); a repeated crash
 * stays manual and shows its time. Registered wall tablets render Maintenance inside
 * the tablet shell, not this route, so their crashes reach the root boundary.
 */
export default function MaintenanceError({ error, retry }: { error: unknown; retry: () => void }) {
  const crash = useCrashRecovery(error);
  const reloading = crash?.recovery.action === 'auto-reload';
  const repeated = crash?.recovery.action === 'manual' && crash.recovery.reason === 'repeated';

  return (
    <div className="container mx-auto flex max-w-md flex-col items-center px-4 py-16 text-center" data-testid="maintenance-error">
      <div role="alert" className="flex flex-col items-center">
        <AlertTriangle aria-hidden className="h-10 w-10 text-muted-foreground" />
        <h1 className="mt-4 font-headline text-2xl font-bold tracking-tight">
          {reloading ? 'Getting the latest HomeHub…' : 'Maintenance ran into a problem'}
        </h1>
        <p className="mt-3 text-muted-foreground">
          {reloading
            ? 'This page needs a newer version of the app. Reloading now.'
            : repeated
              ? `Maintenance keeps running into a problem (last at ${crashTime(crash.at)}). Services, logs and reminders already saved are safe. Try again, or go home and come back later.`
              : 'Services, logs and reminders already saved are safe. Anything you were typing may need to be entered again.'}
        </p>
      </div>
      {!reloading && (
        <div className="mt-8 flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
          <Button className="min-h-11 coarse:min-h-12" onClick={() => retry()}>Try again</Button>
          <Button asChild variant="outline" className="min-h-11 coarse:min-h-12">
            <Link href="/">Go home</Link>
          </Button>
        </div>
      )}
    </div>
  );
}
