/**
 * Last known house rooms (H01: room states in under 1 s on a repeat visit). After each live
 * chores update the dashboard saves its `ChoreFacts` on this device; on the next visit the
 * living house draws its rooms from that snapshot the moment it mounts, and the live
 * listeners replace it as soon as they deliver (usually within half a second).
 *
 * A snapshot is used only for the same user, household and local day it was saved for, and
 * it is deleted on sign-out and whenever Auth resolves with nobody signed in, so it never
 * shows to anyone else on a shared device. It holds what Firestore's own on-device cache
 * already holds for this user (room names, counts, up to three chore titles per room).
 * No Firebase imports: safe on first-paint paths and unit-testable.
 *
 * HP-7b: a snapshot from an earlier day still gives the house its shape (`readHouseOutline`:
 * room ids and names only, never counts or titles), so a fresh day draws the right number
 * of rooms, labelled "Loading…", instead of resizing twice.
 */
import type { ChoreFacts } from './facts';

export const HOUSE_SNAPSHOT_KEY = 'homehub.house-rooms';

type Snapshot = { v: 1; uid: string; householdId: string; day: string; chores: ChoreFacts };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

const isChoreFacts = (value: unknown): value is ChoreFacts => {
  const facts = value as ChoreFacts | null;
  return Boolean(facts && Array.isArray(facts.rooms) && Array.isArray(facts.nextUp) && Array.isArray(facts.mineNext)
    && facts.rooms.every((room) => room && typeof room.id === 'string' && typeof room.name === 'string' && typeof room.status === 'string' && Array.isArray(room.chores)));
};

/** The saved rooms for exactly this user, household and day, or null. */
export function readHouseSnapshot(storage: Storage | null, uid: string, householdId: string, day: string): ChoreFacts | null {
  if (!storage || !uid || !householdId) return null;
  try {
    const parsed = JSON.parse(storage.getItem(HOUSE_SNAPSHOT_KEY) ?? 'null') as Snapshot | null;
    if (!parsed || parsed.v !== 1 || parsed.uid !== uid || parsed.householdId !== householdId || parsed.day !== day) return null;
    return isChoreFacts(parsed.chores) ? parsed.chores : null;
  } catch {
    return null;
  }
}

/** A room in the house's shape: id and name only. */
export type HouseOutlineRoom = { id: string; name: string };

/**
 * HP-7b: the room layout of the saved snapshot for this user and household, from any day,
 * without its counts or chore titles. Null when there is none.
 */
export function readHouseOutline(storage: Storage | null, uid: string, householdId: string): HouseOutlineRoom[] | null {
  if (!storage || !uid || !householdId) return null;
  try {
    const parsed = JSON.parse(storage.getItem(HOUSE_SNAPSHOT_KEY) ?? 'null') as Snapshot | null;
    if (!parsed || parsed.v !== 1 || parsed.uid !== uid || parsed.householdId !== householdId || !isChoreFacts(parsed.chores)) return null;
    const rooms = parsed.chores.rooms.map((room) => ({ id: room.id, name: room.name }));
    return rooms.length > 0 ? rooms : null;
  } catch {
    return null;
  }
}

/**
 * Saves the live rooms (one snapshot per device; a new user or household replaces it).
 * Takes the rooms as JSON (`JSON.stringify(facts.chores)`), so callers pass no live object.
 */
export function writeHouseSnapshot(storage: Storage | null, uid: string, householdId: string, day: string, choresJson: string): void {
  if (!storage || !uid || !householdId) return;
  try {
    const chores = JSON.parse(choresJson) as unknown;
    if (!isChoreFacts(chores)) return;
    const snapshot: Snapshot = { v: 1, uid, householdId, day, chores };
    storage.setItem(HOUSE_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // Storage full or blocked: the house simply waits for the live data.
  }
}

/** Deletes the snapshot (sign-out, or Auth resolved with nobody signed in). */
export function clearHouseSnapshot(storage: Storage | null): void {
  try {
    storage?.removeItem(HOUSE_SNAPSHOT_KEY);
  } catch {
    // Storage blocked: nothing was saved either.
  }
}

/** `window.localStorage`, or null where it is missing or blocked. */
export function deviceStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
