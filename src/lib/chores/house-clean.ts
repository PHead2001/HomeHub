/**
 * "House is clean" (H05) helpers: which rooms the moment shows, the order they
 * sparkle in, and the once-per-day key. Pure, so they are unit tested.
 */

export type CleanRoom = { id: string; name: string; icon: string; workedToday: boolean };

/** The whole moment, including the exit, stays inside the 1.5 s celebration budget. */
export const HOUSE_CLEAN_MS = 1500;
/** Rooms drawn in the house; more would be too small to read on a phone. */
export const HOUSE_CLEAN_MAX_ROOMS = 8;

/** localStorage key: the moment fires at most once per household per day on a device. */
export function houseCleanStorageKey(householdId: string, day: string): string {
  return `homehub.houseClean.${householdId}.${day}`;
}

/**
 * The household's rooms for the moment: rooms worked in today first (they sparkle
 * first), then the rest by name, capped at `HOUSE_CLEAN_MAX_ROOMS`. With no rooms
 * set up, a single "Home" room stands for the house.
 */
export function cleanHouseRooms(
  rooms: ReadonlyArray<{ id: string; name: string; icon?: string }>,
  workedIn: ReadonlySet<string>,
): CleanRoom[] {
  if (rooms.length === 0) return [{ id: 'home', name: 'Home', icon: 'Home', workedToday: true }];
  return [...rooms]
    .map(room => ({ id: room.id, name: room.name, icon: room.icon || 'Home', workedToday: workedIn.has(room.id) }))
    .sort((a, b) => Number(b.workedToday) - Number(a.workedToday) || a.name.localeCompare(b.name))
    .slice(0, HOUSE_CLEAN_MAX_ROOMS);
}

/**
 * Seconds before room `index` (of `count`) sparkles. Rooms start after a 150 ms
 * entrance and are spread over at most 600 ms, so the last sparkle (350 ms) ends
 * by 1.1 s and the moment can leave at 1.5 s.
 */
export function sparkleDelay(index: number, count: number): number {
  if (count <= 1) return 0.15;
  const step = Math.min(0.12, 0.6 / (count - 1));
  return Math.round((0.15 + index * step) * 1000) / 1000;
}
