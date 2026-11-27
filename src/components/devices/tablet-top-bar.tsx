'use client';

// The tablet's slim top bar (WT-14b, HP-15b): the room from the device record, the
// household's clock and date, the weather when the record turns it on, the Offline pill
// (SL-10), who is acting right now with "Done", household notices and Tablet settings.
// Nothing personal while resting (WT-5a).

import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Megaphone, Settings } from 'lucide-react';
import { ConnectionStatus } from '@/components/shell/connection-status';
import { useLiveWeather } from '@/lib/dashboard/use-weather';
import { temperatureLabel } from '@/lib/dashboard/weather';
import { safeTimeZone } from '@functions/shared/calendar';
import { currentActor } from '@/lib/devices/shell-state';
import { NOTICES_PATH } from '@/lib/devices/start-page';
import { useOfflineSince } from '@/lib/devices/offline-since';
import { pinnedAnnouncement } from '@/lib/house-announcements';
import { useTablet } from './tablet-context';

export const clockLabel = (now: Date, timeZone: string) =>
  new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: safeTimeZone(timeZone) }).format(now);
export const dateLabel = (now: Date, timeZone: string) =>
  new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: safeTimeZone(timeZone) }).format(now);

export function TabletTopBar({ now }: { now: Date }) {
  const { settings, household, shell, person, done, notices, navigate, openSettings } = useTablet();
  const weather = useLiveWeather();
  const zone = household?.timeZone ?? 'America/Chicago';
  const acting = currentActor(shell);
  const actor = acting ? person(acting.memberUid) : null;
  const offlineSince = useOfflineSince();
  // NO-25: the newest house message stays pinned here until it expires (read-only: a
  // tablet writes no notification state).
  const pinned = pinnedAnnouncement(notices, now.getTime());

  return (
    <header className="relative flex h-14 shrink-0 items-center gap-4 border-b border-border bg-card px-4" data-testid="tablet-top-bar">
      <p className="min-w-0 truncate font-headline text-lg font-semibold" data-testid="tablet-room">{settings.room || settings.name}</p>
      <p className="flex items-baseline gap-3 tabular-nums">
        <span className="font-headline text-2xl font-bold" data-testid="tablet-clock">{clockLabel(now, zone)}</span>
        <span className="text-sm text-muted-foreground" data-testid="tablet-date">{dateLabel(now, zone)}</span>
      </p>
      {settings.display.weather && weather && (
        <p className="text-sm text-muted-foreground" data-testid="tablet-weather">
          {temperatureLabel(weather)} · {weather.label}
        </p>
      )}
      {pinned ? (
        <button
          type="button"
          onClick={() => navigate(NOTICES_PATH)}
          className="flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-full bg-primary/10 px-4 text-left text-primary"
          data-testid="tablet-house-message"
        >
          <Megaphone aria-hidden className="h-5 w-5 shrink-0" />
          <span className="truncate font-semibold">{pinned.message || pinned.title}</span>
        </button>
      ) : (
        <div className="flex-1" />
      )}
      {offlineSince !== null && (
        // HP-17: how old the screen may be while offline; the Offline pill below says the rest.
        <p className="text-sm text-muted-foreground" data-testid="tablet-offline-since">Offline since {clockLabel(new Date(offlineSince), zone)}</p>
      )}
      {actor && <ActingPill label={`${actor.name}${acting?.level === 'pin' ? ' (PIN)' : ''}`} onDone={done} />}
      <button
        type="button"
        onClick={() => navigate(NOTICES_PATH)}
        className="relative inline-flex min-h-12 min-w-12 items-center justify-center rounded-full text-muted-foreground"
        aria-label={notices.length > 0 ? `Household notices, ${notices.length}` : 'Household notices'}
        data-testid="tablet-notices-button"
      >
        <Bell aria-hidden className="h-6 w-6" />
        {notices.length > 0 && (
          <span aria-hidden className="absolute right-1 top-1 min-w-5 rounded-full bg-primary px-1 text-center text-[0.65rem] font-bold leading-5 text-primary-foreground">
            {notices.length > 9 ? '9+' : notices.length}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={openSettings}
        className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-full text-muted-foreground"
        aria-label="Tablet settings"
        data-testid="tablet-settings-button"
      >
        <Settings aria-hidden className="h-6 w-6" />
      </button>
      <ConnectionStatus />
    </header>
  );
}

const PILL = 'flex items-center gap-2 rounded-full bg-primary/10 py-1 pl-3 pr-1 text-sm';

/**
 * Who is acting, with Done, above an open dialog's overlay and taking taps through its modal
 * lock (D3): Done ends the remembered person even while a pet sheet or another dialog is open
 * (the dialog closes as an outside tap, and the tap still reaches Done). The shell is
 * `position: fixed`, which makes it its own stacking context, so no z-index inside it can
 * rise above a dialog's overlay (portalled to the body at z-50): the pill itself is portalled
 * to the body at z-60, placed over an invisible copy that keeps its place in the bar.
 */
function ActingPill({ label, onDone }: { label: string; onDone: () => void }) {
  const slot = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const el = slot.current;
    if (!el) return;
    const place = () => {
      const box = el.getBoundingClientRect();
      setRect((prev) => (prev && prev.top === box.top && prev.left === box.left ? prev : { top: box.top, left: box.left }));
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(el);
    if (el.parentElement) observer?.observe(el.parentElement);
    window.addEventListener('resize', place);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [label]);
  const body = (
    <>
      <span>{label}</span>
      <span className="min-h-12 rounded-full px-4 font-semibold">Done</span>
    </>
  );
  return (
    <>
      <div ref={slot} aria-hidden className={`${PILL} invisible`}>{body}</div>
      {rect && typeof document !== 'undefined' && createPortal(
        <div className={`pointer-events-auto fixed z-[60] ${PILL}`} style={{ top: rect.top, left: rect.left }} data-testid="tablet-acting">
          <span>{label}</span>
          <button type="button" onClick={onDone} className="min-h-12 rounded-full px-4 font-semibold text-primary" data-testid="tablet-done">
            Done
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
