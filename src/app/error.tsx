'use client';

import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { crashTime, useCrashRecovery } from '@/components/shell/use-crash-recovery';

/**
 * Route error boundary (SL-1). It replaces only the page: the root layout keeps
 * the header and phone tab bar, so the member can move on. "Try again"
 * re-renders the route (`retry`); "Go home" leaves it. A stale-build chunk
 * failure reloads once on its own unless the shell is busy; a second crash
 * within ten minutes shows the time and stays manual (no reload loop).
 */
export default function RouteError({ error, retry }: { error: unknown; retry: () => void }) {
  const crash = useCrashRecovery(error);
  const reloading = crash?.recovery.action === 'auto-reload';
  const repeated = crash?.recovery.action === 'manual' && crash.recovery.reason === 'repeated';

  return (
    <div className="container mx-auto flex max-w-md flex-col items-center px-4 py-16 text-center">
      <div role="alert" className="flex flex-col items-center">
        <AlertTriangle aria-hidden className="h-10 w-10 text-muted-foreground" />
        <h1 className="mt-4 font-headline text-2xl font-bold tracking-tight">
          {reloading ? 'Getting the latest HomeHub…' : 'Something went wrong'}
        </h1>
        <p className="mt-3 text-muted-foreground">
          {reloading
            ? 'This page needs a newer version of the app. Reloading now.'
            : repeated
              ? `This page keeps running into a problem (last at ${crashTime(crash.at)}). Anything you already saved is safe. Try again, or go home and come back later.`
              : 'This page ran into a problem. Anything you already saved is safe.'}
        </p>
      </div>
      {!reloading && (
        <div className="mt-8 flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
          <Button className="min-h-11" onClick={() => retry()}>Try again</Button>
          <Button asChild variant="outline" className="min-h-11">
            <Link href="/">Go home</Link>
          </Button>
        </div>
      )}
    </div>
  );
}
