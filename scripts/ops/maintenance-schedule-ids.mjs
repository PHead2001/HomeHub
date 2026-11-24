// Pure decisions for backfill-maintenance-schedule-ids.mjs. No Firebase imports, so
// tests/server/maintenance-schedule-ids-backfill.test.ts covers them without an
// emulator. Plain-JavaScript twin of `legacyScheduleKey` and `withScheduleIds` in
// src/lib/maintenance/operations.ts (these scripts run without a TypeScript
// loader); that test checks the two agree case by case.
import { stableSlugify } from './occurrence-key.mjs';

/** The schedule array field of each maintenance collection. */
export const SCHEDULE_FIELDS = { 'home-assets': 'schedules', vehicles: 'serviceSchedules' };

const titleOf = (schedule, collection) => {
  const name = collection === 'home-assets' ? schedule.scheduleName : schedule.serviceName;
  if (typeof name === 'string' && name) return name;
  return collection === 'home-assets' ? 'Scheduled maintenance' : 'Scheduled service';
};

/**
 * The reminder builder's compatibility key of an id-less schedule.
 * @param {Record<string, unknown>} schedule
 * @param {number} index
 * @param {'home-assets' | 'vehicles'} collection
 */
export const legacyScheduleKey = (schedule, index, collection) => `legacy-${index}-${stableSlugify(titleOf(schedule, collection))}`;

/**
 * Every schedule without an id gets its legacy key as its id (`-2`, `-3` only if
 * that id is taken), so reminder sourceIds, deep links and open notifications stay
 * the same. Schedules with an id, and entries that are not objects, are untouched.
 * @param {unknown} list
 * @param {'home-assets' | 'vehicles'} collection
 * @returns {{ list: unknown[], assigned: number }}
 */
export function withScheduleIds(list, collection) {
  if (!Array.isArray(list)) return { list: [], assigned: 0 };
  const isSchedule = entry => Boolean(entry) && typeof entry === 'object';
  const schedules = list.filter(isSchedule);
  const taken = new Set(schedules.map(schedule => schedule.id).filter(id => typeof id === 'string' && id.length > 0));
  let assigned = 0;
  const next = schedules.map((schedule, index) => {
    if (typeof schedule.id === 'string' && schedule.id) return schedule;
    const base = legacyScheduleKey(schedule, index, collection);
    let id = base;
    for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}-${suffix}`;
    taken.add(id);
    assigned += 1;
    return { ...schedule, id };
  });
  return { list: next, assigned };
}
