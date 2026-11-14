import 'server-only';

import type { DeviceAttribution, DeviceAuthority, DeviceTxHooks } from '@/lib/server/device-gate';

// Feature operations take an actor and run the device hooks (docs/modules/devices/
// README.md, "Feature operations take an actor"; design section 9, S1). Every `…As`
// operation follows the same order inside exactly one `db.runTransaction` it opens:
//   1. `const { replay } = await ctx.hooks?.precheck(tx) ?? {}`; if `replay`, return it
//      (no further reads, no writes);
//   2. its own reads, then its writes;
//   3. last: `ctx.hooks?.finalize(tx, { targetPath, summary })`.
// The actor's uid and name go into the module's actor fields; `ctx.actor.device`, when
// present, is stored as `deviceAttribution` (read it after precheck: the level can
// change there). Personal server actions pass `{ actor }` and no hooks: unchanged.

export type OperationActor = {
  uid: string;
  name: string;
  /** Present only for device actions: the attribution to store with the record. */
  device?: DeviceAttribution;
};

export type OperationContext = {
  actor: OperationActor;
  /** The client's idempotency key (device actions: the op ledger id). */
  opId?: string;
  hooks?: DeviceTxHooks;
  now: Date;
};

/** A personal caller as an operation actor (no device, no hooks). */
export const personalOperationContext = (caller: { uid: string; name: string }, now = new Date(), opId?: string): OperationContext => ({
  actor: { uid: caller.uid, name: caller.name },
  now,
  ...(opId ? { opId } : {}),
});

/**
 * A device authority as an operation context. The actor and attribution are read
 * through getters so the values the gate re-checked inside the transaction
 * (`precheck`) are the ones the operation stores.
 */
export const deviceOperationContext = (authority: DeviceAuthority): OperationContext => {
  if (!authority.actor) throw new Error('A device operation needs an actor.');
  return {
    get actor(): OperationActor {
      return {
        uid: authority.actor!.uid,
        name: authority.actor!.name,
        ...(authority.attribution ? { device: authority.attribution } : {}),
      };
    },
    opId: authority.opId ?? undefined,
    hooks: authority.hooks,
    now: authority.now,
  };
};
