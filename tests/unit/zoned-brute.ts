/**
 * Brute-force household wall time resolution for tests: scans the day minute
 * by minute, independent of the resolver under test.
 */
import assert from 'node:assert/strict';
import { localDay, localMinutes } from '../../functions/src/shared/calendar';

const MIN = 60_000;
export const pad = (n: number) => String(n).padStart(2, '0');
export const hhmm = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
const wall = (at: number, zone: string) => ({ day: localDay(new Date(at), zone), minutes: localMinutes(new Date(at), zone) });
const offsetOf = (at: number, w: { day: string; minutes: number }) => Date.parse(`${w.day}T00:00:00Z`) + w.minutes * MIN - Math.floor(at / MIN) * MIN;
const offsetAt = (at: number, zone: string) => offsetOf(at, wall(at, zone));

/** The documented rule, by brute force: the first instant reading that wall time; in a gap, the time moved forward by the gap. */
export function bruteDay(day: string, zone: string): (minutes: number) => number {
  const start = Date.parse(`${day}T00:00:00Z`) - 16 * 60 * MIN;
  const byWall = new Map<number, number[]>();
  let transition: number | null = null;
  let previous: { offset: number; day: string } | null = null;
  for (let at = start; at <= start + 56 * 60 * MIN; at += MIN) {
    const w = wall(at, zone);
    const offset = offsetOf(at, w);
    // An offset change touching this local day: remember the offset before it.
    if (previous && offset !== previous.offset && previous.day <= day && w.day >= day) transition = previous.offset;
    previous = { offset, day: w.day };
    if (w.day !== day) continue;
    const list = byWall.get(w.minutes) ?? [];
    list.push(at);
    byWall.set(w.minutes, list);
  }
  return (minutes) => {
    const found = byWall.get(minutes);
    if (found) return Math.min(...found);
    // A gap: moved forward by the gap = the wall time read with the offset before the transition.
    assert.ok(transition !== null, `${zone} ${day} ${hhmm(minutes)}: a missing time only in a gap`);
    return Date.parse(`${day}T00:00:00Z`) + minutes * MIN - transition!;
  };
}

/** Every 2026 offset change of a zone: the local day, and the wall times just before and after. */
const transitionCache = new Map<string, { day: string; before: number; after: number }[]>();
export function transitions(zone: string) {
  const cached = transitionCache.get(zone);
  if (cached) return cached;
  const out: { day: string; before: number; after: number }[] = [];
  let previous = offsetAt(Date.parse('2026-01-01T00:00:00Z'), zone);
  for (let at = Date.parse('2026-01-01T00:00:00Z'); at < Date.parse('2027-01-01T00:00:00Z'); at += 60 * MIN) {
    const offset = offsetAt(at, zone);
    if (offset === previous) continue;
    // Narrow down to the minute.
    let t = at - 60 * MIN;
    while (offsetAt(t, zone) === previous) t += MIN;
    out.push({ day: localDay(new Date(t), zone), before: localMinutes(new Date(t - MIN), zone) + 1, after: localMinutes(new Date(t), zone) });
    previous = offset;
  }
  transitionCache.set(zone, out);
  return out;
}

const dayCache = new Map<string, (minutes: number) => number>();
/** The brute-force instant of `HH:MM` on a household day (cached per zone and day). */
export function bruteInstant(day: string, time: string, zone: string): number {
  const key = `${zone} ${day}`;
  let resolve = dayCache.get(key);
  if (!resolve) {
    resolve = bruteDay(day, zone);
    dayCache.set(key, resolve);
  }
  return resolve(Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)));
}
