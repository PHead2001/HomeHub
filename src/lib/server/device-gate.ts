import 'server-only';

import { createHash } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { adminAuth, adminDb } from '@/lib/server/firebase-admin';
import { exceedsPayloadBudget } from '@/ai/action-auth';
import { effectivePermissions } from '@/lib/household-policy';
import {
  isDeviceCapability,
  isUndoCapability,
  policyOf,
  readPointsPinPolicy,
  requiredLevel,
  requiresOpId,
  UNDO_PROVEN,
  type DeviceCapability,
  type DeviceCapabilityPolicy,
  type RequiredLevel,
} from '@/lib/devices/action-policy';
import { PIN_SESSION_IDLE_MS } from '@/lib/devices/pins';
import { readDeviceSettings } from '@/lib/devices/settings';
import { readDeviceClaims, type DeviceClaims } from '@/lib/devices/types';
import { classifyVerifyError } from '@/lib/devices/verify-errors';
import type { HouseholdPermission, HouseholdRole } from '@/lib/types';
import { DeviceActionError } from '@/lib/server/device-errors';
import { devicesEnabled } from '@/lib/server/device-identity';
import { takeRateSlot } from '@/lib/server/device-management';
import { writeDeviceAudit } from '@/lib/server/device-audit';
import {
  appliedEntry,
  classifyActionAttempt,
  classifyUndoAttempt,
  opRef,
  readDeviceOp,
  tombstoneEntry,
  undoneUpdate,
  type DeviceOp,
  type DeviceOpReplay,
} from '@/lib/server/device-ops';

export { DeviceActionError } from '@/lib/server/device-errors';

// The device action gate (docs/modules/devices/README.md, "The device action gate").
// Every device mutation passes `authorizeDeviceAction` once (fast refusal, rate limits,
// PIN session lookup), then runs the returned `hooks.precheck` as the first statement
// of its own transaction (the same checks, re-read inside it, so a removal, re-pair,
// PIN change or member removal that commits first is always seen) and
// `hooks.finalize` as its last (op ledger entry and the PIN-session slide). Nothing
// the client sends about role, level, permissions, names or the device is used.

type Tx = FirebaseFirestore.Transaction;
type DocRef = FirebaseFirestore.DocumentReference;

/** Request size budget (8.4 step 1). */
export const DEVICE_REQUEST_MAX_BYTES = 16 * 1024;
/** Gated calls per minute per tablet (8.4 step 2). */
export const GATE_LIMIT_PER_MINUTE = 60;
/** Queued intents: not older than 24 h, not more than 5 min in the future (JC-18). */
export const QUEUED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const QUEUED_MAX_FUTURE_MS = 5 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_SECRET = /^[A-Za-z0-9_-]{43}$/;
const ELIGIBLE_ROLES: readonly HouseholdRole[] = ['owner', 'admin', 'member', 'child'];

export type DeviceActionRequest = {
  /** The device's Firebase ID token. */
  idToken: string;
  /** Must equal the token's hh_household. */
  householdId: string;
  /** The server looks up the policy; the client never sends a level. */
  capability: DeviceCapability | string;
  /** Required for every class except 'device'. */
  actorUid?: string;
  /** The in-memory PIN session secret, when the tablet holds one. */
  pinSessionId?: string;
  /** Required for every mutating face/PIN capability (a client UUID). */
  opId?: string;
  /** Replay from the offline queue. */
  queued?: { createdAt: string };
};

/** Stored as `deviceAttribution` next to the module's actor fields (section 12.1). */
export type DeviceAttribution = {
  deviceId: string;
  /** Frozen at write time, for history. */
  deviceName: string;
  generation: number;
  /** The module's actor field carries the same uid (possibly `kid_…`). */
  actorUid: string;
  level: 'face' | 'pin';
};

export type DeviceActor = {
  uid: string;
  name: string;
  role: 'owner' | 'admin' | 'member' | 'child';
  kind: 'account' | 'identity';
  permissions: Record<HouseholdPermission, boolean>;
};

export type DevicePrecheck = {
  /** The ledger already holds this opId as applied: return it and write nothing. */
  replay?: DeviceOpReplay;
  /** Undo capabilities: the original action's ledger entry (null: not applied yet). */
  original?: DeviceOp | null;
  /** Undo capabilities: what the ledger says to do. */
  undo?: 'tombstone' | 'already' | 'applied';
};

export type DeviceFinalizeOutcome = {
  /** The record the action created or changed (`households/h/...`). */
  targetPath: string;
  /** Returned to retries with the same opId; ids and counts, no PII beyond names on the record. */
  summary: Record<string, unknown>;
  /** The changed record's display name for the activity log (PIN-level actions). */
  targetName?: string | null;
  /** Undo capabilities: `reversed` (entry becomes undone), `tombstone`, or `already` (no write). */
  undo?: 'reversed' | 'tombstone' | 'already';
};

export type DeviceTxHooks = {
  /**
   * READS ONLY. Re-reads the device record, household, actor's membership, PIN record
   * and session (when one is required or presented) and the op ledger entry, and
   * re-applies every check of 8.4. Returns `{ replay }` when the ledger already holds
   * this opId as applied: the operation must return it and write nothing.
   */
  precheck(tx: Tx): Promise<DevicePrecheck>;
  /** WRITES ONLY, called last: the op ledger entry, the PIN-session slide, the activity entry. */
  finalize(tx: Tx, outcome: DeviceFinalizeOutcome): void;
};

export type DeviceAuthority = {
  deviceId: string;
  deviceName: string;
  generation: number;
  householdId: string;
  timeZone: string;
  actor: DeviceActor | null;
  level: 'face' | 'pin' | 'device';
  capability: DeviceCapability;
  opId: string | null;
  /** Section 12, ready to store (null for the 'device' class). */
  attribution: DeviceAttribution | null;
  /** The server clock this authorization used (also used by the hooks). */
  now: Date;
  hooks: DeviceTxHooks;
};

export const sessionIdFor = (secret: string) => createHash('sha256').update(secret).digest('hex');

export const householdRefOf = (householdId: string) => adminDb.collection('households').doc(householdId);
export const deviceRecordRef = (householdRef: DocRef, deviceId: string) => householdRef.collection('devices').doc(deviceId);
export const pinRecordRef = (householdRef: DocRef, uid: string) =>
  householdRef.collection('members').doc(uid).collection('private').doc('pin');
export const memberGuardRef = (householdRef: DocRef, uid: string) =>
  householdRef.collection('members').doc(uid).collection('private').doc('pinGuard');
export const deviceGuardRef = (householdRef: DocRef, deviceId: string, uid: string) =>
  householdRef.collection('devices').doc(deviceId).collection('pinGuards').doc(uid);
export const pinSessionRef = (householdRef: DocRef, deviceId: string, secret: string) =>
  householdRef.collection('devices').doc(deviceId).collection('pinSessions').doc(sessionIdFor(secret));

const millis = (value: unknown): number | null => {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return null;
};

/** The unverified `hh_device` claim, for keying the rate limit before verification (a forged key only limits itself). */
export const unverifiedDeviceKey = (idToken: unknown): string => {
  if (typeof idToken !== 'string' || idToken.length > 8192) return 'invalid';
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { hh_device?: unknown };
    return typeof payload.hh_device === 'string' && /^[A-Za-z0-9]{1,40}$/.test(payload.hh_device) ? payload.hh_device : 'invalid';
  } catch {
    return 'invalid';
  }
};

/**
 * 8.4 step 3 and the first half of step 4: the token is valid and not revoked (revoked,
 * disabled or deleted users: `device_revoked`; invalid or expired: `unauthenticated`; a
 * verifier outage: `unavailable`, which never ends a tablet's session), a
 * well-formed device principal (a personal token: `not_a_device`) of this household.
 */
export const verifyDeviceToken = async (idToken: unknown, householdId: unknown): Promise<DeviceClaims> => {
  if (typeof idToken !== 'string' || !idToken) throw new DeviceActionError('unauthenticated');
  let decoded;
  try {
    decoded = await adminAuth.verifyIdToken(idToken, true);
  } catch (error) {
    // Same reading as verifyDevice (F1): only a verdict on the credential ends a tablet's
    // session; a verifier outage is `unavailable` (retry later, never a re-pair).
    const failure = classifyVerifyError(error);
    if (failure === 'revoked') throw new DeviceActionError('device_revoked');
    if (failure === 'invalid') throw new DeviceActionError('unauthenticated');
    console.warn('Device token could not be verified right now.', error instanceof Error ? error.message : String(error));
    throw new DeviceActionError('unavailable');
  }
  const claims = readDeviceClaims({ ...decoded, uid: decoded.uid, email: decoded.email, signInProvider: decoded.firebase?.sign_in_provider });
  if (!claims) throw new DeviceActionError('not_a_device');
  if (typeof householdId !== 'string' || claims.hh_household !== householdId) throw new DeviceActionError('wrong_household');
  return claims;
};

/** 8.4 steps 4-5: the household exists and is not being deleted; the record is active at the token's generation. */
export const checkHouseholdAndRecord = (household: FirebaseFirestore.DocumentSnapshot, record: FirebaseFirestore.DocumentSnapshot, claims: DeviceClaims) => {
  if (!household.exists || household.get('deletingAt')) throw new DeviceActionError('household_deleting');
  if (!record.exists || record.get('status') !== 'active' || record.get('generation') !== claims.hh_gen) {
    throw new DeviceActionError('device_revoked');
  }
};

/** A display name fit for a device (never an email). */
export const publicName = (value: unknown): string => {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && !/\S+@\S+/.test(name) ? name.slice(0, 80) : 'Member';
};

/**
 * 8.4 step 7: the actor is an active owner, admin, member or child of this household
 * (accounts and kid profiles), never a guest, a pending or departing person, or a device.
 */
export const checkActorEligible = (actorUid: unknown, member: FirebaseFirestore.DocumentSnapshot | null): DeviceActor => {
  if (typeof actorUid !== 'string' || !actorUid) throw new DeviceActionError('actor_required');
  if (actorUid.startsWith('device_') || !member || !member.exists) throw new DeviceActionError('actor_not_member');
  const data = member.data() || {};
  if (data.role === 'guest') throw new DeviceActionError('actor_guest');
  const status = data.status ?? 'active';
  if (status !== 'active' || !ELIGIBLE_ROLES.includes(data.role)) throw new DeviceActionError('actor_inactive');
  const role = data.role as DeviceActor['role'];
  return {
    uid: actorUid,
    name: publicName(data.displayName),
    role,
    kind: data.kind === 'identity' ? 'identity' : 'account',
    permissions: effectivePermissions({ uid: actorUid, role, status: 'active', permissions: data.permissions && typeof data.permissions === 'object' ? data.permissions : {} }),
  };
};

/** The member has a PIN set (a hash is stored). */
export const hasPin = (pin: FirebaseFirestore.DocumentSnapshot | null): boolean =>
  Boolean(pin?.exists && typeof pin.get('hash') === 'string' && pin.get('hash'));

/**
 * A PIN session is valid for this use (7.5): not ended; not expired; for this actor; at
 * the device's current generation; at the member's current pinVersion with a PIN set;
 * the member's role unchanged since the unlock; and fresh enough when the capability
 * asks for it. Returns the refusal, or null when valid.
 */
export const pinSessionProblem = (
  session: FirebaseFirestore.DocumentSnapshot | null,
  context: { actorUid: string; generation: number; pin: FirebaseFirestore.DocumentSnapshot | null; role: string; now: Date; freshPinSec?: number },
): 'pin_session_invalid' | 'pin_fresh_required' | null => {
  if (!session || !session.exists) return 'pin_session_invalid';
  const data = session.data() || {};
  const expiresAt = millis(data.expiresAt);
  if (data.endedAt || expiresAt === null || context.now.getTime() >= expiresAt) return 'pin_session_invalid';
  if (data.memberUid !== context.actorUid || data.generation !== context.generation) return 'pin_session_invalid';
  if (!hasPin(context.pin) || data.pinVersion !== context.pin!.get('pinVersion')) return 'pin_session_invalid';
  if (data.roleAtUnlock !== context.role) return 'pin_session_invalid';
  if (context.freshPinSec !== undefined) {
    const createdAt = millis(data.createdAt);
    if (createdAt === null || context.now.getTime() - createdAt > context.freshPinSec * 1000) return 'pin_fresh_required';
  }
  return null;
};

type GateSnapshots = {
  household: FirebaseFirestore.DocumentSnapshot;
  record: FirebaseFirestore.DocumentSnapshot;
  member: FirebaseFirestore.DocumentSnapshot | null;
  pin: FirebaseFirestore.DocumentSnapshot | null;
  session: FirebaseFirestore.DocumentSnapshot | null;
};

type Evaluation = {
  actor: DeviceActor | null;
  level: 'face' | 'pin' | 'device';
  required: RequiredLevel;
  /** A valid session is in use (slide it when the action commits). */
  sessionInUse: boolean;
  deviceName: string;
  timeZone: string;
};

/** Steps 4-10 of 8.4 over a consistent set of reads (outside or inside a transaction). */
const evaluate = (
  snaps: GateSnapshots,
  claims: DeviceClaims,
  request: { capability: DeviceCapability; actorUid?: string; pinSessionId?: string },
  policy: DeviceCapabilityPolicy,
  now: Date,
  undoProven: ReadonlySet<DeviceCapability>,
): Evaluation => {
  checkHouseholdAndRecord(snaps.household, snaps.record, claims);
  const settings = readDeviceSettings(snaps.record.data());
  const timeZone = typeof snaps.household.get('timeZone') === 'string' ? snaps.household.get('timeZone') as string : 'America/Chicago';
  // Step 6: the section is on (Home is always on; automation never is).
  if (policy.section !== 'home') {
    const on = policy.section === 'automation' ? false : settings.sections[policy.section] === true;
    if (!on) throw new DeviceActionError('section_off');
  }
  if (policy.levelClass === 'device') {
    return { actor: null, level: 'device', required: 'device', sessionInUse: false, deviceName: settings.name, timeZone };
  }
  // Step 7: the actor.
  const actor = checkActorEligible(request.actorUid, snaps.member);
  // Step 8: capability.
  if (policy.levelClass === 'admin-pin') {
    if (actor.role !== 'owner' && actor.role !== 'admin') throw new DeviceActionError('admin_pin_required');
  } else if (policy.permissions) {
    if (!policy.permissions.some(permission => actor.permissions[permission])) throw new DeviceActionError('forbidden');
  }
  // Step 9: the level this action needs now.
  const required = requiredLevel(request.capability, { pointsPin: readPointsPinPolicy(snaps.household.data()), actorRole: actor.role }, undoProven);
  // Step 10: PIN.
  if (required === 'pin' || required === 'admin-pin') {
    if (!hasPin(snaps.pin)) throw new DeviceActionError('no_pin_set');
    if (!request.pinSessionId) throw new DeviceActionError('pin_required');
    const problem = pinSessionProblem(snaps.session, {
      actorUid: actor.uid, generation: claims.hh_gen, pin: snaps.pin, role: actor.role, now,
      freshPinSec: required === 'admin-pin' ? policy.freshPinSec : undefined,
    });
    if (problem) throw new DeviceActionError(problem);
    return { actor, level: 'pin', required, sessionInUse: true, deviceName: settings.name, timeZone };
  }
  // Face: a valid session supplied records the PIN level; an invalid one is ignored.
  const sessionValid = Boolean(request.pinSessionId) && !pinSessionProblem(snaps.session, {
    actorUid: actor.uid, generation: claims.hh_gen, pin: snaps.pin, role: actor.role, now,
  });
  return { actor, level: sessionValid ? 'pin' : 'face', required, sessionInUse: sessionValid, deviceName: settings.name, timeZone };
};

/** Section 11.3 limits for queued replays. */
const checkQueued = (queued: DeviceActionRequest['queued'], policy: DeviceCapabilityPolicy, required: RequiredLevel, now: Date) => {
  if (!queued) return;
  const createdAt = typeof queued.createdAt === 'string' ? Date.parse(queued.createdAt) : NaN;
  if (!Number.isFinite(createdAt)) throw new DeviceActionError('invalid_input');
  if (createdAt > now.getTime() + QUEUED_MAX_FUTURE_MS || now.getTime() - createdAt > QUEUED_MAX_AGE_MS) {
    throw new DeviceActionError('stale_intent');
  }
  if (!policy.queueable) throw new DeviceActionError('invalid_input');
  // A queued intent was confirmed at face level; if a PIN is now needed it is refused, never upgraded.
  if (required !== 'face') throw new DeviceActionError('pin_required');
};

/**
 * Checks once outside any transaction and returns the authority, with the hooks that
 * re-check inside the mutation's own transaction (S1). Throws DeviceActionError.
 */
export async function authorizeDeviceAction(
  request: DeviceActionRequest,
  now: Date = new Date(),
  options: { undoProven?: ReadonlySet<DeviceCapability> } = {},
): Promise<DeviceAuthority> {
  const undoProven = options.undoProven ?? UNDO_PROVEN;
  // Step 1: shape.
  if (!request || typeof request !== 'object' || exceedsPayloadBudget(request, DEVICE_REQUEST_MAX_BYTES)) {
    throw new DeviceActionError('invalid_input');
  }
  if (!isDeviceCapability(request.capability)) throw new DeviceActionError('unclassified');
  const capability = request.capability;
  const policy = policyOf(capability);
  // Permanent: not offered on tablets. Distinct from `unavailable` (flag off, outage: retry).
  if (policy.levelClass === 'not_on_tablets' || policy.levelClass === 'never') throw new DeviceActionError('not_on_tablets');
  if (!devicesEnabled()) throw new DeviceActionError('unavailable');
  const needsOpId = requiresOpId(capability);
  if (needsOpId && (typeof request.opId !== 'string' || !UUID.test(request.opId))) throw new DeviceActionError('invalid_input');
  const opId = needsOpId ? request.opId!.toLowerCase() : null;
  // The actor as sent (checked at step 7); only a well-formed uid is ever looked up.
  const rawActor = typeof request.actorUid === 'string' ? request.actorUid : undefined;
  const actorUid = rawActor && rawActor.length <= 128 && !rawActor.includes('/') && !rawActor.startsWith('device_') ? rawActor : undefined;
  const secret = typeof request.pinSessionId === 'string' && SESSION_SECRET.test(request.pinSessionId) ? request.pinSessionId : undefined;
  // A malformed secret is a session that does not exist.
  const presented = request.pinSessionId !== undefined && request.pinSessionId !== null && request.pinSessionId !== '';
  // Step 2: rate, before the token's network check.
  if (!takeRateSlot(`gate:${unverifiedDeviceKey(request.idToken)}`, GATE_LIMIT_PER_MINUTE, now.getTime())) {
    throw new DeviceActionError('rate_limited');
  }
  // Steps 3-4: token and household.
  const claims = await verifyDeviceToken(request.idToken, request.householdId);
  const householdRef = householdRefOf(claims.hh_household);
  const recordRef = deviceRecordRef(householdRef, claims.hh_device);
  const needsActor = policy.levelClass !== 'device';
  const memberRef = needsActor && actorUid ? householdRef.collection('members').doc(actorUid) : null;
  const pinRef = memberRef && actorUid ? pinRecordRef(householdRef, actorUid) : null;
  const sessionRef = memberRef && secret ? pinSessionRef(householdRef, claims.hh_device, secret) : null;
  const evaluationRequest = { capability, actorUid: rawActor, pinSessionId: presented ? request.pinSessionId : undefined };

  const read = async (get: (ref: DocRef) => Promise<FirebaseFirestore.DocumentSnapshot>): Promise<GateSnapshots> => {
    const [household, record, member, pin, session] = await Promise.all([
      get(householdRef),
      get(recordRef),
      memberRef ? get(memberRef) : Promise.resolve(null),
      pinRef ? get(pinRef) : Promise.resolve(null),
      sessionRef ? get(sessionRef) : Promise.resolve(null),
    ]);
    return { household, record, member, pin, session };
  };

  const first = evaluate(await read(ref => ref.get()), claims, evaluationRequest, policy, now, undoProven);
  // Step 11: queued replay.
  checkQueued(request.queued, policy, first.required, now);

  const ledgerRef = opId ? opRef(householdRef, claims.hh_device, opId) : null;
  const undo = isUndoCapability(capability);
  const deviceCreatedAt = request.queued && typeof request.queued.createdAt === 'string' ? request.queued.createdAt : null;

  const attributionOf = (evaluation: Evaluation): DeviceAttribution | null => evaluation.actor && evaluation.level !== 'device'
    ? { deviceId: claims.hh_device, deviceName: evaluation.deviceName, generation: claims.hh_gen, actorUid: evaluation.actor.uid, level: evaluation.level }
    : null;

  const authority: DeviceAuthority = {
    deviceId: claims.hh_device,
    deviceName: first.deviceName,
    generation: claims.hh_gen,
    householdId: claims.hh_household,
    timeZone: first.timeZone,
    actor: first.actor,
    level: first.level,
    capability,
    opId,
    attribution: attributionOf(first),
    now,
    hooks: {
      precheck: async () => { throw new Error('unreachable'); },
      finalize: () => { throw new Error('unreachable'); },
    },
  };
  let current = first;

  authority.hooks = {
    precheck: async (tx: Tx) => {
      const [snaps, ledger] = await Promise.all([
        read(ref => tx.get(ref)),
        ledgerRef ? tx.get(ledgerRef) : Promise.resolve(null),
      ]);
      current = evaluate(snaps, claims, evaluationRequest, policy, now, undoProven);
      checkQueued(request.queued, policy, current.required, now);
      authority.actor = current.actor;
      authority.level = current.level;
      authority.deviceName = current.deviceName;
      authority.attribution = attributionOf(current);
      if (!ledger || !current.actor) return {};
      const entry = readDeviceOp(ledger);
      if (undo) {
        const plan = classifyUndoAttempt(entry, capability);
        return plan.kind === 'applied' ? { undo: 'applied', original: plan.entry } : { undo: plan.kind, original: entry };
      }
      const plan = classifyActionAttempt(entry, { capability, actorUid: current.actor.uid, generation: claims.hh_gen });
      return plan.kind === 'replay' ? { replay: plan.replay } : {};
    },
    finalize: (tx: Tx, outcome: DeviceFinalizeOutcome) => {
      if (ledgerRef && current.actor) {
        if (!undo) {
          tx.set(ledgerRef, appliedEntry({
            capability, actorUid: current.actor.uid, generation: claims.hh_gen, targetPath: outcome.targetPath,
            summary: outcome.summary, deviceCreatedAt, now,
          }));
        } else if (outcome.undo === 'reversed') {
          tx.update(ledgerRef, undoneUpdate(now));
        } else if (outcome.undo === 'tombstone') {
          tx.set(ledgerRef, tombstoneEntry({ undoCapability: capability, actorUid: current.actor.uid, generation: claims.hh_gen, deviceCreatedAt, now }));
        }
      }
      if (current.level === 'pin' && current.actor) {
        writeDeviceAudit(tx, householdRef, {
          action: 'device.action', actorUid: current.actor.uid, actorName: current.actor.name, via: 'device',
          deviceId: claims.hh_device, deviceName: current.deviceName, level: 'pin',
          targetName: outcome.targetName ?? null, details: { capability },
        }, now);
      }
      // The session slides last: every gated use that passes keeps it alive for 2 idle minutes.
      if (current.sessionInUse && sessionRef) {
        tx.update(sessionRef, {
          lastUsedAt: Timestamp.fromDate(now),
          expiresAt: Timestamp.fromMillis(now.getTime() + PIN_SESSION_IDLE_MS),
        });
      }
    },
  };
  return authority;
}

/**
 * The capability's actor rule against the target record, applied by the feature
 * operation inside its transaction after reading the target (8.4 step 8). `originalUid`
 * is the original action's actor (ledger) or the record's author.
 */
export const assertActorRule = (authority: Pick<DeviceAuthority, 'capability' | 'actor' | 'level'>, originalUid: string | null | undefined) => {
  const policy = policyOf(authority.capability);
  const actor = authority.actor;
  if (!policy.actorRule) return;
  if (!actor) throw new DeviceActionError('actor_required');
  const own = typeof originalUid === 'string' && originalUid === actor.uid;
  if (own) return;
  const permission = policy.actorRulePermission;
  if (policy.actorRule === 'original-actor') throw new DeviceActionError('forbidden');
  if (policy.actorRule === 'original-actor-or-delete-permission') {
    if (permission && actor.permissions[permission] && authority.level === 'pin') return;
    throw new DeviceActionError(permission && actor.permissions[permission] ? 'pin_required' : 'forbidden');
  }
  if (permission && actor.permissions[permission]) return;
  throw new DeviceActionError('forbidden');
};

export type { DeviceOpReplay };

/** Ends a PIN session ("Done" or the tablet's idle timer). Best effort; the server expiry stands. */
export const endPinSessionRecord = async (claims: DeviceClaims, secret: unknown, now: Date): Promise<{ ended: boolean }> => {
  if (typeof secret !== 'string' || !SESSION_SECRET.test(secret)) return { ended: false };
  const householdRef = householdRefOf(claims.hh_household);
  const ref = pinSessionRef(householdRef, claims.hh_device, secret);
  return adminDb.runTransaction(async tx => {
    const [household, record, session] = await Promise.all([
      tx.get(householdRef), tx.get(deviceRecordRef(householdRef, claims.hh_device)), tx.get(ref),
    ]);
    checkHouseholdAndRecord(household, record, claims);
    if (!session.exists || session.get('endedAt')) return { ended: false };
    tx.update(ref, { endedAt: Timestamp.fromDate(now), endedReason: 'done' });
    return { ended: true };
  });
};

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
export const isSessionSecret = (value: unknown): value is string => typeof value === 'string' && SESSION_SECRET.test(value);
