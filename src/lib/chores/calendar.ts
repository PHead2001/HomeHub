/**
 * Household calendar model (H19): chores, maintenance due dates and pet
 * medication as day-keyed events, plus Week/Month grid helpers. Pure.
 */
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
};

export type CalendarMember = { uid: string; email: string; name: string };

export function choreEvents(chores: readonly ChoreRecord[], members: readonly CalendarMember[], today: string): CalendarEvent[] {
  const byEmail = new Map(members.map(member => [member.email, member]));
  return chores.flatMap(chore => {
    const day = choreDueKey(chore);
    if (!day) return [];
    const member = byEmail.get(chore.assignedToEmail);
    return [{
      id: `chore:${chore.id}`,
      kind: 'chore' as const,
      title: chore.task,
      subtitle: member?.name || chore.assignedToDisplayName || chore.assignedToEmail || 'Unassigned',
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
};

export function maintenanceEvents(items: readonly MaintenanceDue[]): CalendarEvent[] {
  return items.flatMap(item => (item.day && isDayKey(item.day) ? [{
    id: `maintenance:${item.id}`,
    kind: 'maintenance' as const,
    title: item.title,
    subtitle: item.relatedName,
    day: item.day,
    overdue: item.status === 'overdue',
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
};

/** Medication doses that were logged (pets have no medication schedule yet). */
export function medicationEvents(entries: readonly MedicationEntry[]): CalendarEvent[] {
  return entries.flatMap(entry => {
    const parsed = new Date(entry.date);
    if (Number.isNaN(parsed.getTime())) return [];
    return [{
      id: `medication:${entry.petId}:${entry.id}`,
      kind: 'medication' as const,
      title: entry.dosage ? `${entry.medication} (${entry.dosage})` : entry.medication,
      subtitle: entry.petName,
      day: dayKey(parsed),
      overdue: false,
      completed: true,
      href: `/pets/${encodeURIComponent(entry.petId)}`,
    }];
  });
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
