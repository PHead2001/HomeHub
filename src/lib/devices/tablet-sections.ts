// What a wall tablet's section views show (docs/modules/devices/README.md, "Tablet shell").
// Pure selectors over the UNCAPPED section facts (`sectionFacts` from useDashboardData with
// `{ sections: true }`, built with `SECTION_LIMITS`). A tablet section view never renders
// from a dashboard preview fact (`facts`, built with `PREVIEW_LIMITS`): previews show a few
// entries; a section shows everything. Shopping list items come from the list's own live
// items (`neededListItems`); household notices from the tablet's own six queries.

import type { ChoreEntry, DashboardFacts, MaintenanceItem, PetState, RoomState } from '@/lib/dashboard/facts';
import type { DeviceSections } from './types';

export type ChoresSection =
  | { kind: 'room'; room: RoomState }
  | { kind: 'today'; work: ChoreEntry[] };

/** Today's chores (overdue and due today, all of them), or one room's open chores within the week. */
export function choresSection(facts: DashboardFacts, roomId?: string): ChoresSection | null {
  const chores = facts.chores;
  if (!chores) return null;
  const room = roomId ? chores.rooms.find((r) => r.id === roomId) : undefined;
  if (room) return { kind: 'room', room };
  return { kind: 'today', work: chores.todayWork ?? [] };
}

export const petsSection = (facts: DashboardFacts): PetState[] | null => facts.pets?.pets ?? null;

export const maintenanceSection = (facts: DashboardFacts): MaintenanceItem[] | null => facts.maintenance?.items ?? null;

export const shoppingListsSection = (facts: DashboardFacts): Array<{ id: string; name: string; needed: number }> | null =>
  facts.shopping?.lists ?? null;

/** Calendar has no data of its own: every open chore due within the week and every dated maintenance item, from the sections that are on. */
export function calendarSection(facts: DashboardFacts, sections: DeviceSections): { chores: ChoreEntry[]; maintenance: MaintenanceItem[] } {
  return {
    chores: sections.chores ? facts.chores?.upcoming ?? [] : [],
    maintenance: sections.maintenance ? (facts.maintenance?.items ?? []).filter((item) => item.days !== null) : [],
  };
}

/** Names quick add matches against: every pet, and every open chore due today or within the week. */
export function quickAddTargets(facts: DashboardFacts): { pets: Array<{ id: string; name: string }>; chores: Array<{ id: string; title: string }> } {
  const chores = new Map<string, { id: string; title: string }>();
  for (const chore of [...(facts.chores?.todayWork ?? []), ...(facts.chores?.upcoming ?? [])]) chores.set(chore.id, { id: chore.id, title: chore.task });
  return { pets: (facts.pets?.pets ?? []).map((pet) => ({ id: pet.id, name: pet.name })), chores: [...chores.values()] };
}
