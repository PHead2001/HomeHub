'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Cloud, CloudOff } from 'lucide-react';
import { cn } from '@/lib/utils';

/** How long "Back online" stays after the connection returns. */
export const BACK_ONLINE_MS = 3000;

type Connection = 'online' | 'offline' | 'back';

// One store for both facts, so going online switches "offline" to "Back online" in
// a single update (the live region never unmounts in between).
let backUntil = 0;
const subscribe = (onChange: () => void) => {
  let timer: number | undefined;
  const onOnline = () => {
    backUntil = Date.now() + BACK_ONLINE_MS;
    window.clearTimeout(timer);
    timer = window.setTimeout(onChange, BACK_ONLINE_MS + 50);
    onChange();
  };
  const onOffline = () => {
    backUntil = 0;
    window.clearTimeout(timer);
    onChange();
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  return () => {
    window.clearTimeout(timer);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  };
};
const connection = (): Connection => {
  if (navigator.onLine === false) return 'offline';
  return Date.now() < backUntil ? 'back' : 'online';
};

/**
 * SL-10: a slim pill under the header while the browser is offline ("You're
 * offline. Changes you can make offline will sync.") and a brief "Back online"
 * when it returns. It floats below the header (no layout shift), ignores the
 * pointer and is not interactive; a polite status region, mounted only while
 * offline or "Back online" shows, announces each change once. Based on navigator.onLine and the online/offline
 * events only: it makes no promise about any particular write.
 */
export function ConnectionStatus() {
  const state = useSyncExternalStore(subscribe, connection, () => 'online' as Connection);
  const online = state !== 'offline';

  // The live region exists only while there is something to say, so an online page has
  // no extra status landmark. It mounts empty first and gets its text a frame later,
  // which screen readers announce more reliably than a region inserted with content.
  const needed = state !== 'online';
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!needed) return;
    const frame = window.requestAnimationFrame(() => setArmed(true));
    return () => {
      window.cancelAnimationFrame(frame);
      setArmed(false);
    };
  }, [needed]);

  if (!needed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="connection-status"
      className="pointer-events-none absolute inset-x-0 top-full flex justify-center px-4 pt-1.5"
    >
      {armed && (
        <span
          className={cn(
            'inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium shadow-raised animate-in fade-in-0',
            online
              ? 'border-border-subtle bg-popover text-popover-foreground'
              : 'border-border bg-secondary text-secondary-foreground',
          )}
        >
          {online ? <Cloud aria-hidden className="h-3.5 w-3.5 shrink-0" /> : <CloudOff aria-hidden className="h-3.5 w-3.5 shrink-0" />}
          <span>{online ? 'Back online' : "You're offline. Changes you can make offline will sync."}</span>
        </span>
      )}
    </div>
  );
}
