'use client';

// A new build reaches the wall tablet by itself (WT-14l, HP-17e): it reloads while idle
// (nothing busy, resting, online), at most once per build per tab, and never after the
// crash guard counted repeated crashes in this tab (the error boundary then shows the
// plain error with the time and a manual retry, as for everyone since 2.1). It reuses
// the 2.1 worker build messages (src/lib/shell/update-check.ts). Production only: the
// service worker is not registered in development.

import { useEffect, useRef, useState } from 'react';
import { SERVICE_WORKER_SCOPE, shouldAutoRegisterServiceWorker } from '@/lib/service-worker';
import { isShellBusy, subscribeShellBusy } from '@/lib/shell/busy';
import { CRASH_HISTORY_KEY, CRASH_WINDOW_MS, parseCrashHistory } from '@/lib/shell/crash-guard';
import {
  BUILD_QUERY_MESSAGE,
  TABLET_RELOADED_KEY,
  UPDATE_CHECK_INTERVAL_MS,
  buildInfoFromMessage,
  decideTabletReload,
} from '@/lib/shell/update-check';

const PAGE_BUILD_ID = process.env.NEXT_PUBLIC_HOMEHUB_BUILD_ID;

const readSession = (key: string): string | null => {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
};

export function TabletUpdateWatcher({ resting }: { resting: boolean }) {
  const [workerBuild, setWorkerBuild] = useState<string | null>(null);
  const [busy, setBusy] = useState(() => isShellBusy());
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const reloading = useRef(false);

  useEffect(() => subscribeShellBusy(setBusy), []);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    if (!PAGE_BUILD_ID || !shouldAutoRegisterServiceWorker() || !('serviceWorker' in navigator)) return;
    const container = navigator.serviceWorker;
    const ask = () => container.controller?.postMessage({ type: BUILD_QUERY_MESSAGE });
    const onMessage = (event: MessageEvent) => {
      const info = buildInfoFromMessage(event.data);
      if (info) setWorkerBuild(info.buildId);
    };
    const check = async () => {
      try {
        const registration = await container.getRegistration(SERVICE_WORKER_SCOPE);
        await registration?.update();
      } catch {
        // Offline: the next check tries again.
      }
      ask();
    };
    container.addEventListener('message', onMessage);
    container.addEventListener('controllerchange', ask);
    const interval = window.setInterval(() => void check(), UPDATE_CHECK_INTERVAL_MS);
    container.startMessages();
    ask();
    return () => {
      container.removeEventListener('message', onMessage);
      container.removeEventListener('controllerchange', ask);
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (reloading.current) return;
    const now = Date.now();
    const recentCrashes = parseCrashHistory(readSession(CRASH_HISTORY_KEY)).filter((at) => at <= now && now - at < CRASH_WINDOW_MS).length;
    const decision = decideTabletReload({
      pageBuildId: PAGE_BUILD_ID,
      workerBuildId: workerBuild,
      reloadedFor: readSession(TABLET_RELOADED_KEY),
      busy,
      resting,
      online,
      recentCrashes,
    });
    if (decision !== 'reload' || !workerBuild) return;
    reloading.current = true;
    try {
      window.sessionStorage.setItem(TABLET_RELOADED_KEY, workerBuild);
    } catch {
      // Without storage the reload could not be counted: never reload on its own then.
      return;
    }
    if (readSession(TABLET_RELOADED_KEY) !== workerBuild) return;
    window.location.reload();
  }, [busy, online, resting, workerBuild]);

  return null;
}
