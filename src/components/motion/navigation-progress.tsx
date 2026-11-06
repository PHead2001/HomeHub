'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';

/** Navigations faster than this never show the bar. */
const SHOW_AFTER_MS = 150;
/** Safety net: hide the bar if a navigation never commits (cancelled, errored). */
const GIVE_UP_AFTER_MS = 10_000;

function internalHref(event: MouseEvent): URL | null {
  // next/link always calls preventDefault, so that flag says nothing here. Clicks a
  // handler stopped (e.g. a menu inside a card link) never reach window.
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return null;
  }
  const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!anchor || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return null;
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return null;
  // Same page (or only the hash/query changed): no route load to wait for.
  if (url.pathname === window.location.pathname) return null;
  return url;
}

/**
 * Thin top progress bar shown only for navigations slower than 150 ms. It is
 * decorative (aria-hidden): route loading states announce themselves.
 */
export function NavigationProgress() {
  const pathname = usePathname();
  const [phase, setPhase] = useState<'idle' | 'loading' | 'done'>('idle');
  const timers = useRef<number[]>([]);

  const clearTimers = () => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
  };

  useEffect(() => {
    const start = () => {
      clearTimers();
      timers.current.push(
        window.setTimeout(() => setPhase('loading'), SHOW_AFTER_MS),
        window.setTimeout(() => setPhase('idle'), GIVE_UP_AFTER_MS),
      );
    };
    const onClick = (event: MouseEvent) => {
      if (internalHref(event)) start();
    };
    window.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('click', onClick);
      clearTimers();
    };
  }, []);

  // The route committed: finish the bar (or cancel it before it ever showed).
  const [committedPath, setCommittedPath] = useState(pathname);
  if (committedPath !== pathname) {
    setCommittedPath(pathname);
    setPhase((current) => (current === 'loading' ? 'done' : 'idle'));
  }
  useEffect(() => clearTimers(), [pathname]);

  useEffect(() => {
    if (phase !== 'done') return;
    const id = window.setTimeout(() => setPhase('idle'), 260);
    return () => window.clearTimeout(id);
  }, [phase]);

  const progress = phase === 'loading' ? 0.7 : phase === 'done' ? 1 : 0;
  return (
    <div
      aria-hidden
      className="nav-progress"
      style={{ ['--nav-progress' as string]: progress, opacity: phase === 'idle' ? 0 : 1 }}
    />
  );
}
