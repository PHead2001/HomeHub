// What a device action's answer means on the tablet (docs/modules/devices/README.md,
// "Device actions"). Pure, so the copy and the Undo decision are unit-tested.

import type { DeviceCapability, DeviceRefusal } from './action-policy';
import type { SendResult } from './offline-queue';
import { publicDisplayName } from '@/lib/member-directory';

/** Each action capability and the capability that undoes it (only these offer Undo). */
export const UNDO_CAPABILITY_OF: Partial<Record<DeviceCapability, DeviceCapability>> = {
  'chores.complete': 'chores.complete.undo',
  'chores.take': 'chores.take.undo',
  'pets.feed': 'pets.feed.undo',
  'pets.feed.backdated': 'pets.feed.undo',
  'pets.feed.backdated.old': 'pets.feed.undo',
  'pets.care.add': 'pets.care.undo',
};

/**
 * Capabilities the tablet can send to the server today (F4a: chores; F4b-1: pets feeding
 * and care). Everything else (doses, notes, weight, deletes, profile edits) is refused at once.
 */
export const SENDABLE_CAPABILITIES: ReadonlySet<DeviceCapability> = new Set<DeviceCapability>([
  'chores.complete', 'chores.complete.undo', 'chores.take', 'chores.take.undo',
  'pets.feed', 'pets.feed.backdated', 'pets.feed.backdated.old', 'pets.feed.undo', 'pets.care.add', 'pets.care.undo',
]);

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
  if (capability === 'chores.complete.undo' || capability === 'chores.take.undo' || capability === 'pets.feed.undo' || capability === 'pets.care.undo') {
    if (['undone', 'untaken', 'already', 'not_applied'].includes(str(value.status))) return { ok: true };
    return { ok: false, code: 'changed_since' };
  }
  // A capability without a known outcome shape is never assumed to have applied.
  return { ok: false, code: 'unclassified' };
}
