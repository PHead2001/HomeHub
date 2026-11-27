import 'server-only';

import { adminDb } from '@/lib/server/firebase-admin';
import { exceedsPayloadBudget } from '@/ai/action-auth';
import { withoutEmails } from '@/lib/devices/without-emails';
import { authorizeDeviceAction, DEVICE_REQUEST_MAX_BYTES, type DeviceAuthority } from '@/lib/server/device-gate';
import { DeviceActionError } from '@/lib/server/device-errors';
import { deviceOperationContext } from '@/lib/server/operation-context';
import type { DeviceCapability } from '@/lib/devices/action-policy';
import {
  ShoppingOperationError,
  addShoppingItemsAs,
  tickShoppingItemAs,
  undoShoppingAddAs,
  undoShoppingTickAs,
  type AddResult,
  type ShoppingUndoResult,
  type TickResult,
} from '@/lib/server/shopping-item-operations';

// Shopping from a registered wall tablet (docs/modules/devices/README.md, "Device actions:
// shopping"; audit HP-33, HP-36, SH-11, SH-28; WT-6a, WT-11c, WT-18c, WT-20). Each passes the
// device action gate (`authorizeDeviceAction`: the tablet, its household and generation, the
// person chosen in "Who's here?", that person's own shopping.edit permission (the one the rules
// ask of a phone), the Shopping section switch (`section_off` when it is off on the device
// record, WT-11c), the level: face once the Undo is proven, never the points PIN (WT-22d)),
// then runs the Shopping operation (src/lib/server/shopping-item-operations.ts) with the gate's
// hooks inside that operation's transaction: precheck first, finalize last. Requests are built
// here from an allow-list: the list, the item and the entries only. The adder, the buyer, the
// device, the level and the opId never come from the client's fields.

export type DeviceShoppingRequest = {
  idToken: unknown;
  householdId: unknown;
  actorUid: unknown;
  pinSessionId?: unknown;
  opId: unknown;
  queued?: { createdAt: string; generation?: unknown };
};

/** `clock`: the server clock (the real time unless a test injects one); read again at every precheck. */
export type DeviceShoppingOptions = { clock?: () => Date; clientAddress?: string };

const sized = (input: unknown) => {
  if (!input || typeof input !== 'object' || exceedsPayloadBudget(input, DEVICE_REQUEST_MAX_BYTES)) throw new DeviceActionError('invalid_input');
};

const authorize = (capability: DeviceCapability, input: DeviceShoppingRequest, options: DeviceShoppingOptions) => authorizeDeviceAction({
  idToken: input.idToken as string,
  householdId: input.householdId as string,
  capability,
  actorUid: typeof input.actorUid === 'string' ? input.actorUid : undefined,
  pinSessionId: typeof input.pinSessionId === 'string' ? input.pinSessionId : undefined,
  opId: input.opId as string,
  // The gate refuses a queued entry whose generation is missing or not the token's.
  ...(input.queued && typeof input.queued.createdAt === 'string' ? { queued: { createdAt: input.queued.createdAt, generation: input.queued.generation as number } } : {}),
}, { clientAddress: options.clientAddress, clock: options.clock });

/** Shopping errors as device refusals (a bad list, item or entry is invalid input). */
const asDeviceError = (error: unknown): never => {
  if (error instanceof ShoppingOperationError) throw new DeviceActionError('invalid_input');
  throw error;
};

const levelOf = (authority: DeviceAuthority): 'face' | 'pin' => (authority.level === 'pin' ? 'pin' : 'face');

const undoContext = (authority: DeviceAuthority) => ({ ...deviceOperationContext(authority), authority });

/** Plain objects without emails (WT-10e). */
const answer = <T,>(value: T): T => withoutEmails(JSON.parse(JSON.stringify(value)) as T);

export type AddIntent = { listId: unknown; entries: unknown };
export type DeviceAddResult = { result: AddResult; level: 'face' | 'pin' };

/**
 * `shopping.add`: up to 20 entries ("milk, 2 bread") onto one list, credited to the selected
 * person (`addedByUid`) with the tablet's `deviceAttribution` on each new item; a name still
 * needed on the list raises that item's quantity instead. A list deleted meanwhile is `gone`.
 */
export async function addShoppingItemsFromTablet(input: DeviceShoppingRequest & AddIntent, options: DeviceShoppingOptions = {}): Promise<DeviceAddResult> {
  sized(input);
  const authority = await authorize('shopping.add', input, options);
  const result = await addShoppingItemsAs(adminDb, authority.householdId, { listId: input.listId, entries: input.entries }, deviceOperationContext(authority)).catch(asDeviceError);
  return { result: answer(result), level: levelOf(authority) };
}

/** `shopping.add.undo`: by the original's opId only; `changed_since` when any of its items changed. */
export async function undoShoppingAddFromTablet(input: DeviceShoppingRequest, options: DeviceShoppingOptions = {}): Promise<ShoppingUndoResult> {
  sized(input);
  const authority = await authorize('shopping.add.undo', input, options);
  return answer(await undoShoppingAddAs(adminDb, authority.householdId, undoContext(authority)).catch(asDeviceError));
}

export type TickIntent = { listId: unknown; itemId: unknown };
export type DeviceTickResult = { result: TickResult; level: 'face' | 'pin' };

/**
 * `shopping.tick` (the Shopping view's rows and the dashboard's Shopping tile on a tablet):
 * one needed item into the cart for the selected person (`purchasedByUid`), with the tablet's
 * `purchaseDeviceAttribution`. An item someone ticked first keeps its buyer (`already`).
 */
export async function tickShoppingItemFromTablet(input: DeviceShoppingRequest & TickIntent, options: DeviceShoppingOptions = {}): Promise<DeviceTickResult> {
  sized(input);
  const authority = await authorize('shopping.tick', input, options);
  const result = await tickShoppingItemAs(adminDb, authority.householdId, { listId: input.listId, itemId: input.itemId }, deviceOperationContext(authority)).catch(asDeviceError);
  return { result: answer(result), level: levelOf(authority) };
}

/** `shopping.tick.undo`: by the original's opId only; `changed_since` when it was ticked or un-ticked again since. */
export async function undoShoppingTickFromTablet(input: DeviceShoppingRequest, options: DeviceShoppingOptions = {}): Promise<ShoppingUndoResult> {
  sized(input);
  const authority = await authorize('shopping.tick.undo', input, options);
  return answer(await undoShoppingTickAs(adminDb, authority.householdId, undoContext(authority)).catch(asDeviceError));
}
