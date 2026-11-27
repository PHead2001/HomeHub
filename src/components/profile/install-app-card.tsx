'use client';

import { useState, useSyncExternalStore } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { installPromptSnapshot, installState, promptInstall, subscribeInstallPrompt } from '@/lib/shell/install-prompt';
import { cn } from '@/lib/utils';

const SERVER_SNAPSHOT = { hasPrompt: false, installed: false };
const standaloneNow = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches;

/**
 * SL-19: "Install HomeHub" in Profile, shown only while the browser offers the install
 * (Chromium's `beforeinstallprompt`, kept by the shell) and the app is not already
 * running installed. One tap opens the browser's own install dialog.
 */
export function InstallAppCard({ className }: { className?: string }) {
  const state = useSyncExternalStore(subscribeInstallPrompt, installPromptSnapshot, () => SERVER_SNAPSHOT);
  const [declined, setDeclined] = useState(false);
  const shown = installState({ ...state, standalone: standaloneNow() });
  if (shown !== 'available' || declined) return null;
  return (
    <Card className={cn(className)} data-testid="install-app-card">
      <CardHeader>
        <CardTitle className="font-headline flex items-center gap-2"><Download aria-hidden /> Install HomeHub</CardTitle>
        <CardDescription>Add HomeHub to this device&apos;s home screen: it opens in its own window, full screen on a tablet, and works offline for shopping.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          type="button"
          className="min-h-11 coarse:min-h-12"
          onClick={() => {
            void promptInstall().then((choice) => { if (choice === 'dismissed') setDeclined(true); });
          }}
        >
          Install HomeHub
        </Button>
      </CardContent>
    </Card>
  );
}
