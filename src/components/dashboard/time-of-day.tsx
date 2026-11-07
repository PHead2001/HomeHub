'use client';

/**
 * Time-of-day lighting (H02). The weights for dawn, day, dusk and night blend
 * continuously with the local time (recomputed every minute, so there is never a
 * jump at the hour) and are exposed as CSS custom properties that tint token
 * colors: dawn uses `--member-5` (rose), day `--primary`, dusk `--warning`
 * (amber) and night `--member-3` (indigo).
 *
 * Opt-in live weather (H02) adds rain streaks, snow or a sun glint over the shell
 * and the living house (`WeatherLayer`). Both the tint and the weather are left out
 * under reduced motion.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { DAY_PHASES, phaseWeights, windowsLit, type DayPhase } from '@/lib/dashboard/ambience';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { useLiveWeather } from '@/lib/dashboard/use-weather';
import type { WeatherEffect } from '@/lib/dashboard/weather';
import { cn } from '@/lib/utils';
import styles from './dashboard.module.css';

export type DayLight = { weights: Record<DayPhase, number>; lit: boolean; style: CSSProperties };

const lightFor = (date: Date): DayLight => {
  const weights = phaseWeights(date);
  const style = Object.fromEntries(DAY_PHASES.map((phase) => [`--tod-${phase}`, weights[phase].toFixed(3)])) as CSSProperties;
  return { weights, lit: windowsLit(date), style };
};

/** Current lighting; `null` until mounted so server and client markup match. */
export function useDayLight(): DayLight | null {
  const [light, setLight] = useState<DayLight | null>(null);
  useEffect(() => {
    const update = () => setLight(lightFor(new Date()));
    update();
    const id = window.setInterval(update, 60_000);
    return () => window.clearInterval(id);
  }, []);
  return light;
}

const EFFECT_CLASS: Record<Exclude<WeatherEffect, null>, string> = {
  rain: styles.rain,
  snow: styles.snowfall,
  glint: styles.glint,
};

/**
 * Decorative weather over the shell or the house: CSS-only, transform/opacity
 * loops of 20 s or more, very low contrast, paused while the tab is hidden. The
 * caller renders it only when motion is not reduced.
 */
export function WeatherLayer({ effect, scope }: { effect: Exclude<WeatherEffect, null>; scope: 'shell' | 'house' }) {
  return (
    <div
      aria-hidden
      data-testid={`weather-${scope}`}
      data-effect={effect}
      className={cn(styles.weather, scope === 'shell' ? styles.weatherShell : styles.weatherHouse, EFFECT_CLASS[effect])}
    />
  );
}

/** A barely-there tint behind the whole app shell, plus live weather when on. Off under reduced motion. */
export function TimeOfDayTint() {
  const light = useDayLight();
  const reduced = useReducedMotion();
  const weather = useLiveWeather();
  if (!light || reduced) return null;
  return (
    <>
      <div aria-hidden className={styles.shellTint} style={light.style} data-testid="time-of-day-tint" />
      {weather?.effect && <WeatherLayer effect={weather.effect} scope="shell" />}
    </>
  );
}
