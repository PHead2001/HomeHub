import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '../../src/lib/server/firebase-admin';
import {
  DeviceActionError,
  assertActorRule,
  authorizeDeviceAction,
  type DeviceActionRequest,
} from '../../src/lib/server/device-gate';
import { createDeviceRepairCode, redeemDeviceCode, removeDevice, updateDeviceSettings } from '../../src/lib/server/device-management';
import { setChildPin, setMyPin, verifyDevicePin } from '../../src/lib/server/pins';
import { updateDeviceComfort } from '../../src/lib/server/device-comfort';
import { deviceOperationContext } from '../../src/lib/server/operation-context';
import { deviceHeartbeatAction, updateDeviceComfortAction } from '../../src/app/devices/actions';
import type { DeviceCapability } from '../../src/lib/devices/action-policy';
import { deleteDeviceUsers, nonce, personToken, seedHousehold, signIn, type Person } from './device-test-helpers';
import { clock, house, opId, pairTablet, seedKid, type Tablet } from './device-actor-helpers';

// The device action gate (docs/modules/devices/README.md, "The device action gate";
// design 8.3-8.5, S1): every check of 8.4 in order with its refusal code, forged
// actor/level/capability, other household, guest, removed device, wrong generation,
// section off, points-PIN policies, PIN session binding and freshness, queued replays,
// the in-transaction precheck and the op ledger (replay, conflict, tombstone).

const H = 'gate-house';
const HB = 'gate-house-b';
const HD = 'gate-house-deleting';
const owner: Person = { uid: 'g-owner', email: 'g.owner@example.test', displayName: 'Olive', role: 'owner' };
const admin: Person = { uid: 'g-admin', email: 'g.admin@example.test', displayName: 'Ada', role: 'admin' };
const member: Person = { uid: 'g-member', email: 'g.member@example.test', displayName: 'Max', role: 'member' };
const child: Person = { uid: 'g-child', email: 'g.child@example.test', displayName: 'Cleo', role: 'child' };
const guest: Person = { uid: 'g-guest', email: 'g.guest@example.test', displayName: 'Gus', role: 'guest' };
const pending: Person = { uid: 'g-pending', email: 'g.pending@example.test', displayName: 'Pat', role: 'member' };
const ownerB: Person = { uid: 'g-owner-b', email: 'g.ownerb@example.test', displayName: 'Bea', role: 'owner' };
const memberB: Person = { uid: 'g-member-b', email: 'g.memberb@example.test', displayName: 'Ben', role: 'member' };
const ownerD: Person = { uid: 'g-owner-d', email: 'g.ownerd@example.test', displayName: 'Dee', role: 'owner' };
const KID = 'kid_GateKid0000000000000';
const PIN = { owner: '2580', admin: '1357', member: '4826', kid: '9314' };
const created = new Set<string>();

let tablet: Tablet;
let tabletB: Tablet;
const time = clock();
const proven = new Set<DeviceCapability>(['pets.feed', 'chores.complete', 'chores.take', 'notifications.dismiss']);

const refused = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DeviceActionError, `expected DeviceActionError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
};

const req = (extra: Partial<DeviceActionRequest> = {}, t: Tablet = tablet): DeviceActionRequest => ({
  idToken: t.idToken, householdId: H, capability: 'pets.feed', actorUid: member.uid, opId: opId(), ...extra,
});

/** A fresh PIN session for `actorUid` on a tablet, at the suite clock. */
const unlock = async (actorUid: string, pin: string, t: Tablet = tablet, at = time.now()) =>
  (await verifyDevicePin({ idToken: t.idToken, householdId: H, actorUid, pin }, { now: at })).pinSessionId;

before(async () => {
  await seedHousehold(H, [owner, admin, member, child, guest]);
  await house(H).collection('members').doc(pending.uid).set({ uid: pending.uid, role: 'newuser', status: 'pending', displayName: 'Pat' });
  await seedKid(H, KID, 'Mia');
  await seedHousehold(HB, [ownerB, memberB]);
  await seedHousehold(HD, [ownerD]);
  tablet = await pairTablet(H, owner, created);
  tabletB = await pairTablet(HB, ownerB, created, 'B tablet');
  await setMyPin(owner, { householdId: H, pin: PIN.owner });
  await setMyPin(admin, { householdId: H, pin: PIN.admin });
  await setMyPin(member, { householdId: H, pin: PIN.member });
  await setChildPin(admin, { householdId: H, childId: KID, pin: PIN.kid });
});

after(async () => {
  await deleteDeviceUsers([...created]);
  for (const id of [H, HB, HD]) {
    await adminDb.recursiveDelete(house(id));
    const codes = await adminDb.collection('deviceCodes').where('householdId', '==', id).get();
    await Promise.all(codes.docs.map(d => d.ref.delete()));
  }
});

describe('8.4 step 1: shape', () => {
  test('oversized requests, unknown capabilities, not-on-tablets and never classes, missing or malformed opIds', async () => {
    await refused(authorizeDeviceAction(req({ actorUid: 'x'.repeat(20_000) }), time.now()), 'invalid_input');
    await refused(authorizeDeviceAction(req({ capability: 'pets.feed.everything' }), time.now()), 'unclassified');
    await refused(authorizeDeviceAction(req({ capability: 'shopping.add' }), time.now()), 'not_on_tablets');
    await refused(authorizeDeviceAction(req({ capability: 'ai.parse' }), time.now()), 'not_on_tablets');
    await refused(authorizeDeviceAction(req({ capability: 'profile.edit' }), time.now()), 'not_on_tablets');
    await refused(authorizeDeviceAction(req({ opId: undefined }), time.now()), 'invalid_input');
    await refused(authorizeDeviceAction(req({ opId: 'not-a-uuid' }), time.now()), 'invalid_input');
  });

  test('the server flag off refuses everything (unavailable: retryable, never ends the session)', async () => {
    process.env.HOMEHUB_DEVICES_ENABLED = 'false';
    try {
      await refused(authorizeDeviceAction(req(), time.now()), 'unavailable');
      await refused(verifyDevicePin({ idToken: tablet.idToken, householdId: H, actorUid: member.uid, pin: PIN.member }, { now: time.now() }), 'unavailable');
    } finally {
      process.env.HOMEHUB_DEVICES_ENABLED = 'true';
    }
  });
});

describe('8.4 step 2: rate', () => {
  const forgedFor = (deviceId: string) =>
    `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ hh_device: deviceId, hh_household: H, hh_kind: 'device', hh_gen: 1 })).toString('base64url')}.x`;

  test('forged tokens naming a real tablet never spend its budget (Codex P2: pre-auth limiter)', async () => {
    const victim = await pairTablet(H, owner, created, 'Victim tablet');
    const at = time.advance(61_000);
    for (let i = 0; i < 70; i++) {
      await refused(authorizeDeviceAction(req({ idToken: forgedFor(victim.deviceId) }, victim), at, { clientAddress: '203.0.113.9' }), 'unauthenticated');
    }
    // The real tablet still has its whole budget.
    const authority = await authorizeDeviceAction({ idToken: victim.idToken, householdId: H, capability: 'device.comfort' }, at, { clientAddress: '198.51.100.7' });
    assert.equal(authority.deviceId, victim.deviceId);
  });

  test('60 gated calls a minute per verified tablet; unauthenticated callers are limited per address before verification', async () => {
    const t = await pairTablet(H, owner, created, 'Busy tablet');
    const at = time.advance(61_000);
    for (let i = 0; i < 60; i++) await authorizeDeviceAction({ idToken: t.idToken, householdId: H, capability: 'device.comfort' }, at);
    await refused(authorizeDeviceAction({ idToken: t.idToken, householdId: H, capability: 'device.comfort' }, at), 'rate_limited');
    // One address flooding with forged tokens is cut off before any verification.
    let limited = false;
    for (let i = 0; i < 400 && !limited; i++) {
      limited = await authorizeDeviceAction(req({ idToken: forgedFor('Whatever000000000000') }), at, { clientAddress: '192.0.2.44' })
        .then(() => false, (error: unknown) => error instanceof DeviceActionError && error.code === 'rate_limited');
    }
    assert.ok(limited, 'the per-address pre-auth limit applies');
  });
});

describe('8.4 steps 3-5: token, household, registration', () => {
  test('garbage, personal tokens, another household, a household being deleted', async () => {
    await refused(authorizeDeviceAction(req({ idToken: 'garbage' }), time.now()), 'unauthenticated');
    await refused(authorizeDeviceAction(req({ idToken: await personToken(owner) }), time.now()), 'not_a_device');
    await refused(authorizeDeviceAction(req({ householdId: HB }), time.now()), 'wrong_household');
    const deleting = await pairTablet(HD, ownerD, created, 'D tablet');
    await house(HD).update({ deletingAt: Timestamp.now() });
    await refused(authorizeDeviceAction(req({ householdId: HD, actorUid: ownerD.uid }, deleting), time.now()), 'household_deleting');
  });

  test('a removed tablet and an older credential generation are refused (device_revoked)', async () => {
    const spare = await pairTablet(H, owner, created, 'Spare tablet');
    // Re-paired elsewhere: the old token carries the old generation.
    const { code } = await createDeviceRepairCode(owner, { householdId: H, deviceId: spare.deviceId });
    const repaired = await redeemDeviceCode({ code, nonce: nonce() });
    await refused(authorizeDeviceAction(req({}, spare), time.now()), 'device_revoked');
    const fresh = await signIn(repaired.customToken);
    await authorizeDeviceAction({ idToken: fresh.idToken, householdId: H, capability: 'device.comfort' }, time.now());
    await removeDevice(owner, { householdId: H, deviceId: spare.deviceId });
    await refused(authorizeDeviceAction({ idToken: fresh.idToken, householdId: H, capability: 'device.comfort' }, time.now()), 'device_revoked');
  });
});

describe('8.4 step 6: section', () => {
  test('a capability in a section switched off is refused; Home is always on', async () => {
    const t = await pairTablet(H, owner, created, 'Hall tablet');
    await updateDeviceSettings(owner, { householdId: H, deviceId: t.deviceId, patch: { sections: { pets: false } } });
    await refused(authorizeDeviceAction(req({}, t), time.now()), 'section_off');
    await authorizeDeviceAction({ idToken: t.idToken, householdId: H, capability: 'device.comfort' }, time.now());
  });
});

describe('8.4 step 7: actor', () => {
  test('missing, unknown, another household, guest, pending, device uid', async () => {
    const at = time.advance(61_000);
    await refused(authorizeDeviceAction(req({ actorUid: undefined }), at), 'actor_required');
    await refused(authorizeDeviceAction(req({ actorUid: 'nobody' }), at), 'actor_not_member');
    await refused(authorizeDeviceAction(req({ actorUid: memberB.uid }), at), 'actor_not_member');
    await refused(authorizeDeviceAction(req({ actorUid: guest.uid }), at), 'actor_guest');
    await refused(authorizeDeviceAction(req({ actorUid: pending.uid }), at), 'actor_inactive');
    await refused(authorizeDeviceAction(req({ actorUid: `device_${tablet.deviceId}` }), at), 'actor_not_member');
    await refused(authorizeDeviceAction(req({ actorUid: '../members/g-owner' }), at), 'actor_not_member');
    // Household B's tablet cannot act for household A's members, even naming A.
    await refused(authorizeDeviceAction(req({ householdId: H, actorUid: member.uid }, tabletB), at), 'wrong_household');
  });
});

describe('8.4 steps 8-10: capability, level, PIN', () => {
  test('permissions come from the stored record; admin-PIN capabilities need the owner or admin role', async () => {
    const at = time.advance(61_000);
    const memberSession = await unlock(member.uid, PIN.member, tablet, at);
    await refused(authorizeDeviceAction(req({ capability: 'pets.pet.delete', pinSessionId: memberSession }), at), 'forbidden');
    await refused(authorizeDeviceAction(req({ capability: 'chores.take', actorUid: child.uid }), at), 'forbidden');
    await refused(authorizeDeviceAction(req({ capability: 'device.settings', opId: undefined, pinSessionId: memberSession }), at), 'admin_pin_required');
  });

  test('face* needs a PIN until its Undo is proven; no PIN set → no_pin_set; no session → pin_required', async () => {
    const at = time.advance(61_000);
    await refused(authorizeDeviceAction(req({ actorUid: child.uid }), at), 'no_pin_set');
    await refused(authorizeDeviceAction(req(), at), 'pin_required');
    const session = await unlock(member.uid, PIN.member, tablet, at);
    const authority = await authorizeDeviceAction(req({ pinSessionId: session }), at);
    assert.equal(authority.level, 'pin');
    assert.deepEqual(authority.attribution, { deviceId: tablet.deviceId, deviceName: 'Kitchen tablet', generation: 1, actorUid: member.uid, level: 'pin' });
    assert.equal(authority.actor?.name, 'Max');
  });

  test('once proven, face is enough; a valid session records PIN; an invalid one is ignored', async () => {
    const at = time.advance(61_000);
    const face = await authorizeDeviceAction(req({ actorUid: child.uid }), at, { undoProven: proven });
    assert.equal(face.level, 'face');
    assert.equal(face.attribution?.level, 'face');
    const session = await unlock(member.uid, PIN.member, tablet, at);
    assert.equal((await authorizeDeviceAction(req({ pinSessionId: session }), at, { undoProven: proven })).level, 'pin');
    assert.equal((await authorizeDeviceAction(req({ pinSessionId: 'A'.repeat(43) }), at, { undoProven: proven })).level, 'face');
    assert.equal((await authorizeDeviceAction(req({ actorUid: admin.uid, pinSessionId: session }), at, { undoProven: proven })).level, 'face');
  });

  test('forged level, role and permissions are ignored; an owner face unlocks nothing dangerous (WT-7a)', async () => {
    const at = time.advance(61_000);
    const forged = { ...req({ capability: 'pets.pet.delete', actorUid: owner.uid }), level: 'pin', role: 'owner', permissions: { 'pets.editProfiles': true } } as DeviceActionRequest;
    await refused(authorizeDeviceAction(forged, at, { undoProven: proven }), 'pin_required');
    // A member claiming the owner role and pets.editProfiles is still refused by the stored record.
    const memberForged = { ...req({ capability: 'pets.pet.delete' }), role: 'owner', permissions: { 'pets.editProfiles': true } } as DeviceActionRequest;
    await refused(authorizeDeviceAction(memberForged, at), 'forbidden');
  });

  test('points PIN: Off / Kids only / Everyone (D-T10), feeding never', async () => {
    const at = time.advance(61_000);
    const complete = (actorUid: string) => authorizeDeviceAction(req({ capability: 'chores.complete', actorUid }), at, { undoProven: proven });
    await house(H).update({ devicePolicy: { pointsPin: 'off' } });
    assert.equal((await complete(KID)).level, 'face');
    assert.equal((await complete(member.uid)).level, 'face');
    await house(H).update({ devicePolicy: { pointsPin: 'kids' } });
    await refused(complete(KID), 'pin_required');
    await refused(complete(child.uid), 'no_pin_set');
    assert.equal((await complete(member.uid)).level, 'face');
    const kidSession = await unlock(KID, PIN.kid, tablet, at);
    assert.equal((await authorizeDeviceAction(req({ capability: 'chores.complete', actorUid: KID, pinSessionId: kidSession }), at, { undoProven: proven })).level, 'pin');
    await house(H).update({ devicePolicy: { pointsPin: 'everyone' } });
    await refused(complete(member.uid), 'pin_required');
    await refused(complete(owner.uid), 'pin_required');
    assert.equal((await authorizeDeviceAction(req({ actorUid: member.uid }), at, { undoProven: proven })).level, 'face');
    await house(H).update({ devicePolicy: { pointsPin: 'off' } });
  });

  test('a PIN session is bound to its member, its tablet, its generation; idle expiry and sliding', async () => {
    const at = time.advance(61_000);
    const session = await unlock(member.uid, PIN.member, tablet, at);
    // Another member, another tablet.
    await refused(authorizeDeviceAction(req({ actorUid: admin.uid, pinSessionId: session }), at), 'pin_session_invalid');
    const other = await pairTablet(H, owner, created, 'Other tablet');
    await refused(authorizeDeviceAction(req({ pinSessionId: session }, other), at), 'pin_session_invalid');
    // Idle: 2 minutes after the last use it is gone; each use that commits slides it.
    const authority = await authorizeDeviceAction(req({ pinSessionId: session }), new Date(at.getTime() + 100_000));
    await adminDb.runTransaction(async tx => {
      await authority.hooks.precheck(tx);
      authority.hooks.finalize(tx, { targetPath: `households/${H}/pets/p1/feeding-logs/x`, summary: {} });
    });
    await authorizeDeviceAction(req({ pinSessionId: session }), new Date(at.getTime() + 200_000));
    await refused(authorizeDeviceAction(req({ pinSessionId: session }), new Date(at.getTime() + 221_000)), 'pin_session_invalid');
    const pinActions = (await house(H).collection('auditLogs').where('action', '==', 'device.action').get()).docs.map(d => d.data());
    assert.ok(pinActions.some(entry => entry.actorUid === member.uid && entry.level === 'pin' && entry.deviceName === 'Kitchen tablet' && entry.details?.capability === 'pets.feed'));
  });

  test('admin-PIN capabilities need a session at most 30 s old (S9)', async () => {
    const at = time.advance(60_000);
    const session = await unlock(admin.uid, PIN.admin, tablet, at);
    const settings = (seconds: number) => authorizeDeviceAction({ idToken: tablet.idToken, householdId: H, capability: 'device.settings', actorUid: admin.uid, pinSessionId: session },
      new Date(at.getTime() + seconds * 1000));
    assert.equal((await settings(30)).level, 'pin');
    await refused(settings(31), 'pin_fresh_required');
  });
});

describe('8.4 step 11: queued replays', () => {
  test('stale or future intents, PIN-level intents and non-queueable capabilities are refused', async () => {
    const at = time.advance(61_000);
    const queued = (createdAt: Date, extra: Partial<DeviceActionRequest> = {}) =>
      authorizeDeviceAction(req({ queued: { createdAt: createdAt.toISOString() }, ...extra }), at, { undoProven: proven });
    assert.equal((await queued(new Date(at.getTime() - 60_000))).level, 'face');
    await refused(queued(new Date(at.getTime() - 25 * 3600_000)), 'stale_intent');
    await refused(queued(new Date(at.getTime() + 6 * 60_000)), 'stale_intent');
    await refused(queued(new Date(at.getTime()), { capability: 'pets.feed.backdated.old' }), 'pin_required');
    await refused(queued(new Date(at.getTime()), { capability: 'notifications.dismiss' }), 'invalid_input');
    // A points PIN that became required since the intent was queued: refused, never upgraded.
    await house(H).update({ devicePolicy: { pointsPin: 'everyone' } });
    await refused(queued(new Date(at.getTime()), { capability: 'chores.complete' }), 'pin_required');
    await house(H).update({ devicePolicy: { pointsPin: 'off' } });
  });
});

describe('hooks inside the mutation transaction (S1)', () => {
  test('precheck sees a removal, a member removal and a PIN change committed after authorize', async () => {
    const t = await pairTablet(H, owner, created, 'Race tablet');
    const at = time.advance(61_000);
    const authority = await authorizeDeviceAction(req({ actorUid: child.uid }, t), at, { undoProven: proven });
    await house(H).collection('members').doc(child.uid).update({ status: 'deleting' });
    await refused(adminDb.runTransaction(tx => authority.hooks.precheck(tx)), 'actor_inactive');
    await house(H).collection('members').doc(child.uid).update({ status: 'active' });

    const session = await unlock(member.uid, PIN.member, t, at);
    const pinAuthority = await authorizeDeviceAction(req({ pinSessionId: session }, t), at);
    await setMyPin(member, { householdId: H, pin: '7391' });
    await refused(adminDb.runTransaction(tx => pinAuthority.hooks.precheck(tx)), 'pin_session_invalid');
    await setMyPin(member, { householdId: H, pin: PIN.member });

    const late = await authorizeDeviceAction(req({ actorUid: child.uid }, t), at, { undoProven: proven });
    await removeDevice(owner, { householdId: H, deviceId: t.deviceId });
    await refused(adminDb.runTransaction(tx => late.hooks.precheck(tx)), 'device_revoked');
  });

  test('op ledger: replay with the same opId, conflict for another actor, tombstone before the action', async () => {
    const at = time.advance(61_000);
    const id = opId();
    const run = async (extra: Partial<DeviceActionRequest>) => {
      const authority = await authorizeDeviceAction(req({ opId: id, actorUid: child.uid, ...extra }), at, { undoProven: proven });
      const ctx = deviceOperationContext(authority);
      return adminDb.runTransaction(async tx => {
        const { replay } = await authority.hooks.precheck(tx);
        if (replay) return { replay, actor: ctx.actor };
        authority.hooks.finalize(tx, { targetPath: `households/${H}/pets/p1/feeding-logs/${id}`, summary: { logId: id } });
        return { applied: true, actor: ctx.actor };
      });
    };
    const first = await run({});
    assert.equal((first as { applied?: boolean }).applied, true);
    assert.deepEqual(first.actor.device, { deviceId: tablet.deviceId, deviceName: 'Kitchen tablet', generation: 1, actorUid: child.uid, level: 'face' });
    const second = await run({});
    assert.deepEqual((second as { replay?: unknown }).replay, { idempotent: true, summary: { logId: id }, targetPath: `households/${H}/pets/p1/feeding-logs/${id}` });
    await refused(run({ actorUid: KID }), 'conflict');
    const stored = (await house(H).collection('devices').doc(tablet.deviceId).collection('ops').doc(id).get()).data()!;
    assert.equal(stored.state, 'applied');
    assert.equal(stored.capability, 'pets.feed');
    assert.equal(stored.appliedAt.toMillis(), at.getTime());

    // Undo first (tombstone), then the original: refused, nothing applied.
    const early = opId();
    const undo = await authorizeDeviceAction(req({ capability: 'pets.feed.undo', opId: early, actorUid: child.uid }), at, { undoProven: new Set(['pets.feed.undo']) });
    await adminDb.runTransaction(async tx => {
      const plan = await undo.hooks.precheck(tx);
      assert.equal(plan.undo, 'tombstone');
      undo.hooks.finalize(tx, { targetPath: '', summary: {}, undo: 'tombstone' });
    });
    const original = await authorizeDeviceAction(req({ opId: early, actorUid: child.uid }), at, { undoProven: proven });
    await refused(adminDb.runTransaction(tx => original.hooks.precheck(tx)), 'already_undone');
  });

  test('an Undo is accepted only for the actions it reverses (Codex P2: no prefix matching)', async () => {
    const at = time.advance(61_000);
    const session = await unlock(admin.uid, PIN.admin, tablet, at);
    const id = opId();
    // A PIN-level note pin is applied under this opId ...
    const pinNote = await authorizeDeviceAction(req({ capability: 'pets.note.pin', opId: id, actorUid: admin.uid, pinSessionId: session }), at);
    await adminDb.runTransaction(async tx => {
      await pinNote.hooks.precheck(tx);
      pinNote.hooks.finalize(tx, { targetPath: `households/${H}/pets/p1/notes/n1`, summary: {} });
    });
    // ... and the note-add Undo must not treat it as its own.
    const undo = await authorizeDeviceAction(req({ capability: 'pets.note.undo', opId: id, actorUid: admin.uid, pinSessionId: session }), at);
    await refused(adminDb.runTransaction(tx => undo.hooks.precheck(tx)), 'conflict');
    // A tombstone written by one Undo refuses an unrelated action under the same opId as a conflict.
    const early = opId();
    const feedUndo = await authorizeDeviceAction(req({ capability: 'pets.feed.undo', opId: early, actorUid: admin.uid, pinSessionId: session }), at);
    await adminDb.runTransaction(async tx => {
      assert.equal((await feedUndo.hooks.precheck(tx)).undo, 'tombstone');
      feedUndo.hooks.finalize(tx, { targetPath: '', summary: {}, undo: 'tombstone' });
    });
    const unrelated = await authorizeDeviceAction(req({ capability: 'pets.dose.give', opId: early, actorUid: admin.uid, pinSessionId: session }), at);
    await refused(adminDb.runTransaction(tx => unrelated.hooks.precheck(tx)), 'conflict');
    const backdated = await authorizeDeviceAction(req({ capability: 'pets.feed.backdated', opId: early, actorUid: admin.uid, pinSessionId: session }), at);
    await refused(adminDb.runTransaction(tx => backdated.hooks.precheck(tx)), 'already_undone');
    // The same Undo again is idempotent.
    const again = await authorizeDeviceAction(req({ capability: 'pets.feed.undo', opId: early, actorUid: admin.uid, pinSessionId: session }), at);
    await adminDb.runTransaction(async tx => assert.equal((await again.hooks.precheck(tx)).undo, 'already'));
  });

  test('actor rules: the original actor, or the named permission at PIN level', async () => {
    const at = time.advance(61_000);
    const childUndo = await authorizeDeviceAction(req({ capability: 'pets.feed.undo', actorUid: child.uid }), at, { undoProven: new Set(['pets.feed.undo']) });
    assertActorRule(childUndo, child.uid);
    assert.throws(() => assertActorRule(childUndo, member.uid), (error: unknown) => error instanceof DeviceActionError && error.code === 'forbidden');
    const adminFace = await authorizeDeviceAction(req({ capability: 'pets.feed.undo', actorUid: admin.uid }), at, { undoProven: new Set(['pets.feed.undo']) });
    assert.throws(() => assertActorRule(adminFace, member.uid), (error: unknown) => error instanceof DeviceActionError && error.code === 'pin_required');
    const adminSession = await unlock(admin.uid, PIN.admin, tablet, at);
    const adminPin = await authorizeDeviceAction(req({ capability: 'pets.feed.undo', actorUid: admin.uid, pinSessionId: adminSession }), at, { undoProven: new Set(['pets.feed.undo']) });
    assertActorRule(adminPin, member.uid);
  });
});

describe('device-class actions (no actor)', () => {
  test('comfort from the tablet: comfort fields only, through the gate; heartbeat; personal tokens refused', async () => {
    const result = await updateDeviceComfort({ idToken: tablet.idToken, householdId: H, comfort: { theme: 'dark', textScale: 130 } }, time.now());
    assert.deepEqual(result.changed, ['comfort']);
    const record = (await house(H).collection('devices').doc(tablet.deviceId).get()).data()!;
    assert.equal(record.comfort.theme, 'dark');
    assert.equal(record.updatedVia, 'tablet-comfort');
    await refused(updateDeviceComfort({ idToken: tablet.idToken, householdId: H, comfort: { theme: 'neon' } }, time.now()), 'invalid_input');
    const viaAction = await updateDeviceComfortAction({ idToken: tablet.idToken, householdId: H, comfort: { sound: false } });
    assert.ok(viaAction.ok);
    const personal = await updateDeviceComfortAction({ idToken: await personToken(owner), householdId: H, comfort: { sound: true } });
    assert.equal(personal.ok ? 'ok' : personal.code, 'not_a_device');
    const beat = await deviceHeartbeatAction({ idToken: tablet.idToken, householdId: H, appVersion: '20261114T120000000Z' });
    assert.ok(beat.ok);
  });
});
