import 'server-only';

import { adminDb } from '@/lib/server/firebase-admin';
import { authorizeDeviceAction } from '@/lib/server/device-gate';
import { DeviceActionError } from '@/lib/server/device-errors';
import { deviceOperationContext } from '@/lib/server/operation-context';
import { withoutEmails } from '@/lib/server/device-chores';
import { backdatedCapability, type DeviceCapability } from '@/lib/devices/action-policy';
import {
  PetFeedingError,
  addCareAs,
  backdatedTimeOf,
  feedPetAs,
  undoCareAs,
  undoFeedAs,
  type CareAsResult,
  type FeedAsResult,
  type PetUndoOutcome,
} from '@/lib/server/pet-feeding';

// Pets feeding and care from a registered wall tablet (docs/modules/devices/README.md,
// "Device actions: pets"; design 8.2, 9, 10; PE-2c/d, PE-17a/c, PE-23l). Each passes the
// device action gate (`authorizeDeviceAction`: the tablet, its household and generation,
// the person chosen in "Who's here?", their pets permission from the same constants the
// personal paths use (R5), the Pets section, the level: face once the Undo is proven, a
// backdated feed older than 12 hours at PIN level (JC-27), never the points PIN (D-P6)),
// then runs the Pets operation with the gate's hooks inside its own transaction.

export type DevicePetsRequest = {
  idToken: unknown;
  householdId: unknown;
  actorUid: unknown;
  pinSessionId?: unknown;
  opId: unknown;
  queued?: { createdAt: string; generation?: unknown };
};

/** `clock`: the server clock (the real time unless a test injects one); read again at every precheck. */
export type DevicePetsOptions = { clock?: () => Date; clientAddress?: string };

const authorize = (capability: DeviceCapability, input: DevicePetsRequest, options: DevicePetsOptions) => authorizeDeviceAction({
  idToken: input.idToken as string,
  householdId: input.householdId as string,
  capability,
  actorUid: typeof input.actorUid === 'string' ? input.actorUid : undefined,
  pinSessionId: typeof input.pinSessionId === 'string' ? input.pinSessionId : undefined,
  opId: input.opId as string,
  // The gate refuses a queued entry whose generation is missing or not the token's.
  ...(input.queued && typeof input.queued.createdAt === 'string' ? { queued: { createdAt: input.queued.createdAt, generation: input.queued.generation as number } } : {}),
}, { clientAddress: options.clientAddress, clock: options.clock });

/** Pets module errors as device refusals (a missing pet or bad input is invalid input). */
const asDeviceError = (error: unknown): never => {
  if (error instanceof PetFeedingError) throw new DeviceActionError(error.reason === 'conflict' ? 'conflict' : 'invalid_input');
  throw error;
};

/** The device's clock for a queued replay (the gate has already bounded it, JC-18). */
const queuedAtOf = (createdAt: string | null): Date | null => (createdAt ? new Date(createdAt) : null);

export type DeviceFeedResult = { result: FeedAsResult; level: 'face' | 'pin'; capability: DeviceCapability };

export type DeviceFeedRequest = DevicePetsRequest & {
  petId: unknown;
  portion: unknown;
  portionFromSlot?: unknown;
  food: unknown;
  comments?: unknown;
  confirm?: unknown;
  backdatedAt?: unknown;
};

/**
 * `pets.feed` (Feed, hold, quick add, dashboard Fed on a tablet) and the detailed form's
 * backdated feed: the server picks `pets.feed.backdated` (within 12 hours, face) or
 * `pets.feed.backdated.old` (PIN) from the chosen time, never from the client.
 */
export async function feedPetFromTablet(input: DeviceFeedRequest, options: DevicePetsOptions = {}): Promise<DeviceFeedResult> {
  const now = (options.clock ?? (() => new Date()))();
  let capability: DeviceCapability = 'pets.feed';
  try {
    const backdatedAt = backdatedTimeOf(input.backdatedAt, now);
    if (backdatedAt) capability = backdatedCapability('feed', backdatedAt, now);
  } catch (error) {
    asDeviceError(error);
  }
  const authority = await authorize(capability, input, options);
  const ctx = deviceOperationContext(authority);
  const result = await feedPetAs(adminDb, authority.householdId, {
    petId: input.petId, portion: input.portion, portionFromSlot: input.portionFromSlot, food: input.food,
    comments: input.comments, confirm: input.confirm, backdatedAt: input.backdatedAt,
  }, ctx, { queuedAt: queuedAtOf(authority.queuedCreatedAt) }).catch(asDeviceError);
  return { result: withoutEmails(result), level: authority.level === 'pin' ? 'pin' : 'face', capability };
}

/** `pets.feed.undo`: by the original's opId only. */
export async function undoFeedFromTablet(input: DevicePetsRequest & { petId?: unknown }, options: DevicePetsOptions = {}): Promise<PetUndoOutcome> {
  const authority = await authorize('pets.feed.undo', input, options);
  return undoFeedAs(adminDb, authority.householdId, { petId: input.petId }, { ...deviceOperationContext(authority), authority }).catch(asDeviceError);
}

/** `pets.care.add`: a care entry credited to the chosen person. */
export async function addCareFromTablet(input: DevicePetsRequest & { petId: unknown; activity: unknown; notes?: unknown }, options: DevicePetsOptions = {}): Promise<CareAsResult> {
  const authority = await authorize('pets.care.add', input, options);
  return withoutEmails(await addCareAs(adminDb, authority.householdId, { petId: input.petId, activity: input.activity, notes: input.notes }, deviceOperationContext(authority), { queuedAt: queuedAtOf(authority.queuedCreatedAt) }).catch(asDeviceError));
}

/** `pets.care.undo`: by the original's opId only. */
export async function undoCareFromTablet(input: DevicePetsRequest & { petId?: unknown }, options: DevicePetsOptions = {}): Promise<PetUndoOutcome> {
  const authority = await authorize('pets.care.undo', input, options);
  return undoCareAs(adminDb, authority.householdId, { petId: input.petId }, { ...deviceOperationContext(authority), authority }).catch(asDeviceError);
}
