import 'server-only';

import { adminDb } from '@/lib/server/firebase-admin';
import { authorizeDeviceAction } from '@/lib/server/device-gate';
import { DeviceActionError } from '@/lib/server/device-errors';
import { deviceOperationContext } from '@/lib/server/operation-context';
import {
  ChoreCompletionError,
  completeChoresAs,
  takeChoreAs,
  undoChoreCompletionAs,
  undoTakeChoreAs,
  type DeviceUndoOutcome,
  type TakeOutcome,
} from '@/lib/server/chore-completion';
import type { DeviceCapability } from '@/lib/devices/action-policy';
import type { ChoreCompletionOutcome, UndoOutcome } from '@/lib/chores/completion';
import { publicDisplayName } from '@/lib/member-directory';

// Chore actions from a registered wall tablet (docs/modules/devices/README.md, "Device
// actions"; design 9, 10; WT-22, CH-12b). Each passes the device action gate
// (`authorizeDeviceAction`: the tablet, its household and generation, the selected
// person, their permission from the same constants the personal actions use, the section,
// the level including the household points-PIN setting), then runs the Chores operation
// with the gate's hooks inside the operation's own transaction (precheck first, finalize
// last: op ledger, PIN-session slide, activity for PIN-level actions).

export type DeviceChoreRequest = {
  idToken: unknown;
  householdId: unknown;
  actorUid: unknown;
  pinSessionId?: unknown;
  opId: unknown;
  queued?: { createdAt: string; generation?: unknown };
};

/** `clock`: the server clock (the real time unless a test injects one); read again at every precheck. */
export type DeviceChoreOptions = { clock?: () => Date; clientAddress?: string };

const authorize = (capability: DeviceCapability, input: DeviceChoreRequest, options: DeviceChoreOptions) => authorizeDeviceAction({
  idToken: input.idToken as string,
  householdId: input.householdId as string,
  capability,
  actorUid: typeof input.actorUid === 'string' ? input.actorUid : undefined,
  pinSessionId: typeof input.pinSessionId === 'string' ? input.pinSessionId : undefined,
  opId: input.opId as string,
  // The gate refuses a queued entry whose generation is missing or not the token's.
  ...(input.queued && typeof input.queued.createdAt === 'string' ? { queued: { createdAt: input.queued.createdAt, generation: input.queued.generation as number } } : {}),
}, { clientAddress: options.clientAddress, clock: options.clock });

/**
 * What a tablet receives never carries an email (WT-10e): every `…Email` field is removed
 * from device answers, replays from the op ledger included, and names are public names.
 */
export const withoutEmails = <T,>(value: T): T => {
  if (Array.isArray(value)) return value.map(withoutEmails) as T;
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/email/i.test(key)) continue;
    out[key] = /name$/i.test(key) && typeof child === 'string' ? publicDisplayName(child, '') : withoutEmails(child);
  }
  return out as T;
};

/** Chores module errors as device refusals (a missing chore or bad id is invalid input). */
const asDeviceError = (error: unknown): never => {
  if (error instanceof ChoreCompletionError) throw new DeviceActionError('invalid_input');
  throw error;
};

export type DeviceCompleteResult = { outcome: ChoreCompletionOutcome; level: 'face' | 'pin' };

/** `chores.complete`: one chore, credited to the selected person (CH-12b), `completionId == opId`. */
export async function completeChoreFromTablet(input: DeviceChoreRequest & { choreId: unknown }, options: DeviceChoreOptions = {}): Promise<DeviceCompleteResult> {
  const authority = await authorize('chores.complete', input, options);
  const ctx = deviceOperationContext(authority);
  const [outcome] = await completeChoresAs(adminDb, authority.householdId, { choreIds: [input.choreId], completeSubTasks: true }, ctx).catch(asDeviceError);
  return { outcome: withoutEmails(outcome), level: authority.level === 'pin' ? 'pin' : 'face' };
}

/** `chores.complete.undo`: by the original's opId only. */
export async function undoChoreCompletionFromTablet(input: DeviceChoreRequest, options: DeviceChoreOptions = {}): Promise<UndoOutcome | DeviceUndoOutcome> {
  const authority = await authorize('chores.complete.undo', input, options);
  return withoutEmails(await undoChoreCompletionAs(adminDb, authority.householdId, {}, { ...deviceOperationContext(authority), authority }).catch(asDeviceError));
}

/** `chores.take`: an unassigned chore (or one already the person's, a no-op). */
export async function takeChoreFromTablet(input: DeviceChoreRequest & { choreId: unknown }, options: DeviceChoreOptions = {}): Promise<TakeOutcome> {
  const authority = await authorize('chores.take', input, options);
  return withoutEmails(await takeChoreAs(adminDb, authority.householdId, { choreId: input.choreId }, deviceOperationContext(authority)).catch(asDeviceError));
}

/** `chores.take.undo`: by the original's opId only; puts the previous assignment back. */
export async function undoTakeChoreFromTablet(input: DeviceChoreRequest, options: DeviceChoreOptions = {}): Promise<TakeOutcome> {
  const authority = await authorize('chores.take.undo', input, options);
  return withoutEmails(await undoTakeChoreAs(adminDb, authority.householdId, { ...deviceOperationContext(authority), authority }).catch(asDeviceError));
}
