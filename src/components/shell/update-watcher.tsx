'use client';

import { useEffect } from 'react';
import { ToastAction } from '@/components/ui/toast';
import { toast } from '@/hooks/use-toast';
import { SERVICE_WORKER_SCOPE, shouldAutoRegisterServiceWorker } from '@/lib/service-worker';
import { isShellBusy, subscribeShellBusy } from '@/lib/shell/busy';
import {
  BUILD_QUERY_MESSAGE,
  FORCED_RELOAD_KEY,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_PROMPTED_KEY,
  buildInfoFromMessage,
  decideRequiredReload,
  decideUpdatePrompt,
  parseForcedReload,
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

const readForcedReload = () => {
  try {
    return parseForcedReload(window.sessionStorage.getItem(FORCED_RELOAD_KEY));
  } catch {
    return null;
  }
};
const writeForcedReload = (buildId: string) => {
  try {
    window.sessionStorage.setItem(FORCED_RELOAD_KEY, JSON.stringify({ buildId, at: Date.now() }));
  } catch {
    // Blocked storage: no loop guard, but a reload only happens while this build is too old.
  }
};

// Shown once per page while it is older than the published minimum; stays until reload.
let requiredNoticeShown = false;
function showReloadRequiredToast(manual: boolean) {
  if (requiredNoticeShown) return;
  requiredNoticeShown = true;
  toast({
    title: 'HomeHub needs to reload',
    description: manual
      ? 'This version is out of date. Reload to keep using HomeHub.'
      : "This version is out of date. HomeHub will reload as soon as you finish what you're doing.",
    holdsAction: false,
    duration: Infinity,
    action: (
      <ToastAction altText="Reload HomeHub now" onClick={() => window.location.reload()}>
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
 *
 * Minimum build (member privacy release C): the worker also publishes the
 * oldest build allowed to keep running (`minimumBuildId`). A page older than it
 * says "HomeHub needs to reload" and reloads by itself as soon as the shell is
 * idle and the browser is online (`decideRequiredReload`), at most once per
 * page build within 10 minutes; after that it waits for the member's tap.
 * Production only (the worker is not auto-registered in development).
 */
export function UpdateWatcher() {
  useEffect(() => {
    if (!PAGE_BUILD_ID || !shouldAutoRegisterServiceWorker() || !('serviceWorker' in navigator)) return;
    const container = navigator.serviceWorker;
    let lastCheckAt = Date.now();
    let stopWaiting: (() => void) | null = null;
    let stopWaitingRequired: (() => void) | null = null;
    let disposed = false;

    const stopRequiredWait = () => {
      stopWaitingRequired?.();
      stopWaitingRequired = null;
    };

    const considerMinimum = (minimum: string) => {
      const decision = decideRequiredReload({
        pageBuildId: PAGE_BUILD_ID,
        minimumBuildId: minimum,
        busy: isShellBusy(),
        online: navigator.onLine !== false,
        lastForcedReload: readForcedReload(),
        now: Date.now(),
      });
      if (decision === 'none') return;
      showReloadRequiredToast(decision === 'manual');
      if (decision === 'reload') {
        stopRequiredWait();
        writeForcedReload(PAGE_BUILD_ID);
        window.location.reload();
      } else if (decision === 'wait' && !stopWaitingRequired) {
        // Re-decide when the shell goes idle or the browser comes back online.
        const retry = () => {
          stopRequiredWait();
          if (!disposed) considerMinimum(minimum);
        };
        const unsubscribe = subscribeShellBusy((busy) => {
          if (!busy) retry();
        });
        window.addEventListener('online', retry);
        stopWaitingRequired = () => {
          unsubscribe();
          window.removeEventListener('online', retry);
        };
      }
    };

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
      const info = buildInfoFromMessage(event.data);
      if (!info) return;
      if (info.minimumBuildId) considerMinimum(info.minimumBuildId);
      consider(info.buildId);
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
      stopRequiredWait();
      container.removeEventListener('message', onMessage);
      container.removeEventListener('controllerchange', askActiveWorker);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(interval);
    };
  }, []);

  return null;
}
