'use client';

// The ambient screen and night dimming (design 14.3, 14.4; D-T6, D-T1, WT-14f/g).
//
// Ambient: after the tablet's ambient time without input, a basic clock screen: the time,
// the date and the weather when the record turns it on. Nothing personal (no names,
// chores or pets; the richer ambient is SL-23). It drifts slowly against burn-in: with
// reduced motion it moves once a minute without animation. A tap wakes it and never acts
// (the tap lands on this screen, not on what is under it).
//
// Night dimming: during the household's quiet hours a dark layer lies over the screen.
// It never takes a touch (pointer events pass through).

import { useEffect, useState } from 'react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { useLiveWeather } from '@/lib/dashboard/use-weather';
import { temperatureLabel } from '@/lib/dashboard/weather';
import { cn } from '@/lib/utils';
import { useTablet } from './tablet-context';
import { clockLabel, dateLabel } from './tablet-top-bar';

/** Drift positions (percent offsets), one step a minute. */
const DRIFT = [[0, 0], [6, -4], [-5, 5], [4, 6], [-6, -3], [3, -6], [-3, 3]] as const;

export function AmbientScreen({ now, onWake }: { now: Date; onWake: () => void }) {
  const { household, settings } = useTablet();
  const reduced = useReducedMotion();
  const weather = useLiveWeather();
  const [step, setStep] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setStep((s) => (s + 1) % DRIFT.length), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const zone = household?.timeZone ?? 'America/Chicago';
  const [x, y] = DRIFT[step];

  return (
    <div
      data-ambient
      data-testid="tablet-ambient"
      role="button"
      tabIndex={0}
      aria-label="Ambient clock. Tap to wake."
      className="fixed inset-0 z-[90] flex cursor-pointer items-center justify-center bg-black text-white"
      onClick={onWake}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onWake(); }}
    >
      <div
        className={cn('text-center', !reduced && 'transition-transform duration-[60000ms] ease-linear')}
        style={{ transform: `translate(${x}vw, ${y}vh)` }}
      >
        <p className="font-headline text-[7rem] font-bold leading-none tabular-nums" data-testid="tablet-ambient-clock">{clockLabel(now, zone)}</p>
        <p className="mt-4 text-3xl text-white/80">{dateLabel(now, zone)}</p>
        {settings.display.weather && weather && (
          <p className="mt-3 text-2xl text-white/70" data-testid="tablet-ambient-weather">{temperatureLabel(weather)} · {weather.label}</p>
        )}
      </div>
    </div>
  );
}

export function NightDim() {
  return <div aria-hidden data-testid="tablet-night-dim" className="pointer-events-none fixed inset-0 z-[95] bg-black/60" />;
}
