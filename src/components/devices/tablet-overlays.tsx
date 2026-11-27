'use client';

// The ambient screen and night dimming (design 14.3, 14.4; D-T6, D-T1, WT-14f/g).
//
// Ambient: after the tablet's ambient time without input, a basic clock screen: the time,
// the date, the weather when the record turns it on, and only what needs doing as
// household counts (HP-16: "2 chores overdue", `ambient-alerts.ts`), and (SL-23) the house
// outline with the household's pets moving slowly (at the bowl when a meal is due, resting
// without a claim when their feeding is unknown) and the next-up line ("Next up: Water the
// plants · Today"), from `ambient-scene.ts`. Never a member's name; sections switched off
// on the tablet show nothing. The house is decoration (aria-hidden, no links, no
// pointer events), so a tap still only wakes. It drifts slowly against burn-in: with
// reduced motion it moves once a minute without animation. A tap wakes it and never acts
// (the tap lands on this screen, not on what is under it).
//
// Night dimming: during the household's quiet hours a dark layer lies over the screen.
// It never takes a touch (pointer events pass through).

import { useEffect, useState } from 'react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { useLiveWeather } from '@/lib/dashboard/use-weather';
import { temperatureLabel } from '@/lib/dashboard/weather';
import { ambientAlerts } from '@/lib/devices/ambient-alerts';
import { ambientNextUp, ambientPetPosition, ambientPets, type AmbientPet } from '@/lib/devices/ambient-scene';
import { LOGO_EAVE_NODES, LOGO_HUB_NODE, LOGO_ROOF_PATH, LOGO_STROKE_WIDTH, LOGO_VIEWBOX, LOGO_WALLS_PATH } from '@/components/brand/logo-artwork';
import { Cat, Dog, PawPrint } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTablet } from './tablet-context';
import { clockLabel, dateLabel } from './tablet-top-bar';

/** Drift positions (percent offsets), one step a minute. */
const DRIFT = [[0, 0], [6, -4], [-5, 5], [4, 6], [-6, -3], [3, -6], [-3, 3]] as const;

export function AmbientScreen({ now, onWake }: { now: Date; onWake: () => void }) {
  const { household, settings, data, notices } = useTablet();
  const alerts = ambientAlerts(data.facts, settings.sections, notices.length);
  const pets = ambientPets(data.facts, settings.sections);
  const nextUp = ambientNextUp(data.facts, settings.sections);
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
        <AmbientHouse pets={pets} step={step} reduced={reduced} />
        <p className="font-headline text-[7rem] font-bold leading-none tabular-nums" data-testid="tablet-ambient-clock">{clockLabel(now, zone)}</p>
        <p className="mt-4 text-3xl text-white/80">{dateLabel(now, zone)}</p>
        {settings.display.weather && weather && (
          <p className="mt-3 text-2xl text-white/70" data-testid="tablet-ambient-weather">{temperatureLabel(weather)} · {weather.label}</p>
        )}
        {nextUp && (
          <p className="mt-6 text-2xl text-white/80" data-testid="tablet-ambient-next-up">{nextUp}</p>
        )}
        {alerts.length > 0 && (
          <ul className="mt-8 space-y-2 text-2xl font-semibold text-amber-200" data-testid="tablet-ambient-alerts">
            {alerts.map((alert) => <li key={alert}>{alert}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}

const PET_ICON = { dog: Dog, cat: Cat, other: PawPrint } as const;

/**
 * SL-23: the house outline (the HomeHub mark, drawn large and dim) with the household's
 * pets. Wandering pets move to a new spot with each drift step over the whole minute;
 * under reduced motion they jump without animation. Decoration only.
 */
function AmbientHouse({ pets, step, reduced }: { pets: AmbientPet[]; step: number; reduced: boolean }) {
  return (
    <div aria-hidden className="pointer-events-none relative mx-auto mb-6 h-44 w-44" data-testid="tablet-ambient-house">
      <svg viewBox={LOGO_VIEWBOX} className="absolute inset-0 h-full w-full text-white/25" fill="none">
        <path d={LOGO_WALLS_PATH} stroke="currentColor" strokeWidth={LOGO_STROKE_WIDTH / 2} strokeLinecap="round" strokeLinejoin="round" />
        <path d={LOGO_ROOF_PATH} stroke="currentColor" strokeWidth={LOGO_STROKE_WIDTH / 2} strokeLinecap="round" strokeLinejoin="round" />
        {[...LOGO_EAVE_NODES, LOGO_HUB_NODE].map((node) => <circle key={node.cx} fill="currentColor" {...node} />)}
      </svg>
      {pets.map((pet, index) => {
        const [x, y] = ambientPetPosition(pet, index, step);
        const Icon = PET_ICON[pet.kind];
        return (
          <Icon
            key={pet.id}
            data-testid="tablet-ambient-pet"
            data-spot={pet.spot}
            className={cn('absolute h-7 w-7 -translate-x-1/2 -translate-y-1/2', pet.spot === 'bowl' ? 'text-amber-200/80' : 'text-white/60', !reduced && 'transition-[left,top] duration-[60000ms] ease-linear')}
            style={{ left: `${x}%`, top: `${y}%` }}
          />
        );
      })}
    </div>
  );
}

export function NightDim() {
  return <div aria-hidden data-testid="tablet-night-dim" className="pointer-events-none fixed inset-0 z-[95] bg-black/60" />;
}
