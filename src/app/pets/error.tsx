'use client';

import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { crashTime, useCrashRecovery } from '@/components/shell/use-crash-recovery';

/**
 * Pets route error boundary (D-P15, SL-1 for Pets): a crash on `/pets` or a pet
 * page replaces only the Pets view, with honest copy: feedings, doses and care
 * already saved are safe (every write is confirmed by the server or queued), and
 * nothing is claimed as saved that was not. "Try again" re-renders the route;
 * "Home" leaves it. A stale-build chunk failure reloads once on its own (the
 * shared crash recovery, no loop); a repeated crash stays manual with its time.
 */
export default function PetsError({ error, retry }: { error: unknown; retry: () => void }) {
  const crash = useCrashRecovery(error);
  const reloading = crash?.recovery.action === 'auto-reload';
  const repeated = crash?.recovery.action === 'manual' && crash.recovery.reason === 'repeated';

  return (
    <div className="container mx-auto flex max-w-md flex-col items-center px-4 py-16 text-center" data-testid="pets-error">
      <div role="alert" className="flex flex-col items-center">
        <AlertTriangle aria-hidden className="h-10 w-10 text-muted-foreground" />
        <h1 className="mt-4 font-headline text-2xl font-bold tracking-tight">
          {reloading ? 'Getting the latest HomeHub…' : 'Pets ran into a problem'}
        </h1>
        <p className="mt-3 text-muted-foreground">
          {reloading
            ? 'This page needs a newer version of the app. Reloading now.'
            : repeated
              ? `Pets keeps running into a problem (last at ${crashTime(crash.at)}). Feedings, doses and care already saved are safe. Try again, or go home and come back later.`
              : 'Feedings, doses and care already saved are safe. Anything you were typing may need to be entered again.'}
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
