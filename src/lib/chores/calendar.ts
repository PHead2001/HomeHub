/**
 * Household calendar model (H19): chores, maintenance due dates and pet
 * medication as day-keyed events, plus Week/Month grid helpers. Pure.
 */
import { buildMaintenanceReminders, type AssetInput, type VehicleInput } from '../../../functions/src/shared/maintenance-reminders';
import { toDay } from '../../../functions/src/shared/calendar';
import { normalizeRecurrence, occursOn, type RecurrenceInput } from '../../../functions/src/shared/recurrence';
import { choreOccurrenceKey, occurrenceChoreId, storedOccurrenceKey } from '../../../functions/src/shared/ids';
import { resolveAssigneeUid } from '../../../functions/src/shared/assignee';
import { publicDisplayName } from '../member-directory';
import { currentMedicationsOn, petDay, toDate, type MedicationDue as MedicationCountdown } from '../pets/care';
import { addDaysToKey, choreDueKey, dayFromKey, dayKey, isDayKey, weekStartKey, type ChoreRecord } from './dates';

export type CalendarEventKind = 'chore' | 'maintenance' | 'medication';

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
  /**
   * A future occurrence of a repeating chore that the server has not generated
   * yet (it creates the next 30). Shown so far-off weeks are complete; not movable.
   */
  planned?: boolean;
  /**
   * An upcoming medication dose (not a logged one), with the Pets countdown's
   * state and label ("Due in 3 days"). Absent on logged doses.
   */
  medicationDue?: Pick<MedicationCountdown, 'state' | 'label'>;
};

/** `email` only matches chores written before `assignedToUid` existed; it is never shown. */
export type CalendarMember = { uid: string; name: string; email?: string };

export function choreEvents(chores: readonly ChoreRecord[], members: readonly CalendarMember[], today: string): CalendarEvent[] {
  const byUid = new Map(members.map(member => [member.uid, member]));
  return chores.flatMap(chore => {
    const day = choreDueKey(chore);
    if (!day) return [];
    const assignee = resolveAssigneeUid(chore, members);
    const member = assignee ? byUid.get(assignee) : undefined;
    return [{
      id: `chore:${chore.id}`,
      kind: 'chore' as const,
      title: chore.task,
      subtitle: member?.name || publicDisplayName(chore.assignedToDisplayName, 'Unassigned'),
      day,
      memberUid: member?.uid,
      overdue: !chore.isCompleted && day < today,
      completed: Boolean(chore.isCompleted),
      href: '/chores',
      choreId: chore.id,
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
  /** Next dose due (`yyyy-MM-dd`), as entered with the dose. */
  nextDueDate?: string;
};

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
export function medicationDueEvents(entries: readonly MedicationEntry[], today: string): CalendarEvent[] {
  const byPet = new Map<string, MedicationEntry[]>();
  for (const entry of entries) {
    const list = byPet.get(entry.petId);
    if (list) list.push(entry);
    else byPet.set(entry.petId, [entry]);
  }
  return [...byPet.entries()].flatMap(([petId, logs]) =>
    currentMedicationsOn(logs.map(log => ({ ...log, dosage: log.dosage ?? '' })), today).map(due => ({
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

const KIND_ORDER: Record<CalendarEventKind, number> = { chore: 0, maintenance: 1, medication: 2 };

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

/** The seven days (Monday first) of the week containing `anchor`. */
export function weekDays(anchor: string): string[] {
  const start = weekStartKey(anchor);
  return Array.from({ length: 7 }, (_, i) => addDaysToKey(start, i));
}

/** Weeks (Monday first) covering the month containing `anchor`. */
export function monthGrid(anchor: string): string[][] {
  const first = dayFromKey(anchor);
  first.setDate(1);
  const firstKey = dayKey(first);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const lastKey = dayKey(last);
  const weeks: string[][] = [];
  let cursor = weekStartKey(firstKey);
  while (cursor <= lastKey) {
    weeks.push(weekDays(cursor));
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
 * because the builder only reports them inside its 14-day reminder window.
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
    ...assets.filter(a => a.status !== 'retired').flatMap(asset =>
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
 * already holds (it was reassigned), is never planned again. One event
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
    // Same assignee rules as the server (functions/src/shared/assignee.ts).
    const assigneeUid = resolveAssigneeUid(template, members);
    const member = assigneeUid ? byUid.get(assigneeUid) : undefined;
    if (!recurrence || !member) continue;
    for (let day = start; day <= rangeEnd; day = addDaysToKey(day, 1)) {
      if (!occursOn(day, recurrence)) continue;
      for (const { id, key } of occurrences(template, day)) {
        if (existing.has(id) || existingKeys.has(key)) continue;
        events.push({
          id: `planned:${id}`,
          kind: 'chore',
          title: template.task,
          subtitle: member.name,
          day,
          memberUid: member.uid,
          overdue: false,
          completed: false,
          href: '/chores',
          planned: true,
        });
      }
    }
  }
  return events;
}
