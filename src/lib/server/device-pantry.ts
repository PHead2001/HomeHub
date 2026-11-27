import 'server-only';

import { adminDb } from '@/lib/server/firebase-admin';
import { exceedsPayloadBudget } from '@/ai/action-auth';
import { withoutEmails } from '@/lib/devices/without-emails';
import { authorizeDeviceAction, DEVICE_REQUEST_MAX_BYTES, type DeviceAuthority } from '@/lib/server/device-gate';
import { DeviceActionError } from '@/lib/server/device-errors';
import { deviceOperationContext } from '@/lib/server/operation-context';
import type { DeviceCapability } from '@/lib/devices/action-policy';
import {
  PantryOperationError,
  restockPantryItemAs,
  undoPantryRestockAs,
  undoPantryTakeAs,
  takePantryItemAs,
  type PantryRestockResult,
  type PantryUndoResult,
  type PantryUseResult,
} from '@/lib/server/pantry-operations';

// The pantry from a registered wall tablet's scan (docs/modules/devices/README.md, "Device
// actions: pantry"; audit BL-20, BL-21). As the shopping device actions: each passes the
// device action gate (`authorizeDeviceAction`: the tablet, its household and generation, the
// person chosen in "Who's here?", that person's own shopping.edit (the permission the pantry
// rules ask of a phone), the Shopping section switch (`section_off`), the level: face once
// the Undo is proven, never the points PIN), then runs the pantry operation
// (src/lib/server/pantry-operations.ts) with the gate's hooks inside its transaction. The
// request is built here from an allow-list: the barcode and the product name only.

export type DevicePantryRequest = {
  idToken: unknown;
  householdId: unknown;
  actorUid: unknown;
  pinSessionId?: unknown;
  opId: unknown;
  queued?: { createdAt: string; generation?: unknown };
};

export type DevicePantryOptions = { clock?: () => Date; clientAddress?: string };

export type ScanIntent = { barcode: unknown; name: unknown };

const sized = (input: unknown) => {
  if (!input || typeof input !== 'object' || exceedsPayloadBudget(input, DEVICE_REQUEST_MAX_BYTES)) throw new DeviceActionError('invalid_input');
};

const authorize = (capability: DeviceCapability, input: DevicePantryRequest, options: DevicePantryOptions) => authorizeDeviceAction({
  idToken: input.idToken as string,
  householdId: input.householdId as string,
  capability,
  actorUid: typeof input.actorUid === 'string' ? input.actorUid : undefined,
  pinSessionId: typeof input.pinSessionId === 'string' ? input.pinSessionId : undefined,
  opId: input.opId as string,
  ...(input.queued && typeof input.queued.createdAt === 'string' ? { queued: { createdAt: input.queued.createdAt, generation: input.queued.generation as number } } : {}),
}, { clientAddress: options.clientAddress, clock: options.clock });

const asDeviceError = (error: unknown): never => {
  if (error instanceof PantryOperationError) throw new DeviceActionError('invalid_input');
  throw error;
};

const levelOf = (authority: DeviceAuthority): 'face' | 'pin' => (authority.level === 'pin' ? 'pin' : 'face');

const undoContext = (authority: DeviceAuthority) => ({ ...deviceOperationContext(authority), authority });

const answer = <T,>(value: T): T => withoutEmails(JSON.parse(JSON.stringify(value)) as T);

const scanOf = (input: ScanIntent) => ({ barcode: input.barcode, name: input.name });

/** `pantry.useUp`: one package of the scanned product out of the pantry, for the selected person. */
export async function takePantryItemFromTablet(input: DevicePantryRequest & ScanIntent, options: DevicePantryOptions = {}): Promise<{ result: PantryUseResult; level: 'face' | 'pin' }> {
  sized(input);
  const authority = await authorize('pantry.useUp', input, options);
  const result = await takePantryItemAs(adminDb, authority.householdId, scanOf(input), deviceOperationContext(authority)).catch(asDeviceError);
  return { result: answer(result), level: levelOf(authority) };
}

/** `pantry.useUp.undo`: by the original's opId only; `changed_since` when the batch changed since. */
export async function undoPantryTakeFromTablet(input: DevicePantryRequest, options: DevicePantryOptions = {}): Promise<PantryUndoResult> {
  sized(input);
  const authority = await authorize('pantry.useUp.undo', input, options);
  return answer(await undoPantryTakeAs(adminDb, authority.householdId, undoContext(authority)).catch(asDeviceError));
}

/** `pantry.restock`: one more package (or a new one-item batch) of the scanned product, for the selected person. */
export async function restockPantryItemFromTablet(input: DevicePantryRequest & ScanIntent, options: DevicePantryOptions = {}): Promise<{ result: PantryRestockResult; level: 'face' | 'pin' }> {
  sized(input);
  const authority = await authorize('pantry.restock', input, options);
  const result = await restockPantryItemAs(adminDb, authority.householdId, scanOf(input), deviceOperationContext(authority)).catch(asDeviceError);
  return { result: answer(result), level: levelOf(authority) };
}

/** `pantry.restock.undo`: by the original's opId only; `changed_since` when the batch changed since. */
export async function undoPantryRestockFromTablet(input: DevicePantryRequest, options: DevicePantryOptions = {}): Promise<PantryUndoResult> {
  sized(input);
  const authority = await authorize('pantry.restock.undo', input, options);
  return answer(await undoPantryRestockAs(adminDb, authority.householdId, undoContext(authority)).catch(asDeviceError));
}
