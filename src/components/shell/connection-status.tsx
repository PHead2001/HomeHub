'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Cloud, CloudOff } from 'lucide-react';
import { cn } from '@/lib/utils';

/** How long "Back online" stays after the connection returns. */
export const BACK_ONLINE_MS = 3000;

const subscribe = (onChange: () => void) => {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
};
const isOnline = () => navigator.onLine !== false;

/**
 * SL-10: a slim pill under the header while the browser is offline ("You're
 * offline. Changes you can make offline will sync.") and a brief "Back online"
 * when it returns. It floats below the header (no layout shift), ignores the
 * pointer and is not interactive; the always-present polite status region
 * announces each change once. Based on navigator.onLine and the online/offline
 * events only: it makes no promise about any particular write.
 */
export function ConnectionStatus() {
  const online = useSyncExternalStore(subscribe, isOnline, () => true);
  const [backOnline, setBackOnline] = useState(false);

  // "Back online" comes only from a real offline -> online event, never on load.
  useEffect(() => {
    let timer: number | undefined;
    const onOnline = () => {
      window.clearTimeout(timer);
      setBackOnline(true);
      timer = window.setTimeout(() => setBackOnline(false), BACK_ONLINE_MS);
    };
    const onOffline = () => {
      window.clearTimeout(timer);
      setBackOnline(false);
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const visible = !online || backOnline;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="connection-status"
      className="pointer-events-none absolute inset-x-0 top-full flex justify-center px-4 pt-1.5"
    >
      {visible && (
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
