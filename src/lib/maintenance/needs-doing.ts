// The Overview's "Needs doing" list (MA-12, MA-14, MA-26): what needs a person
// now, in one place. Reminders that are overdue (or an expired registration or
// inspection), due today or due soon come first, by urgency, then snoozed ones
// (muted, "Snoozed until …"); next to them, the assets and vehicles someone
// flagged "Needs attention", each labelled as a flag. That is the one meaning
// of "attention" on the page: the queue holds overdue reminders plus manual
// flags, labelled as such. Pure, unit tested (tests/unit/maintenance-needs-doing.test.ts).
//
// A room name (MA-26: `?location=` today, a registered tablet's room later)
// keeps only the home assets in that room (`matchesRoom`); vehicles have no
// room and leave the list while a room is chosen.
import type { MaintenanceReminder } from '../../../functions/src/shared/maintenance-reminders';
import type { HomeAsset, Vehicle } from '../types';
import { matchesRoom } from './filters';
import { reminderGroups, type ReminderGroupKey } from './reminder-groups';

/** The reminder groups the list shows, in order. Upcoming work is in Coming up instead. */
export const NEEDS_DOING_GROUPS: readonly ReminderGroupKey[] = ['overdue', 'due_today', 'due_soon', 'snoozed'];

export type FlaggedItem = {
  targetType: 'home_asset' | 'vehicle';
  id: string;
  name: string;
  /** "HVAC · Basement" or "2019 Honda Civic". */
  detail: string;
  brand?: string;
};

export type NeedsDoing = {
  /** Reminders by urgency: overdue or expired, due today, due soon, then snoozed. */
  reminders: MaintenanceReminder[];
  /** Assets and vehicles flagged "Needs attention". */
  flagged: FlaggedItem[];
  /** Reminders that need doing now (not snoozed) plus flags: the one "attention" number. */
  count: number;
};

/**
 * Builds the list. An ended warranty has nothing left to do and is left out
 * (it stays on the Reminders tab); an expiring one, an expired registration or
 * inspection and overdue work are in.
 */
export function needsDoing(input: {
  reminders: readonly MaintenanceReminder[];
  assets: readonly HomeAsset[];
  vehicles: readonly Vehicle[];
  roomName?: string | null;
}): NeedsDoing {
  const room = input.roomName?.trim() ? input.roomName : null;
  const assetsById = new Map(input.assets.map((asset) => [asset.id, asset]));
  const inRoom = (reminder: MaintenanceReminder) => {
    if (!room) return true;
    if (reminder.targetType !== 'home_asset') return false;
    return matchesRoom(assetsById.get(reminder.targetId)?.location, room);
  };
  const { groups } = reminderGroups(input.reminders.filter(inRoom));
  const shown = groups
    .filter((group) => NEEDS_DOING_GROUPS.includes(group.key))
    .map((group) => ({ key: group.key, reminders: group.reminders.filter((reminder) => !(reminder.group === 'warranty' && reminder.status === 'overdue')) }));
  const reminders = shown.flatMap((group) => group.reminders);
  const flagged: FlaggedItem[] = [
    ...input.assets
      .filter((asset) => asset.status === 'needs_attention' && (!room || matchesRoom(asset.location, room)))
      .map((asset) => ({
        targetType: 'home_asset' as const,
        id: asset.id,
        name: asset.name,
        detail: [asset.category, asset.location].filter(Boolean).join(' · '),
        brand: asset.brand,
      })),
    ...(room ? [] : input.vehicles
      .filter((vehicle) => vehicle.status === 'needs_attention')
      .map((vehicle) => ({
        targetType: 'vehicle' as const,
        id: vehicle.id,
        name: vehicle.nickname,
        detail: [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Vehicle',
        brand: vehicle.make,
      }))),
  ];
  const now = shown.filter((group) => group.key !== 'snoozed').reduce((total, group) => total + group.reminders.length, 0);
  return { reminders, flagged, count: now + flagged.length };
}
