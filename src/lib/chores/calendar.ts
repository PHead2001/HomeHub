/**
 * Household calendar model (H19): chores, maintenance due dates and pet
 * medication as day-keyed events, plus Week/Month grid helpers. Pure.
 */
import { buildMaintenanceReminders, type AssetInput, type VehicleInput } from '../../../functions/src/shared/maintenance-reminders';
import { addDays, safeTimeZone, toDay } from '../../../functions/src/shared/calendar';
import { normalizeRecurrence, occursOn, type RecurrenceInput } from '../../../functions/src/shared/recurrence';
import { choreOccurrenceKey, occurrenceChoreId, storedOccurrenceKey } from '../../../functions/src/shared/ids';
import { skippedOccurrenceKeys } from '../../../functions/src/shared/skips';
import { occurrenceNumber, rotationAnchor, rotationOf, rotationTurn } from '../../../functions/src/shared/rotation';
import { resolveAssigneeUid } from '../../../functions/src/shared/assignee';
import { publicDisplayName } from '../member-directory';
import { currentMedicationsOn, petDay, toDate, type MedicationDue as MedicationCountdown } from '../pets/care';
import {
  formatDoseTime,
  nextDueOccurrence,
  occurrencesBetween,
  occurrenceStatus,
  zonedInstant,
  takenLegacyKeys,
  type CourseView,
} from '../../../functions/src/shared/medication-schedule';
import { addDaysToKey, choreDueKey, dayFromKey, dayKey, isDayKey, weekStartKey, type ChoreRecord } from './dates';
import { DEFAULT_WEEK_STARTS_ON, type WeekStartsOn } from './week-start';
import { collapseMissedRecurring } from './list';
import { isGeneratedInstance } from './recurrence-edits';
import { readPantryBatch } from '../shopping/pantry-batches';
import { nextDueDay, type IntervalUnit } from '../../../functions/src/shared/maintenance-schedule';

/** `pantry`: an expiry date in the pantry; `care`: a pet care entry that was logged (CA-23). */
export type CalendarEventKind = 'chore' | 'maintenance' | 'medication' | 'pantry' | 'care';

export type CalendarEvent = {
  id: string;
  kind: CalendarEventKind;
  title: string;
  /** Who or what it is for: assignee, asset/vehicle name, pet name. */
  subtitle: string;
  day: string;
  /** Member the event belongs to (chores): drives the member color. */
  memberUid?: string;
  overdue: boolean;
  completed: boolean;
  href: string;
  /** Chore document id, for rescheduling. */
  choreId?: string;
  /** First room of a chore ('general' for none), for the Chores deep link and lanes. */
  roomId?: string;
  /** Repeating chores: the template, the occurrence key and the day it was generated for. */
  templateId?: string;
  occurrenceKey?: string;
  occurrenceDay?: string;
  /** Overdue rail only: how many missed days of one repeating chore this chip stands for (CA-2). */
  foldedCount?: number;
  /**
   * A future occurrence of a repeating chore that the server has not generated
   * yet (it creates the next 30), or a projected later repeat of a maintenance
   * schedule (CA-23). Drawn dashed. A planned chore moves through the server
   * (`movePlannedOccurrence`, CA-15), which creates it with its own id.
   */
  planned?: boolean;
  /**
   * An upcoming medication dose (not a logged one), with the Pets countdown's
   * state and label ("Due in 3 days"). Absent on logged doses.
   */
  medicationDue?: Pick<MedicationCountdown, 'state' | 'label'>;
};

/** `email` only matches chores written before `assignedToUid` existed; it is never shown. */
/** `kind: 'identity'` marks a kid profile, which takes no rotation turns yet (HO-15d). */
export type CalendarMember = { uid: string; name: string; email?: string; kind?: string };

/**
 * The Chores page for one chore (CA-17): filtered to its room, with the chore
 * highlighted (`?chore=`, `parseChoresFilters` in url-state.ts).
 */
export function choreHref(choreId: string, roomId = 'general'): string {
  return `/chores?room=${encodeURIComponent(roomId)}&chore=${encodeURIComponent(choreId)}`;
}

export function choreEvents(chores: readonly ChoreRecord[], members: readonly CalendarMember[], today: string): CalendarEvent[] {
  const byUid = new Map(members.map(member => [member.uid, member]));
  return chores.flatMap(chore => {
    const day = choreDueKey(chore);
    if (!day) return [];
    const assignee = resolveAssigneeUid(chore, members);
    const member = assignee ? byUid.get(assignee) : undefined;
    const roomId = chore.roomIds?.[0] || 'general';
    const occurrenceKey = storedOccurrenceKey(chore.id, chore);
    return [{
      id: `chore:${chore.id}`,
      kind: 'chore' as const,
      title: chore.task,
      subtitle: member?.name || publicDisplayName(chore.assignedToDisplayName, 'Unassigned'),
      day,
      memberUid: member?.uid,
      overdue: !chore.isCompleted && day < today,
      completed: Boolean(chore.isCompleted),
      href: choreHref(chore.id, roomId),
      choreId: chore.id,
      roomId,
      // Only days upkeep generated belong to a series (a one-time library assignment does not, CH-4).
      ...(occurrenceKey && isGeneratedInstance(chore) ? { templateId: chore.templateId as string, occurrenceKey, occurrenceDay: occurrenceKey.slice(-10) } : {}),
    }];
  });
}

export type MaintenanceDue = {
  id: string;
  title: string;
  relatedName: string;
  /** Day string (`YYYY-MM-DD`) in the household timezone. */
  day: string | null;
  status: 'upcoming' | 'due_soon' | 'due_today' | 'overdue';
  deepLink: string;
  /** Expirations that are informational only (a warranty that ran out is not "overdue"). */
  neverOverdue?: boolean;
};

export function maintenanceEvents(items: readonly MaintenanceDue[]): CalendarEvent[] {
  return items.flatMap(item => (item.day && isDayKey(item.day) ? [{
    id: `maintenance:${item.id}`,
    kind: 'maintenance' as const,
    title: item.title,
    subtitle: item.relatedName,
    day: item.day,
    overdue: item.status === 'overdue' && !item.neverOverdue,
    completed: false,
    href: item.deepLink.startsWith('/') ? item.deepLink : '/maintenance',
  }] : []));
}

export type MedicationEntry = {
  id: string;
  petId: string;
  petName: string;
  medication: string;
  dosage?: string;
  /** ISO timestamp the dose was logged for. */
  date: string;
  /** Next dose due (`yyyy-MM-dd`), as entered with the dose (legacy entries only). */
  nextDueDate?: string;
  /** A course dose (P3) or a one-off dose: never a legacy countdown. */
  courseId?: string;
  oneOff?: boolean;
};

/** A pet's medication course for the calendar (P3). */
export type CourseEntry = { petId: string; petName: string; course: CourseView };

/**
 * Medication doses that were logged, on the household day they were given
 * (PE-7b: `timeZone` is `household.timeZone`, as the Pets chips and the server
 * reminders use), not the viewer's device day.
 */
export function medicationEvents(entries: readonly MedicationEntry[], timeZone?: string | null): CalendarEvent[] {
  return entries.flatMap(entry => {
    const parsed = toDate(entry.date);
    if (!parsed) return [];
    return [{
      id: `medication:${entry.petId}:${entry.id}`,
      kind: 'medication' as const,
      title: entry.dosage ? `${entry.medication} (${entry.dosage})` : entry.medication,
      subtitle: entry.petName,
      day: petDay(parsed, timeZone),
      overdue: false,
      completed: true,
      href: `/pets/${encodeURIComponent(entry.petId)}`,
    }];
  });
}

/**
 * Upcoming medication doses: per pet, every current countdown from the Pets
 * module's own rule (`currentMedications`, which the pet card chips and, mirrored,
 * the server reminders use), on its due day. Overdue doses join the red rail.
 * `entries` must hold every medication entry of each pet, as the calendar loads.
 * `today` is the household day (`yyyy-MM-dd`, PE-7b); due days are the stored
 * household calendar days, so "Due today" matches the card and the reminder.
 */
export function medicationDueEvents(entries: readonly MedicationEntry[], today: string, courses: readonly CourseEntry[] = []): CalendarEvent[] {
  const byPet = new Map<string, MedicationEntry[]>();
  for (const entry of entries) {
    const list = byPet.get(entry.petId);
    if (list) list.push(entry);
    else byPet.set(entry.petId, [entry]);
  }
  // Legacy names a course took over (D-P8) no longer count down here.
  const taken = (petId: string) => takenLegacyKeys(courses.filter(entry => entry.petId === petId).map(entry => entry.course));
  return [...byPet.entries()].flatMap(([petId, logs]) =>
    currentMedicationsOn(logs.map(log => ({ ...log, dosage: log.dosage ?? '' })), today, taken(petId)).map(due => ({
      id: `medication-due:${petId}:${due.medication.trim().toLowerCase()}`,
      kind: 'medication' as const,
      title: due.dosage ? `${due.medication} (${due.dosage})` : due.medication,
      subtitle: logs[0].petName,
      day: due.dueDay,
      overdue: due.state === 'overdue',
      completed: false,
      href: `/pets/${encodeURIComponent(petId)}?tab=medication`,
      medicationDue: { state: due.state, label: due.label },
    })));
}

/**
 * Upcoming doses of medication courses (P3, PE-27d): each active course's next
 * due dose (an overdue one joins the red rail, wherever it falls), then every
 * scheduled occurrence in the visible range `[fromDay, untilDay]` after it, on
 * its household day, so a twice-daily course shows both doses each day. The
 * enumeration is bounded by the range alone (`occurrencesBetween`), never by a
 * count from an old outstanding dose, so a dense schedule fills every visible
 * day. A finished or ended course shows none. Occurrences come from the shared
 * schedule model, as the pet's chips and the reminders compute them.
 */
export function courseDueEvents(courses: readonly CourseEntry[], now: Date, timeZone: string | null | undefined, untilDay: string, fromDay?: string): CalendarEvent[] {
  const zone = timeZone ?? '';
  const safeZone = safeTimeZone(zone);
  const rangeEnd = zonedInstant(addDays(untilDay, 1), 0, safeZone) - 1;
  const rangeStart = zonedInstant(fromDay ?? petDay(now, timeZone), 0, safeZone) - 1;
  return courses.flatMap(({ petId, petName, course }) => {
    const next = nextDueOccurrence(course, zone);
    if (!next || !course.schedule) return [];
    const later = occurrencesBetween({ schedule: course.schedule, startDay: course.startDay, endDay: course.endDay }, Math.max(next.at, rangeStart), rangeEnd, zone);
    return [next, ...later].map((occurrence, index) => {
      const status = occurrenceStatus(occurrence, now, zone);
      const time = occurrence.time ? ` · ${formatDoseTime(occurrence.time)}` : '';
      return {
        id: `medication-due:${petId}:course:${course.id}:${occurrence.key}`,
        kind: 'medication' as const,
        title: `${course.dosage ? `${course.name} (${course.dosage})` : course.name}${time}`,
        subtitle: petName,
        day: occurrence.day,
        overdue: index === 0 && status.state === 'overdue',
        completed: false,
        href: `/pets/${encodeURIComponent(petId)}?tab=medication&dose=${encodeURIComponent(course.id)}`,
        medicationDue: { state: status.state, label: status.label },
      };
    });
  });
}

const KIND_ORDER: Record<CalendarEventKind, number> = { chore: 0, maintenance: 1, medication: 2, care: 3, pantry: 4 };

export function sortEvents(events: readonly CalendarEvent[]): CalendarEvent[] {
  return [...events].sort((a, b) =>
    a.day.localeCompare(b.day) ||
    Number(a.completed) - Number(b.completed) ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    a.title.localeCompare(b.title));
}

export function groupByDay(events: readonly CalendarEvent[]): Map<string, CalendarEvent[]> {
  const grouped = new Map<string, CalendarEvent[]>();
  for (const event of sortEvents(events)) {
    const list = grouped.get(event.day);
    if (list) list.push(event);
    else grouped.set(event.day, [event]);
  }
  return grouped;
}

/** Everything overdue, oldest first: the red rail. */
export function overdueRail(events: readonly CalendarEvent[]): CalendarEvent[] {
  return sortEvents(events.filter(event => event.overdue));
}

/** The seven days of the week containing `anchor`, from the household's first weekday (Monday unless `weekStartsOn` is 0, CA-16). */
export function weekDays(anchor: string, weekStartsOn: WeekStartsOn = DEFAULT_WEEK_STARTS_ON): string[] {
  const start = weekStartKey(anchor, weekStartsOn);
  return Array.from({ length: 7 }, (_, i) => addDaysToKey(start, i));
}

/** Weeks (from the household's first weekday) covering the month containing `anchor`. */
export function monthGrid(anchor: string, weekStartsOn: WeekStartsOn = DEFAULT_WEEK_STARTS_ON): string[][] {
  const first = dayFromKey(anchor);
  first.setDate(1);
  const firstKey = dayKey(first);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const lastKey = dayKey(last);
  const weeks: string[][] = [];
  let cursor = weekStartKey(firstKey, weekStartsOn);
  while (cursor <= lastKey) {
    weeks.push(weekDays(cursor, weekStartsOn));
    cursor = addDaysToKey(cursor, 7);
  }
  return weeks;
}

export function isSameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

export function shiftMonth(anchor: string, months: number): string {
  const date = dayFromKey(anchor);
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  return dayKey(target);
}

/**
 * Fields written when a chore moves to another day. `originalDueDate` is the
 * calendar day every view reads; `dueDate` keeps an instant at local noon so
 * older readers land on the same day.
 */
export function rescheduleFields(day: string): { dueDate: string; originalDueDate: string } {
  const noon = dayFromKey(day);
  noon.setHours(12, 0, 0, 0);
  return { dueDate: noon.toISOString(), originalDueDate: day };
}

/**
 * Every dated maintenance item, for any range. Scheduled asset and vehicle
 * services come from the shared reminder builder (all statuses). Warranty,
 * registration and inspection expirations are read straight from their fields,
 * because the builder only reports them inside its 30-day warning window. A
 * lifetime warranty never expires and is left out.
 * Retired assets and retired or sold vehicles are left out, as in Maintenance.
 */
export function maintenanceCalendarItems(
  assets: readonly AssetInput[],
  vehicles: readonly VehicleInput[],
  today: string,
  timeZone: string,
): MaintenanceDue[] {
  const scheduled: MaintenanceDue[] = buildMaintenanceReminders([...assets], [...vehicles], today, timeZone)
    .filter(r => r.group === 'scheduled' || r.group === 'vehicle_service')
    .map(r => ({ id: r.id, title: r.title, relatedName: r.relatedName, day: toDay(r.dueDate, timeZone), status: r.status, deepLink: r.deepLink }));

  const expiry = (id: string, label: string, relatedName: string, value: string | undefined, deepLink: string, neverOverdue: boolean): MaintenanceDue[] => {
    const day = toDay(value, timeZone);
    if (!day) return [];
    const past = day < today;
    return [{
      id,
      title: `${label} ${past ? 'expired' : 'expires'}`,
      relatedName,
      day,
      status: past ? 'overdue' : day === today ? 'due_today' : 'upcoming',
      deepLink,
      neverOverdue,
    }];
  };

  const expirations = [
    ...assets.filter(a => a.status !== 'retired' && a.warrantyLifetime !== true).flatMap(asset =>
      expiry(`asset-warranty-${asset.id}`, 'Warranty', asset.name, asset.warrantyExpiration, `/maintenance?asset=${encodeURIComponent(asset.id)}`, true)),
    ...vehicles.filter(v => v.status !== 'retired' && v.status !== 'sold').flatMap(vehicle => [
      ...expiry(`vehicle-registration-${vehicle.id}`, 'Registration', vehicle.nickname, vehicle.registrationExpiration, `/maintenance?vehicle=${encodeURIComponent(vehicle.id)}`, false),
      ...expiry(`vehicle-inspection-${vehicle.id}`, 'Inspection', vehicle.nickname, vehicle.inspectionExpiration, `/maintenance?vehicle=${encodeURIComponent(vehicle.id)}`, false),
    ]),
  ];
  return [...scheduled, ...expirations];
}

export type RecurringTemplate = {
  id: string;
  task: string;
  roomIds?: string[];
  assignedToUid?: string | null;
  assignedToEmail?: string | null;
  recurrence?: (RecurrenceInput & { assignedToEmail?: string }) | null;
  /** Occurrence keys of days deleted on purpose (CH-3): never planned. */
  skippedOccurrences?: string[];
  /** Rotation (CH-28): each day goes to whoever's turn it is, as upkeep assigns it. */
  rotation?: string[];
  rotationStart?: string;
};

/**
 * The document IDs the server gives a generated occurrence (one per room). They
 * are the occurrence's stable identity: the server skips an occurrence when this
 * document exists, even if the chore was moved to another day, so planning must
 * match on it too. Delegates to the server's `occurrenceChoreId` (template, room
 * and day; no assignee) and mirrors its room fallback.
 */
export function occurrenceIds(template: Pick<RecurringTemplate, 'id' | 'roomIds'>, day: string): string[] {
  return occurrences(template, day).map(occurrence => occurrence.id);
}

/**
 * Each room instance of an occurrence: its document id and its occurrence key
 * (`templateId|roomId|day`), the two identities the server checks before
 * generating it. The key also matches chores generated before member privacy
 * release E, whose ids carried the assignee.
 */
export function occurrences(template: Pick<RecurringTemplate, 'id' | 'roomIds'>, day: string): { id: string; key: string }[] {
  const rooms = Array.isArray(template.roomIds) && template.roomIds.length > 0 ? template.roomIds : ['general'];
  return rooms.map(roomId => ({ id: occurrenceChoreId(template.id, roomId, day), key: choreOccurrenceKey(template.id, roomId, day) }));
}

/**
 * Occurrences of repeating chores inside [rangeStart, rangeEnd] (from today on)
 * whose chore document does not exist yet. The server only generates the next
 * 30 occurrences, so without these a month far ahead would look empty. Uses the
 * server's recurrence rules and occurrence IDs: an occurrence whose document
 * exists (even if it was moved or completed), or whose occurrence key a chore
 * already holds (it was reassigned), is never planned again, and neither is a
 * day someone deleted (the template's skipped occurrences). One event
 * per missing room instance, as the server would create; none for non-members.
 */
export function plannedRecurringEvents(
  templates: readonly RecurringTemplate[],
  chores: readonly ChoreRecord[],
  members: readonly CalendarMember[],
  today: string,
  rangeStart: string,
  rangeEnd: string,
): CalendarEvent[] {
  const byUid = new Map(members.map(member => [member.uid, member]));
  const existing = new Set(chores.map(c => c.id));
  // A day already has its chore when any chore holds its occurrence key, whoever
  // it is assigned to now (a completed day stays done after a reassignment).
  const existingKeys = new Set(chores.flatMap(c => {
    const key = storedOccurrenceKey(c.id, c);
    return key ? [key] : [];
  }));
  const start = rangeStart > today ? rangeStart : today;
  const events: CalendarEvent[] = [];
  for (const template of templates) {
    const recurrence = normalizeRecurrence(template.recurrence, today);
    // Same assignee rules as the server (functions/src/shared/assignee.ts); a
    // rotation gives each day to whoever's turn it is (functions/src/shared/rotation.ts).
    const rotation = rotationOf(template);
    const assigneeUid = rotation.length > 0 ? null : resolveAssigneeUid(template, members);
    const member = assigneeUid ? byUid.get(assigneeUid) : undefined;
    if (!recurrence || (!member && rotation.length === 0)) continue;
    const skipped = skippedOccurrenceKeys(template);
    let number = rotation.length > 0 ? occurrenceNumber(recurrence, rotationAnchor(template), start) : 0;
    for (let day = start; day <= rangeEnd; day = addDaysToKey(day, 1)) {
      if (!occursOn(day, recurrence)) continue;
      const turn = rotation.length > 0
        ? rotationTurn(rotation, number++, uid => byUid.has(uid) && byUid.get(uid)?.kind !== 'identity')
        : null;
      const person = turn ? byUid.get(turn) : member;
      if (!person) continue;
      for (const { id, key } of occurrences(template, day)) {
        if (existing.has(id) || existingKeys.has(key) || skipped.has(key)) continue;
        const roomId = key.split('|')[1] || 'general';
        events.push({
          id: `planned:${id}`,
          kind: 'chore',
          title: template.task,
          subtitle: person.name,
          day,
          memberUid: person.uid,
          overdue: false,
          completed: false,
          href: `/chores?room=${encodeURIComponent(roomId)}`,
          planned: true,
          roomId,
          templateId: template.id,
          occurrenceKey: key,
          occurrenceDay: day,
        });
      }
    }
  }
  return events;
}


/* -------------------------------------------------------------------------- */
/* Audit section 6: rail folding, keys, filters, lanes, moves, more sources     */
/* -------------------------------------------------------------------------- */

/**
 * The red rail with missed repeats folded (CA-2): for each repeating series
 * (same template, rooms and assignee: `collapseMissedRecurring`, the rule the
 * Chores page and the dashboard use) only the latest overdue day is listed, with
 * `foldedCount` saying how many overdue days it stands for ("Empty dishwasher ×9").
 * Templates count as repeating while their recurrence normalizes, as on Chores.
 * Everything else in the rail is unchanged.
 */
export function foldedOverdueRail(
  events: readonly CalendarEvent[],
  chores: readonly ChoreRecord[],
  templates: readonly Pick<RecurringTemplate, 'id' | 'recurrence'>[],
  members: readonly CalendarMember[],
  today: string,
): CalendarEvent[] {
  const rail = overdueRail(events);
  const byId = new Map(chores.map(chore => [chore.id, chore]));
  const overdueChores = rail.flatMap(event => {
    const chore = event.kind === 'chore' && event.choreId ? byId.get(event.choreId) : undefined;
    return chore ? [chore] : [];
  });
  const recurring = new Set(templates.filter(template => normalizeRecurrence(template.recurrence, today)).map(template => template.id));
  const entries = collapseMissedRecurring(overdueChores, recurring, members);
  const hidden = new Set(entries.flatMap(entry => entry.missed.map(chore => chore.id)));
  const counts = new Map(entries.filter(entry => entry.missed.length > 0).map(entry => [entry.chore.id, entry.missed.length + 1]));
  return rail
    .filter(event => !(event.choreId && hidden.has(event.choreId)))
    .map(event => (event.choreId && counts.has(event.choreId) ? { ...event, foldedCount: counts.get(event.choreId) } : event));
}

/** How many items the rail stands for: a folded chip counts once, as on Chores (CA-2). */
export const railCount = (rail: readonly CalendarEvent[]): number => rail.length;

/**
 * Events with unique ids (CA-7): two sources can describe different things with
 * the same id (two legacy medications whose names differ only in case), which
 * would collide as React keys. Later duplicates get `#2`, `#3`; order is kept.
 */
export function withUniqueIds(events: readonly CalendarEvent[]): CalendarEvent[] {
  const seen = new Map<string, number>();
  return events.map(event => {
    const count = (seen.get(event.id) ?? 0) + 1;
    seen.set(event.id, count);
    return count === 1 ? event : { ...event, id: `${event.id}#${count}` };
  });
}

/** What the calendar shows (CA-24): kinds that are on, and optionally one member's things only. */
export type CalendarFilter = { kinds: ReadonlySet<CalendarEventKind>; memberUid: string | null };

export const ALL_KINDS: readonly CalendarEventKind[] = ['chore', 'maintenance', 'medication', 'care', 'pantry'];

/**
 * Applies the filter. "Only my stuff" (`memberUid`) keeps that member's chores;
 * house items with no person (maintenance, pets, pantry) stay, since they are
 * everyone's (a filtered view still shows the boiler service that is due).
 */
export function filterEvents(events: readonly CalendarEvent[], filter: CalendarFilter): CalendarEvent[] {
  return events.filter(event => filter.kinds.has(event.kind) &&
    (!filter.memberUid || event.kind !== 'chore' || event.memberUid === filter.memberUid));
}

export type CalendarLane = { key: string; label: string; memberUid: string | null; byDay: Map<string, CalendarEvent[]> };

/**
 * Per-person lanes for a week (CA-21, owns CH-14): one row per member (in the
 * order given, join order on the page) with that member's chores, then a
 * "House" row for everything that is nobody's (maintenance, pets, pantry and
 * unassigned chores). A member with nothing this week still gets a row, so the
 * wall always shows everyone. Events keep the order of `groupByDay`.
 */
export function laneRows(events: readonly CalendarEvent[], members: readonly CalendarMember[], days: readonly string[]): CalendarLane[] {
  const inRange = new Set(days);
  const lanes: CalendarLane[] = members.map(member => ({ key: member.uid, label: member.name, memberUid: member.uid, byDay: new Map() }));
  const house: CalendarLane = { key: 'house', label: 'House', memberUid: null, byDay: new Map() };
  const byUid = new Map(lanes.map(lane => [lane.memberUid, lane]));
  for (const event of sortEvents(events)) {
    if (!inRange.has(event.day)) continue;
    const lane = (event.kind === 'chore' && event.memberUid ? byUid.get(event.memberUid) : undefined) ?? house;
    const list = lane.byDay.get(event.day);
    if (list) list.push(event);
    else lane.byDay.set(event.day, [event]);
  }
  return [...lanes, house];
}

/**
 * Quick picks for moving a chore on touch screens (CA-11): Today, Tomorrow and
 * the next five days by weekday name, without the day it is already on. The
 * date field stays for anything further.
 */
export function moveQuickPicks(today: string, currentDay: string): { day: string; label: string }[] {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return Array.from({ length: 7 }, (_, i) => addDaysToKey(today, i))
    .filter(day => day !== currentDay)
    .map(day => {
      const offset = Math.round((dayFromKey(day).getTime() - dayFromKey(today).getTime()) / 86_400_000);
      const date = dayFromKey(day);
      return { day, label: offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : `${names[date.getDay()]} ${date.getDate()}` };
    });
}

/** The day a Month view selects after moving to another month (CA-18): today when it is in that month, else the 1st. */
export function monthSelection(monthAnchor: string, today: string): string {
  return isSameMonth(monthAnchor, today) ? today : monthAnchor;
}

/** A pantry item as the calendar reads it (CA-23). */
export type PantryExpiryInput = { id: string; name?: string; expiryDate?: string | null; packages?: number };

/**
 * Pantry documents as the calendar reads them (review finding 4): through the pantry's own
 * reader (`readPantryBatch`), so a legacy ISO timestamp expiry lands on its household day
 * and a legacy item's quantity counts as its packages, instead of being dropped.
 */
export function pantryExpiryInputs(docs: readonly { id: string; data: Record<string, unknown> }[], timeZone?: string | null): PantryExpiryInput[] {
  return docs.map(({ id, data }) => {
    const batch = readPantryBatch(id, data, timeZone);
    return { id, name: batch.name, expiryDate: batch.expiryDate, packages: batch.packages };
  });
}

/**
 * Pantry expiry dates (CA-23): one item per dated pantry entry still in stock
 * (no packages left means used up), on its expiry day, linking to the pantry.
 * Informational: an expired item is never "overdue".
 */
export function pantryExpiryEvents(items: readonly PantryExpiryInput[], today: string): CalendarEvent[] {
  return items.flatMap(item => {
    if (!isDayKey(item.expiryDate) || (typeof item.packages === 'number' && item.packages <= 0)) return [];
    const name = (item.name || 'Pantry item').trim();
    return [{
      id: `pantry:${item.id}`,
      kind: 'pantry' as const,
      title: `${name} ${item.expiryDate < today ? 'expired' : 'expires'}`,
      subtitle: 'Pantry',
      day: item.expiryDate,
      overdue: false,
      completed: false,
      href: '/shopping?tab=pantry',
    }];
  });
}

/** A pet care entry (CA-23): grooming, a vet visit, a walk. */
export type CareEntry = { id: string; petId: string; petName: string; activity?: string; date: string };

/** Pet care that was logged (CA-23), on the household day it was given, like logged doses. */
export function careEvents(entries: readonly CareEntry[], timeZone?: string | null): CalendarEvent[] {
  return entries.flatMap(entry => {
    const parsed = toDate(entry.date);
    if (!parsed) return [];
    return [{
      id: `care:${entry.petId}:${entry.id}`,
      kind: 'care' as const,
      title: (entry.activity || 'Care').trim(),
      subtitle: entry.petName,
      day: petDay(parsed, timeZone),
      overdue: false,
      completed: true,
      href: `/pets/${encodeURIComponent(entry.petId)}?tab=care`,
    }];
  });
}

type ProjectedSchedule = {
  id?: string; mode?: string; scheduleName?: string; serviceName?: string; frequencyType?: string; intervalValue?: number;
  intervalMonths?: number; nextDueDate?: string; anchor?: 'completion' | 'calendar'; anchorDay?: number; anchorMonth?: number;
  snoozedUntil?: string; snoozedFrom?: string;
};
type ProjectedAsset = { id: string; name: string; status?: string; schedules?: ProjectedSchedule[] };
type ProjectedVehicle = { id: string; nickname: string; status?: string; serviceSchedules?: ProjectedSchedule[] };

const UNITS: ReadonlySet<string> = new Set(['days', 'weeks', 'months', 'years']);
/** At most this many projected repeats per schedule (a daily schedule over a month view). */
const MAX_PROJECTED = 62;

/**
 * Later repeats of maintenance schedules (CA-23), dashed like planned chores:
 * after each schedule's next due day (already on the calendar from the reminder
 * builder), the following due days if each is done on its day (`nextDueDay`,
 * the rule completion uses), inside `[rangeStart, rangeEnd]`. Checklists,
 * schedules without a date or interval, and retired, sold or retired vehicles
 * have none.
 */
export function projectedMaintenanceEvents(
  assets: readonly ProjectedAsset[],
  vehicles: readonly ProjectedVehicle[],
  timeZone: string,
  rangeStart: string,
  rangeEnd: string,
): CalendarEvent[] {
  const project = (owner: string, ownerName: string, schedule: ProjectedSchedule, index: number, unit: string | undefined, value: number | undefined, href: string): CalendarEvent[] => {
    if (schedule.mode === 'checklist' || !unit || !UNITS.has(unit) || typeof value !== 'number' || !(value > 0)) return [];
    let due = toDay(schedule.nextDueDate, timeZone);
    if (!due) return [];
    const events: CalendarEvent[] = [];
    for (let i = 0; i < 400 && events.length < MAX_PROJECTED; i++) {
      // The first completion is of the schedule as stored, snooze included (as
      // `nextDueAfterCompletion` does: a snoozed calendar schedule keeps its real cycle);
      // completion ends a snooze, so later steps have none.
      const snooze = i === 0 ? { snoozedUntil: schedule.snoozedUntil, snoozedFrom: schedule.snoozedFrom } : {};
      const next = nextDueDay({ unit: unit as IntervalUnit, value, anchor: schedule.anchor, anchorDay: schedule.anchorDay, anchorMonth: schedule.anchorMonth, nextDueDate: due, ...snooze }, due);
      if (!next || next <= due || next > rangeEnd) break;
      due = next;
      if (due < rangeStart) continue;
      events.push({
        id: `maintenance-projected:${owner}:${schedule.id ?? index}:${due}`,
        kind: 'maintenance',
        title: (schedule.scheduleName || schedule.serviceName || 'Maintenance').trim(),
        subtitle: ownerName,
        day: due,
        overdue: false,
        completed: false,
        href,
        planned: true,
      });
    }
    return events;
  };
  return [
    ...assets.filter(asset => asset.status !== 'retired').flatMap(asset => (asset.schedules ?? []).flatMap((schedule, index) =>
      project(asset.id, asset.name, schedule, index, schedule.frequencyType, schedule.intervalValue, `/maintenance?asset=${encodeURIComponent(asset.id)}`))),
    ...vehicles.filter(vehicle => vehicle.status !== 'retired' && vehicle.status !== 'sold').flatMap(vehicle => (vehicle.serviceSchedules ?? []).flatMap((schedule, index) =>
      project(vehicle.id, vehicle.nickname, schedule, index, schedule.intervalMonths ? 'months' : undefined, schedule.intervalMonths, `/maintenance?vehicle=${encodeURIComponent(vehicle.id)}`))),
  ];
}

/**
 * What skipping days of repeating chores writes (CA-27, the skip mechanism of CH-3):
 * per template, the occurrence keys to add to `skippedOccurrences` (today or later
 * only: upkeep never generates an earlier day), and the open generated chores to
 * delete (sent to `skipChoreDaysAction`, which re-checks each one on the server). Planned
 * days need only the key. Completed chores and one-time chores are never skipped.
 */
export function skipPlan(events: readonly CalendarEvent[], today: string): { keys: Map<string, string[]>; items: { templateId: string; key: string; choreId?: string }[] } {
  const keys = new Map<string, string[]>();
  const items: { templateId: string; key: string; choreId?: string }[] = [];
  for (const event of events) {
    if (event.kind !== 'chore' || event.completed || !event.templateId || !event.occurrenceKey || !event.occurrenceDay || event.occurrenceDay < today) continue;
    const list = keys.get(event.templateId) ?? [];
    if (!list.includes(event.occurrenceKey)) list.push(event.occurrenceKey);
    keys.set(event.templateId, list);
    // The server re-reads each chore and deletes it only while it is still this open occurrence.
    items.push({ templateId: event.templateId, key: event.occurrenceKey, ...(!event.planned && event.choreId ? { choreId: event.choreId } : {}) });
  }
  return { keys, items };
}

/** The repeating chores to skip while the household is away (CA-27): every open or planned day from `from` to `to`. */
export function awayEvents(events: readonly CalendarEvent[], from: string, to: string): CalendarEvent[] {
  return events.filter(event => event.kind === 'chore' && !event.completed && Boolean(event.templateId && event.occurrenceKey) && event.day >= from && event.day <= to);
}

/** A template's skipped keys without `remove` (Undo of a skip). */
export function withoutSkippedOccurrences(existing: unknown, remove: readonly string[]): string[] {
  const drop = new Set(remove);
  return Array.isArray(existing) ? existing.filter((key): key is string => typeof key === 'string' && !drop.has(key)) : [];
}
