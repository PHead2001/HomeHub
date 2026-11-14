/**
 * Who may do what with a pet's profile, notes and weights (P5; design
 * requirement R5): one table, read by the Pets UI to show controls, by the
 * server action that deletes a pet (`src/app/pets/actions.ts`) and, later, by the
 * registered-tablet device gate (F4), which reuses these constants and author
 * rules instead of a separate mapping. Firestore rules enforce the same
 * permissions (`firestore.rules`, pets, `notes`, `weights`);
 * `tests/unit/pets-owner-additions.test.ts` checks this table against the rules.
 *
 * An actor needs at least one listed permission. Some actions also allow the
 * entry's author (see `mayEditNote`, `mayDeleteNote`, `mayDeleteWeight`).
 * Medication actions live in `medication-permissions.ts` (P3).
 */
import type { HouseholdPermission } from '../types';

export const PET_ACTION_PERMISSIONS = {
  /** Add a note (pinned or a dated behaviour entry). */
  'pets.note.add': ['pets.addLogs'],
  /** Edit a note's text or tag, pin, unpin or move a pinned note first; the author (with `pets.addLogs`) may too. */
  'pets.note.edit': ['pets.editProfiles'],
  /** Delete a note at any time; its author (with `pets.addLogs`) may within 10 minutes of writing it. */
  'pets.note.delete': ['pets.deleteLogs'],
  /** Log a weight. */
  'pets.weight.add': ['pets.addLogs'],
  /** Delete a weight at any time; its author (with `pets.addLogs`) may within 10 minutes. */
  'pets.weight.delete': ['pets.deleteLogs'],
  /** Rename a pet, change its photo, vet contact, weight unit or plan. */
  'pets.profile.edit': ['pets.editProfiles'],
  /** Delete a pet and everything under it (server action, D-P12). */
  'pets.profile.delete': ['pets.editProfiles'],
} as const satisfies Record<string, readonly HouseholdPermission[]>;

export type PetAction = keyof typeof PET_ACTION_PERMISSIONS;

export type ActorPermissions = Partial<Record<HouseholdPermission, boolean>>;

/** Whether effective permissions allow a pet action (at least one listed permission). */
export function mayPet(action: PetAction, permissions: ActorPermissions): boolean {
  return PET_ACTION_PERMISSIONS[action].some((permission) => permissions[permission] === true);
}

/** The author's window for deleting their own note or weight (as feedings, PE-2). */
export const AUTHOR_DELETE_WINDOW_MS = 10 * 60_000;

type Authored = { loggedByUid?: string | null; loggedAt?: Date | null };
type Actor = { uid: string | null | undefined; permissions: ActorPermissions };

const isAuthor = (entry: Authored, actor: Actor) => Boolean(actor.uid && entry.loggedByUid === actor.uid);

/** Editing or (un)pinning a note: `pets.editProfiles`, or its author with `pets.addLogs` (D-P11). */
export function mayEditNote(note: Authored, actor: Actor): boolean {
  return mayPet('pets.note.edit', actor.permissions) || (isAuthor(note, actor) && actor.permissions['pets.addLogs'] === true);
}

/** Within the author's 10 minutes (server time of the write; an unknown time is outside). */
export function withinAuthorWindow(entry: Authored, now: Date): boolean {
  return entry.loggedAt instanceof Date && now.getTime() < entry.loggedAt.getTime() + AUTHOR_DELETE_WINDOW_MS;
}

/**
 * Deleting a note: `pets.deleteLogs`, or its author with `pets.addLogs` within
 * 10 minutes (D-P11); a pinned note is profile data, so `pets.editProfiles` may
 * remove it too.
 */
export function mayDeleteNote(note: Authored & { pinned?: boolean }, actor: Actor, now: Date): boolean {
  if (mayPet('pets.note.delete', actor.permissions)) return true;
  if (note.pinned && actor.permissions['pets.editProfiles'] === true) return true;
  return isAuthor(note, actor) && actor.permissions['pets.addLogs'] === true && withinAuthorWindow(note, now);
}

/** Deleting a weight: `pets.deleteLogs`, or its author with `pets.addLogs` within 10 minutes. */
export function mayDeleteWeight(entry: Authored, actor: Actor, now: Date): boolean {
  if (mayPet('pets.weight.delete', actor.permissions)) return true;
  return isAuthor(entry, actor) && actor.permissions['pets.addLogs'] === true && withinAuthorWindow(entry, now);
}
