'use client';

import { useEffect } from 'react';
import { ToastAction } from '@/components/ui/toast';
import { toast } from '@/hooks/use-toast';
import { SERVICE_WORKER_SCOPE, shouldAutoRegisterServiceWorker } from '@/lib/service-worker';
import { isShellBusy, subscribeShellBusy } from '@/lib/shell/busy';
import {
  BUILD_QUERY_MESSAGE,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_PROMPTED_KEY,
  buildIdFromMessage,
  decideUpdatePrompt,
  shouldCheckOnVisible,
} from '@/lib/shell/update-check';

const PAGE_BUILD_ID = process.env.NEXT_PUBLIC_HOMEHUB_BUILD_ID;

// The newest build offered in this tab (sessionStorage when available, memory otherwise).
let promptedInMemory: string | null = null;
const readPrompted = () => {
  try {
    return window.sessionStorage.getItem(UPDATE_PROMPTED_KEY) ?? promptedInMemory;
  } catch {
    return promptedInMemory;
  }
};
const writePrompted = (buildId: string) => {
  promptedInMemory = buildId;
  try {
    window.sessionStorage.setItem(UPDATE_PROMPTED_KEY, buildId);
  } catch {
    // Blocked storage: the in-memory copy still stops repeats on this page.
  }
};

function showUpdatedToast() {
  toast({
    title: 'HomeHub updated',
    description: 'Reload to use the latest version.',
    // Not a pending decision: it neither keeps the shell busy nor outranks an Undo.
    holdsAction: false,
    duration: 30_000,
    action: (
      <ToastAction altText="Reload HomeHub to use the latest version" onClick={() => window.location.reload()}>
        Reload
      </ToastAction>
    ),
  });
}

/**
 * SL-2: keeps the service worker fresh while a page stays open and offers a
 * Reload once a newer build is live. Checks `registration.update()` every 45
 * minutes and when the tab returns to the foreground (at most every 5 minutes),
 * asks the active worker for its build id, and listens for the worker's
 * activation message. The toast appears once per build per tab, waits while the
 * shell is busy (a save, an Undo, unsaved input), and never reloads on its own.
 * Production only (the worker is not auto-registered in development).
 */
export function UpdateWatcher() {
  useEffect(() => {
    if (!PAGE_BUILD_ID || !shouldAutoRegisterServiceWorker() || !('serviceWorker' in navigator)) return;
    const container = navigator.serviceWorker;
    let lastCheckAt = Date.now();
    let stopWaiting: (() => void) | null = null;
    let disposed = false;

    const consider = (workerBuildId: string) => {
      const decision = decideUpdatePrompt({
        pageBuildId: PAGE_BUILD_ID,
        workerBuildId,
        promptedBuildId: readPrompted(),
        busy: isShellBusy(),
      });
      if (decision === 'prompt') {
        writePrompted(workerBuildId);
        showUpdatedToast();
      } else if (decision === 'wait' && !stopWaiting) {
        stopWaiting = subscribeShellBusy((busy) => {
          if (busy) return;
          stopWaiting?.();
          stopWaiting = null;
          if (!disposed) consider(workerBuildId);
        });
      }
    };

    const askActiveWorker = () => container.controller?.postMessage({ type: BUILD_QUERY_MESSAGE });

    const check = async () => {
      lastCheckAt = Date.now();
      try {
        const registration = await container.getRegistration(SERVICE_WORKER_SCOPE);
        await registration?.update();
      } catch {
        // Offline or the server is unreachable: the next check tries again.
      }
      askActiveWorker();
    };

    const onMessage = (event: MessageEvent) => {
      const buildId = buildIdFromMessage(event.data);
      if (buildId) consider(buildId);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && shouldCheckOnVisible(lastCheckAt, Date.now())) void check();
    };

    container.addEventListener('message', onMessage);
    container.addEventListener('controllerchange', askActiveWorker);
    document.addEventListener('visibilitychange', onVisibility);
    const interval = window.setInterval(() => void check(), UPDATE_CHECK_INTERVAL_MS);
    container.startMessages();
    askActiveWorker();

    return () => {
      disposed = true;
      stopWaiting?.();
      container.removeEventListener('message', onMessage);
      container.removeEventListener('controllerchange', askActiveWorker);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(interval);
    };
  }, []);

  return null;
}
