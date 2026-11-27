// What a device action's answer means on the tablet (docs/modules/devices/README.md,
// "Device actions"). Pure, so the copy and the Undo decision are unit-tested.

import type { DeviceCapability, DeviceRefusal } from './action-policy';
import type { SendResult } from './offline-queue';
import { publicDisplayName } from '@/lib/member-directory';
import { PINNED_NOTES_MAX } from '@/lib/pets/notes';

/** Each action capability and the capability that undoes it (only these offer Undo). */
export const UNDO_CAPABILITY_OF: Partial<Record<DeviceCapability, DeviceCapability>> = {
  'chores.complete': 'chores.complete.undo',
  'chores.take': 'chores.take.undo',
  'pets.feed': 'pets.feed.undo',
  'pets.feed.backdated': 'pets.feed.undo',
  'pets.feed.backdated.old': 'pets.feed.undo',
  'pets.care.add': 'pets.care.undo',
  'pets.dose.give': 'pets.dose.undo',
  'pets.dose.give.old': 'pets.dose.undo',
  'pets.note.add': 'pets.note.undo',
  'pets.weight.add': 'pets.weight.undo',
  // Maintenance (M8b): Done, Log service and Snooze.
  'maintenance.complete': 'maintenance.complete.undo',
  'maintenance.log': 'maintenance.log.undo',
  'maintenance.snooze': 'maintenance.snooze.undo',
  // Shopping: adding items and ticking one.
  'shopping.add': 'shopping.add.undo',
  'shopping.tick': 'shopping.tick.undo',
};

/**
 * Capabilities the tablet can send to the server (F4a: chores; F4b-1: pets feeding and care;
 * F4b-2: doses, notes, weights and their Undo, and the PIN-level Pets actions). Everything
 * else (pet create, photos, every other section's writes) is refused at once.
 */
export const SENDABLE_CAPABILITIES: ReadonlySet<DeviceCapability> = new Set<DeviceCapability>([
  'chores.complete', 'chores.complete.undo', 'chores.take', 'chores.take.undo',
  'pets.feed', 'pets.feed.backdated', 'pets.feed.backdated.old', 'pets.feed.undo', 'pets.care.add', 'pets.care.undo',
  'pets.dose.give', 'pets.dose.give.old', 'pets.dose.undo', 'pets.note.add', 'pets.note.undo', 'pets.weight.add', 'pets.weight.undo',
  'pets.note.pin', 'pets.note.unpin', 'pets.note.editPinned', 'pets.note.delete', 'pets.log.delete', 'pets.log.correctTime',
  'pets.course.finish', 'pets.course.resume', 'pets.course.edit', 'pets.medication.confirmLegacy',
  'pets.slots.edit', 'pets.profile.edit', 'pets.pet.delete',
  // Maintenance (M8b): face actions with their Undo, and the PIN-level schedule edit and deletes.
  'maintenance.complete', 'maintenance.complete.undo', 'maintenance.log', 'maintenance.log.undo', 'maintenance.snooze', 'maintenance.snooze.undo',
  'maintenance.editSchedules', 'maintenance.log.delete', 'maintenance.record.delete',
  // Shopping: add and tick with their Undo (face).
  'shopping.add', 'shopping.add.undo', 'shopping.tick', 'shopping.tick.undo',
]);

/** Plain words for a shopping answer that changed nothing (also the queue's drop notice). */
const shoppingNoop = (capability: DeviceCapability, result: Record<string, unknown>): string => {
  if (result.status === 'already') {
    const by = publicDisplayName(str(result.byName), '');
    return by ? `Already in the cart: ${by} ticked it.` : 'Already in the cart.';
  }
  if (result.status === 'gone') return capability === 'shopping.add' ? 'That list was removed meanwhile.' : 'That item was removed meanwhile.';
  return "Couldn't save. Try again.";
};

/** "Milk", "Milk and Eggs", "Milk, Eggs and 2 more". */
export function addedNames(items: ReadonlyArray<{ name?: unknown }>): string {
  const names = items.map((item) => str(item.name)).filter(Boolean);
  if (names.length <= 1) return names[0] ?? 'Items';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/** The PIN-level maintenance actions (M8a): no Undo of their own. */
export const MAINTENANCE_PIN_CAPABILITIES: ReadonlySet<DeviceCapability> = new Set<DeviceCapability>([
  'maintenance.editSchedules', 'maintenance.log.delete', 'maintenance.record.delete',
]);

/** Why a maintenance completion was refused (the personal dialog's meaning, in tablet words). */
export const MAINTENANCE_REFUSAL_COPY: Record<string, string> = {
  invalid_date: 'That date is not valid.',
  future_date: 'Pick a day that has already come.',
  invalid_mileage: 'That mileage is not valid.',
  mileage_required: 'Enter the mileage to mark this done.',
  next_due_required: 'This needs a next due date. Set one on a phone.',
  invalid_next_due: 'That next due date is not valid.',
  next_due_mileage_low: 'The next due mileage must be above the reading.',
  not_snoozable: "This can't be snoozed.",
};

/** Plain words for a maintenance answer that changed nothing (also the queue's drop notice). */
const maintenanceNoop = (result: Record<string, unknown>): string => {
  switch (result.status) {
    case 'already_done': {
      const by = publicDisplayName(str(result.byName), '');
      return by ? `Already done by ${by}.` : 'Already done.';
    }
    case 'changed':
      return 'This changed since it was shown. The latest is shown now.';
    case 'gone':
      return 'That was removed meanwhile.';
    case 'refused':
      return MAINTENANCE_REFUSAL_COPY[str(result.reason)] ?? "Couldn't save. Try again.";
    case 'too_many_schedules':
      return 'A record can have at most 100 maintenance items. Remove one on a phone first.';
    default:
      return "Couldn't save. Try again.";
  }
};

/** The maintenance Undo answers that leave nothing to do (`already_undone`: the server's word for "already"). */
const MAINTENANCE_UNDONE = ['undone', 'already_undone', 'not_applied'];

const DOSE_CAPABILITIES: ReadonlySet<DeviceCapability> = new Set<DeviceCapability>(['pets.dose.give', 'pets.dose.give.old']);
export const isDoseCapability = (capability: DeviceCapability): boolean => DOSE_CAPABILITIES.has(capability);

/** The PIN-level Pets actions (JC-14): one answer shape, no Undo of their own. */
export const PET_PIN_CAPABILITIES: ReadonlySet<DeviceCapability> = new Set<DeviceCapability>([
  'pets.note.pin', 'pets.note.unpin', 'pets.note.editPinned', 'pets.note.delete', 'pets.log.delete', 'pets.log.correctTime',
  'pets.course.finish', 'pets.course.resume', 'pets.course.edit', 'pets.medication.confirmLegacy',
  'pets.slots.edit', 'pets.profile.edit', 'pets.pet.delete',
]);

type PlainPointer = { logId: string; occurrence: string; occurrenceAt: number; givenAt: number | null; byUid: string | null; byName: string | null };

/** A dose answer asking "Already given?" (nothing was written; the answer goes back with the same opId, bound to the dose named). */
export type DoseAgainCheck = {
  kind: 'dose';
  staleConfirm: boolean;
  check: { last: PlainPointer | null; occurrence: { key: string; fold?: 1; day: string; time: string | null; at: number }; reason: 'given' | 'moved' | 'recent' };
};

/** The "Already given?" question in a dose answer, or null (names only: an email is never shown). */
export function doseAgainCheck(capability: DeviceCapability, data: unknown): DoseAgainCheck | null {
  if (!isDoseCapability(capability)) return null;
  const result = ((data ?? {}) as { result?: Record<string, unknown> }).result;
  if (!result || result.status !== 'needsConfirm') return null;
  const check = (result.check ?? {}) as Record<string, unknown>;
  const occurrence = (check.occurrence ?? {}) as Record<string, unknown>;
  const last = check.last && typeof check.last === 'object' ? check.last as Record<string, unknown> : null;
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  return {
    kind: 'dose',
    staleConfirm: result.staleConfirm === true,
    check: {
      last: last && str(last.logId)
        ? { logId: str(last.logId), occurrence: str(last.occurrence), occurrenceAt: num(last.occurrenceAt) ?? 0, givenAt: num(last.givenAt), byUid: str(last.byUid) || null, byName: publicDisplayName(str(last.byName), '') || null }
        : null,
      // `fold` keeps the later of two same-clock occurrences apart (P3: the answer is bound to `occurrenceId`).
      occurrence: { key: str(occurrence.key), ...(occurrence.fold === 1 ? { fold: 1 as const } : {}), day: str(occurrence.day), time: str(occurrence.time) || null, at: num(occurrence.at) ?? 0 },
      reason: check.reason === 'moved' ? 'moved' : check.reason === 'recent' ? 'recent' : 'given',
    },
  };
}

/** A question the server asked before writing anything: "Feed again?" or "Already given?". */
export type ConfirmCheck = FeedAgainCheck | DoseAgainCheck;
export const confirmCheckOf = (capability: DeviceCapability, data: unknown): ConfirmCheck | null =>
  feedAgainCheck(capability, data) ?? doseAgainCheck(capability, data);

/** Why a dose was not recorded (the personal dialog's copy). */
export const DOSE_REFUSAL_COPY: Record<string, string> = {
  missing: 'This course was removed meanwhile.',
  finished: 'This course was finished meanwhile.',
  occurrence: 'The schedule changed meanwhile. Pick the dose time again.',
  future: 'Pick a time that has already passed.',
  'too-old': 'Pick a time within the last 7 days.',
};

/** Why a PIN-level Pets action changed nothing (plain words for the toast). */
export const PET_PIN_REFUSAL_COPY: Record<string, string> = {
  gone: 'That was removed meanwhile.',
  changed: 'Someone changed this meanwhile. Check it and save again.',
  missing: 'That course was removed meanwhile.',
  'not-active': 'That course was finished meanwhile.',
  invalid: 'Check the form and try again.',
  'duplicate-name': 'Another pet already has that name.',
  // The shared pinned-note cap (P5's pinRefusal).
  'pin-limit': `Up to ${PINNED_NOTES_MAX} pinned notes. Unpin or remove one first.`,
  future: 'Pick a time that has already passed.',
  unchanged: 'That is already the time.',
};

const FEED_CAPABILITIES: ReadonlySet<DeviceCapability> = new Set<DeviceCapability>(['pets.feed', 'pets.feed.backdated', 'pets.feed.backdated.old']);
export const isFeedCapability = (capability: DeviceCapability): boolean => FEED_CAPABILITIES.has(capability);

/** A feed answer asking "Feed again?" (nothing was written; the answer goes back with the same opId). */
export type FeedAgainCheck = {
  staleConfirm: boolean;
  reason: 'recent' | 'complete' | 'slot-fed' | 'off-day' | null;
  lastLogId: string | null;
  lastFedAt: Date | null;
  lastFedByUid: string | null;
  lastFedByName: string | null;
  countToday: number;
  perDay: number | null;
  slotId?: string | null;
  slotName?: string | null;
  slotTime?: string | null;
};

/** The "Feed again?" question in a feed answer, or null. */
export function feedAgainCheck(capability: DeviceCapability, data: unknown): FeedAgainCheck | null {
  if (!isFeedCapability(capability)) return null;
  const result = ((data ?? {}) as { result?: Record<string, unknown> }).result;
  if (!result || result.status !== 'needsConfirm') return null;
  const at = typeof result.lastFedAt === 'string' ? new Date(result.lastFedAt) : null;
  return {
    staleConfirm: result.staleConfirm === true,
    reason: (['recent', 'complete', 'slot-fed', 'off-day'] as const).find((reason) => reason === result.reason) ?? null,
    lastLogId: str(result.lastLogId) || null,
    lastFedAt: at && !Number.isNaN(at.getTime()) ? at : null,
    lastFedByUid: str(result.lastFedByUid) || null,
    lastFedByName: publicDisplayName(str(result.lastFedByName), '') || null,
    countToday: typeof result.countToday === 'number' ? result.countToday : 0,
    perDay: typeof result.perDay === 'number' ? result.perDay : null,
    ...('slotId' in result ? { slotId: str(result.slotId) || null, slotName: str(result.slotName) || null, slotTime: str(result.slotTime) || null } : {}),
  };
}

export type ActionMeaning = {
  /** The action changed something this tablet may Undo (and points/credit went to the person). */
  undoable: boolean;
  /** The toast's text. */
  message: string;
  /** Shown as a plain notice rather than a success. */
  notice?: true;
};

const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** The tablet's reading of a successful answer from a device action (chores and pets). */
export function choreAnswerMeaning(capability: DeviceCapability, data: unknown, label: string): ActionMeaning {
  const value = (data ?? {}) as Record<string, unknown>;
  if (isFeedCapability(capability)) {
    const result = (value.result ?? {}) as Record<string, unknown>;
    // "Feed again?" answered with Cancel: nothing was written, nothing to say.
    if (value.cancelled === true || result.status === 'needsConfirm') return { undoable: false, notice: true, message: '' };
    // A replay of this press (a retry after a lost answer) is still this tablet's feed: its Undo is offered.
    if (result.status === 'saved') return { undoable: true, message: `${label}.` };
    return { undoable: false, notice: true, message: "Couldn't save. Try again." };
  }
  if (capability === 'pets.care.add') {
    if (value.status === 'added') return { undoable: true, message: `${label}: logged.` };
    return { undoable: false, notice: true, message: "Couldn't save. Try again." };
  }
  if (isDoseCapability(capability)) {
    const result = (value.result ?? {}) as Record<string, unknown>;
    // "Already given?" answered with Cancel: nothing was written, nothing to say.
    if (value.cancelled === true || result.status === 'needsConfirm') return { undoable: false, notice: true, message: '' };
    if (result.status === 'saved') return { undoable: true, message: `${label}: recorded.` };
    // The Give dose dialog shows why inline.
    if (result.status === 'refused') return { undoable: false, notice: true, message: '' };
    return { undoable: false, notice: true, message: "Couldn't save. Try again." };
  }
  if (capability === 'pets.note.add' || capability === 'pets.weight.add') {
    if (value.status === 'added') return { undoable: true, message: `${label}: saved.` };
    return { undoable: false, notice: true, message: PET_PIN_REFUSAL_COPY.invalid };
  }
  if (PET_PIN_CAPABILITIES.has(capability)) {
    if (value.status === 'saved' || value.status === 'deleted') return { undoable: false, message: `${label}.` };
    // A pet delete that stopped after the pet left every list: the hourly upkeep finishes it.
    if (value.status === 'finishing') return { undoable: false, message: `${label}. Its history is still being cleared.` };
    if (value.status === 'already') return { undoable: false, notice: true, message: 'Nothing to change.' };
    return { undoable: false, notice: true, message: PET_PIN_REFUSAL_COPY[str(value.reason)] ?? "Couldn't save. Try again." };
  }
  if (capability === 'maintenance.complete' || capability === 'maintenance.log' || capability === 'maintenance.snooze') {
    const result = (value.result ?? {}) as Record<string, unknown>;
    if (result.status === 'completed') return { undoable: true, message: `${label}: done.` };
    if (result.status === 'saved') return { undoable: true, message: `${label}: logged.` };
    if (result.status === 'snoozed') return { undoable: true, message: `${label}: snoozed a week.` };
    return { undoable: false, notice: true, message: maintenanceNoop(result) };
  }
  if (MAINTENANCE_PIN_CAPABILITIES.has(capability)) {
    const result = (value.result ?? {}) as Record<string, unknown>;
    if (result.status === 'saved' || result.status === 'deleted') return { undoable: false, message: `${label}.` };
    if (result.status === 'finishing') return { undoable: false, message: `${label}. Its files are still being removed.` };
    if (result.status === 'already') return { undoable: false, notice: true, message: 'That was removed meanwhile.' };
    return { undoable: false, notice: true, message: maintenanceNoop(result) };
  }
  if (capability === 'shopping.add') {
    const result = (value.result ?? {}) as Record<string, unknown>;
    if (result.status === 'added') return { undoable: true, message: `${addedNames(Array.isArray(result.items) ? result.items as Array<{ name?: unknown }> : [])} added.` };
    return { undoable: false, notice: true, message: shoppingNoop(capability, result) };
  }
  if (capability === 'shopping.tick') {
    const result = (value.result ?? {}) as Record<string, unknown>;
    if (result.status === 'ticked') return { undoable: true, message: `${label} is in the cart.` };
    return { undoable: false, notice: true, message: shoppingNoop(capability, result) };
  }
  if (capability === 'chores.complete') {
    const outcome = (value.outcome ?? {}) as Record<string, unknown>;
    if (outcome.status === 'completed') return { undoable: true, message: `${label}: done.` };
    if (outcome.status === 'already') {
      const by = publicDisplayName(str((outcome.completion as Record<string, unknown> | undefined)?.completedByName), '');
      return { undoable: false, notice: true, message: by ? `Already done by ${by}.` : 'Already done.' };
    }
    if (outcome.status === 'refused' && outcome.refused === 'early') return { undoable: false, notice: true, message: "That chore isn't due yet." };
    return { undoable: false, notice: true, message: 'That chore is gone.' };
  }
  if (capability === 'chores.take') {
    if (value.status === 'taken') return { undoable: true, message: `${label}: it's yours.` };
    return { undoable: false, notice: true, message: "It's already yours." };
  }
  // Undo answers: undone, untaken, already (undone before) and not_applied (it never happened) all leave nothing to do.
  return { undoable: false, message: 'Undone.' };
}

/**
 * What a queued replay's answer means for the queue (11.3). A server action can answer
 * successfully with a domain outcome that did NOT apply the change: a completion refused
 * because the chore isn't due yet or was deleted, or one someone else already did. Those
 * are dropped with a notice that says why, never deleted as if applied. Undo answers
 * (undone, untaken, already, not applied) and a no-op take (already the person's) leave
 * nothing to do.
 */
export function queuedSendResult(capability: DeviceCapability, answer: { ok: true; data: unknown } | { ok: false; code: DeviceRefusal }): SendResult {
  if (!answer.ok) return { ok: false, code: answer.code };
  const value = (answer.data ?? {}) as Record<string, unknown>;
  if (capability === 'chores.complete') {
    const outcome = (value.outcome ?? {}) as Record<string, unknown>;
    if (outcome.status === 'completed') return { ok: true };
    if (outcome.status === 'already') {
      const by = publicDisplayName(str((outcome.completion as Record<string, unknown> | undefined)?.completedByName), '');
      return { ok: false, code: 'conflict', reason: by ? `it was already done by ${by}.` : 'it was already done.' };
    }
    if (outcome.status === 'refused' && outcome.refused === 'early') return { ok: false, code: 'invalid_input', reason: "that chore isn't due yet." };
    return { ok: false, code: 'invalid_input', reason: 'that chore is gone.' };
  }
  if (capability === 'chores.take') {
    if (value.status === 'taken' || value.status === 'already_yours') return { ok: true };
    return { ok: false, code: 'invalid_input', reason: 'that chore could not be taken.' };
  }
  if (isFeedCapability(capability)) {
    // A queued feed happened: it is never asked "Feed again?" (the server records it as offline).
    const result = (value.result ?? {}) as Record<string, unknown>;
    if (result.status === 'saved') return { ok: true };
    return { ok: false, code: 'invalid_input', reason: 'that feeding could not be saved.' };
  }
  if (capability === 'pets.care.add') {
    if (value.status === 'added') return { ok: true };
    return { ok: false, code: 'invalid_input', reason: 'that care entry could not be saved.' };
  }
  if (isDoseCapability(capability)) {
    // A queued dose happened: it is never asked "Already given?" (the server records it as offline).
    const result = (value.result ?? {}) as Record<string, unknown>;
    if (result.status === 'saved') return { ok: true };
    const why = DOSE_REFUSAL_COPY[str(result.reason)];
    return { ok: false, code: 'invalid_input', reason: why ? `that dose was not recorded: ${why.charAt(0).toLowerCase()}${why.slice(1)}` : 'that dose could not be saved.' };
  }
  if (capability === 'pets.note.add' || capability === 'pets.weight.add') {
    if (value.status === 'added') return { ok: true };
    return { ok: false, code: 'invalid_input', reason: capability === 'pets.note.add' ? 'that note could not be saved.' : 'that weight could not be saved.' };
  }
  if (capability === 'maintenance.complete' || capability === 'maintenance.log' || capability === 'maintenance.snooze') {
    // A queued Done or Snooze whose cycle moved (`changed`), done elsewhere, or a record gone: dropped with a notice that says why.
    const result = (value.result ?? {}) as Record<string, unknown>;
    if (result.status === 'completed' || result.status === 'saved' || result.status === 'snoozed') return { ok: true };
    const why = maintenanceNoop(result);
    return { ok: false, code: result.status === 'already_done' ? 'conflict' : 'invalid_input', reason: `${why.charAt(0).toLowerCase()}${why.slice(1)}` };
  }
  if (capability === 'maintenance.complete.undo' || capability === 'maintenance.log.undo' || capability === 'maintenance.snooze.undo') {
    return MAINTENANCE_UNDONE.includes(str(value.status)) ? { ok: true } : { ok: false, code: 'changed_since' };
  }
  if (capability === 'shopping.add' || capability === 'shopping.tick') {
    // A queued tick someone else made first, or an item or list removed meanwhile: dropped with a notice that says why.
    const result = (value.result ?? {}) as Record<string, unknown>;
    if (result.status === 'added' || result.status === 'ticked') return { ok: true };
    const why = shoppingNoop(capability, result);
    return { ok: false, code: result.status === 'already' ? 'conflict' : 'invalid_input', reason: `${why.charAt(0).toLowerCase()}${why.slice(1)}` };
  }
  if (capability === 'shopping.add.undo' || capability === 'shopping.tick.undo') {
    return ['undone', 'already', 'not_applied'].includes(str(value.status)) ? { ok: true } : { ok: false, code: 'changed_since' };
  }
  if (capability === 'chores.complete.undo' || capability === 'chores.take.undo' || capability === 'pets.feed.undo' || capability === 'pets.care.undo'
    || capability === 'pets.dose.undo' || capability === 'pets.note.undo' || capability === 'pets.weight.undo') {
    if (['undone', 'untaken', 'already', 'not_applied'].includes(str(value.status))) return { ok: true };
    return { ok: false, code: 'changed_since' };
  }
  // A capability without a known outcome shape is never assumed to have applied.
  return { ok: false, code: 'unclassified' };
}

/**
 * An intent's own fields: never the request's identity (token, household, person, PIN
 * session, opId or queue fields), which come from the shell alone (F4b-2 review N4).
 */
const RESERVED_REQUEST_KEYS = new Set(['idToken', 'householdId', 'actorUid', 'pinSessionId', 'opId', 'queued']);
export const intentFields = (intent: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(intent).filter(([key]) => !RESERVED_REQUEST_KEYS.has(key)));

/**
 * A tablet form's opId after an attempt (Codex review 6): kept while the attempt may still be
 * on its way or was refused (a retry then replays or is decided again), renewed once it was
 * applied or saved on the tablet (the next submit is a new intent).
 */
export const formOpAfter = (outcome: { ok: boolean; queued?: boolean; uncertain?: boolean }): 'keep' | 'renew' =>
  outcome.ok || outcome.queued ? 'renew' : 'keep';
