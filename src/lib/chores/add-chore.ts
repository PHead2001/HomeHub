/**
 * Add Chore with several rooms (CH-25). Pure, so it is unit-tested.
 */

/** The chosen rooms that still exist, in the household's room order, without duplicates. */
export function chosenRoomIds(chosen: readonly string[], rooms: readonly { id: string }[]): string[] {
  const picked = new Set(chosen);
  return rooms.filter(room => picked.has(room.id)).map(room => room.id);
}

/**
 * The `roomIds` of each chore document a one-time Add Chore writes: one chore per room
 * (each room's group lists and completes its own), or one chore Around the house.
 * A repeating chore is one template with all the rooms; upkeep makes a day per room.
 */
export function oneTimeChoreRooms(roomIds: readonly string[]): string[][] {
  return roomIds.length === 0 ? [[]] : roomIds.map(roomId => [roomId]);
}
