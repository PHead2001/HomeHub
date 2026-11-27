'use client';

import { useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';

/**
 * PR-7: shown on /profile when the signed-in person's profile could not be read
 * (offline or a server error), instead of a skeleton that never ends. Retry reads it
 * again; coming back online retries on its own (AuthProvider).
 */
export function ProfileLoadError() {
  const { retryProfileLoad } = useAuth();
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await retryProfileLoad();
    } finally {
      setRetrying(false);
    }
  };
  return (
    <div role="alert" className="mx-auto max-w-xl rounded-lg border p-6 text-center" data-testid="profile-load-error">
      <h2 className="font-headline text-xl font-semibold">Couldn&apos;t load your profile</h2>
      <p className="mt-2 text-sm text-muted-foreground">Check your connection and try again. We&apos;ll also retry when you&apos;re back online.</p>
      <Button className="mt-4 min-h-12" onClick={() => void retry()} disabled={retrying}>
        {retrying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="mr-2 h-4 w-4" aria-hidden />}
        Try again
      </Button>
    </div>
  );
}
