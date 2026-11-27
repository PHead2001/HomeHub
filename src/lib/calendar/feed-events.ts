/**
 * What the household's phone calendar feed lists (audit CA-25). Pure: the server
 * (`src/lib/server/calendar-feed.ts`) reads the household with the Admin SDK and
 * passes the documents here; `buildIcs` turns the result into text.
 *
 * The feed reuses the calendar page's own model (`src/lib/chores/calendar.ts`), so a
 * phone shows what `/calendar` shows: open chores (overdue ones from the last
 * `FEED_PAST_DAYS` days), planned repeats, maintenance due dates, expirations and
 * projected repeats, upcoming medication doses and pantry expiry dates, up to
 * `FEED_FUTURE_DAYS` ahead. Done chores and logged doses or care are history and are
 * left out. Days are the household's (server code runs in UTC, so a chore without
 * its stored calendar day is placed with `householdDueDay`). Names are public names;
 * no email ever reaches the feed.
 */
import { safeTimeZone } from '../../../functions/src/shared/calendar';
import { householdDueDay, householdToday } from '../chores/completion';
import { addDaysToKey, isDayKey, type ChoreRecord } from '../chores/dates';
import {
  choreEvents, courseDueEvents, maintenanceCalendarItems, maintenanceEvents, medicationDueEvents, pantryExpiryEvents,
  plannedRecurringEvents, projectedMaintenanceEvents, sortEvents, withUniqueIds,
  type CalendarEvent, type CalendarMember, type CourseEntry, type MedicationEntry, type PantryExpiryInput, type RecurringTemplate,
} from '../chores/calendar';
import type { AssetInput, VehicleInput } from '../../../functions/src/shared/maintenance-reminders';
import type { IcsEvent } from './ics';

export const FEED_PAST_DAYS = 14;
export const FEED_FUTURE_DAYS = 90;

export type FeedSources = {
  timeZone: unknown;
  members: readonly CalendarMember[];
  chores: readonly ChoreRecord[];
  templates: readonly RecurringTemplate[];
  assets: readonly AssetInput[];
  vehicles: readonly VehicleInput[];
  medication: readonly MedicationEntry[];
  courses: readonly CourseEntry[];
  pantry: readonly PantryExpiryInput[];
};

const CATEGORY: Record<CalendarEvent['kind'], string> = {
  chore: 'Chores', maintenance: 'Maintenance', medication: 'Pets', care: 'Pets', pantry: 'Pantry',
};

/** The feed line for one item: "Dishes (Sam)", "Medication due: Ear drops (Maple)". */
export function feedSummary(event: CalendarEvent): string {
  const who = event.subtitle ? ` (${event.subtitle})` : '';
  if (event.kind === 'medication') return `Medication due: ${event.title}${who}`;
  if (event.kind === 'maintenance') return `${event.title}${who}`;
  if (event.kind === 'pantry') return event.title;
  return `${event.title}${who}`;
}

function feedDescription(event: CalendarEvent): string | undefined {
  if (event.kind === 'chore' && event.planned) return 'Repeating chore (planned).';
  if (event.kind === 'chore' && event.overdue) return 'Overdue.';
  if (event.kind === 'maintenance' && event.planned) return 'Projected repeat of a maintenance schedule.';
  if (event.medicationDue) return event.medicationDue.label;
  return undefined;
}

export function feedEvents(sources: FeedSources, now: Date): IcsEvent[] {
  const timeZone = safeTimeZone(sources.timeZone);
  const today = householdToday(now, timeZone);
  const from = addDaysToKey(today, -FEED_PAST_DAYS);
  const until = addDaysToKey(today, FEED_FUTURE_DAYS);
  // A chore without its stored calendar day is placed on the household's day, never the server's.
  const chores: ChoreRecord[] = sources.chores.map(chore => (isDayKey(chore.originalDueDate) ? chore : { ...chore, originalDueDate: householdDueDay(chore, timeZone) ?? '' }));
  const events = [
    ...choreEvents(chores.filter(chore => !chore.isCompleted), sources.members, today),
    ...plannedRecurringEvents(sources.templates, chores, sources.members, today, today, until),
    ...maintenanceEvents(maintenanceCalendarItems(sources.assets, sources.vehicles, today, timeZone)),
    ...projectedMaintenanceEvents(sources.assets, sources.vehicles, timeZone, today, until),
    ...medicationDueEvents(sources.medication, today, sources.courses),
    ...courseDueEvents(sources.courses, now, timeZone, until, today),
    ...pantryExpiryEvents(sources.pantry, today),
  ].filter(event => event.day >= from && event.day <= until);
  return withUniqueIds(sortEvents(events)).map(event => ({
    uid: event.id,
    day: event.day,
    summary: feedSummary(event),
    ...(feedDescription(event) ? { description: feedDescription(event) } : {}),
    url: event.href,
    categories: [CATEGORY[event.kind]],
  }));
}
