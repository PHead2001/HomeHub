'use client';

/**
 * Time-of-day lighting (H02). The weights for dawn, day, dusk and night blend
 * continuously with the local time (recomputed every minute, so there is never a
 * jump at the hour) and are exposed as CSS custom properties that tint token
 * colors: dawn uses `--member-5` (rose), day `--primary`, dusk `--warning`
 * (amber) and night `--member-3` (indigo).
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { DAY_PHASES, phaseWeights, windowsLit, type DayPhase } from '@/lib/dashboard/ambience';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
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

/** A barely-there tint behind the whole app shell. Off under reduced motion. */
export function TimeOfDayTint() {
  const light = useDayLight();
  const reduced = useReducedMotion();
  if (!light || reduced) return null;
  return <div aria-hidden className={styles.shellTint} style={light.style} data-testid="time-of-day-tint" />;
}
