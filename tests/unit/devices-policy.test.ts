import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  DEVICE_ACTION_POLICY,
  DEVICE_CAPABILITIES,
  UNDO_PROVEN,
  backdatedCapability,
  deviceRefusalResponse,
  UNDO_OF,
  isDeviceCapability,
  isUndoCapability,
  readPointsPinPolicy,
  undoAccepts,
  requiredLevel,
  requiresOpId,
  type DeviceCapability,
  type DeviceCapabilityPolicy,
  type DeviceRefusal,
} from '../../src/lib/devices/action-policy';
import {
  DEVICE_LOCK_CAP_MS,
  MEMBER_FAILURES_SINCE_SUCCESS_LOCK,
  clearedDeviceGuard,
  clearedMemberGuard,
  deviceLockDuration,
  emptyDeviceGuard,
  emptyMemberGuard,
  reserveDeviceGuard,
  reserveMemberGuard,
  settleDeviceGuardCorrect,
  settleMemberGuardCorrect,
  validatePinFormat,
  type DeviceGuard,
  type MemberGuard,
} from '../../src/lib/devices/pins';
import { PIN_SCRYPT_PARAMS, currentPepperId, hashPinValue, hashesEqual, newPinSalt, pepperFor } from '../../src/lib/server/pin-hash';
import { isChildIdentityUid, kidAvatarPathOf, readChildName } from '../../src/lib/devices/child-identities';
import { addressBucket, sweepRateWindows, takeRateWindowSlot, type RateWindows } from '../../src/lib/devices/rate-window';
import { saveKidProfile, type KidSaveDeps } from '../../src/components/household/kid-profile-save';
import { assignablePeople, personFromMemberRecord } from '../../src/lib/member-directory';
import { canAssignRole, canTransferOwnership } from '../../src/lib/household-policy';
import { describeAuditActor } from '../../src/components/household/household-model';
import { endsTabletSession } from '../../src/lib/devices/verify-errors';

// The device action policy (docs/modules/devices/README.md, "The device action gate"):
// the 8.2 table, required levels (face* without Undo proof, points PIN), refusal copy
// (8.5); PIN format and lockout arithmetic (R2: per-attempt ids); PIN hashing with the
// production scrypt parameters; kid-profile helpers and consumers.

const policy = (capability: DeviceCapability): DeviceCapabilityPolicy => DEVICE_ACTION_POLICY[capability];

describe('policy table', () => {
  it('only device and admin-pin entries have permissions null; no entry has an empty list', () => {
    for (const capability of DEVICE_CAPABILITIES) {
      const entry = policy(capability);
      if (entry.levelClass === 'device' || entry.levelClass === 'admin-pin') {
        assert.equal(entry.permissions, null, capability);
      } else if (entry.levelClass === 'face' || entry.levelClass === 'pin') {
        assert.ok(Array.isArray(entry.permissions) && entry.permissions.length > 0, `${capability} needs a permission list`);
      }
      if (entry.permissions !== null) assert.notEqual(entry.permissions.length, 0, capability);
    }
  });

  it('every Pets flow of 8.2 is classified, with the lead decisions (JC-14: profile edits PIN; photo unavailable)', () => {
    const expected: Record<string, string> = {
      'pets.feed': 'face', 'pets.feed.backdated': 'face', 'pets.feed.backdated.old': 'pin', 'pets.feed.undo': 'face',
      'pets.dose.give': 'face', 'pets.dose.give.old': 'pin', 'pets.dose.undo': 'face',
      'pets.care.add': 'face', 'pets.care.undo': 'face', 'pets.note.add': 'face', 'pets.note.undo': 'face',
      'pets.weight.add': 'face', 'pets.weight.undo': 'face',
      'pets.note.pin': 'pin', 'pets.note.unpin': 'pin', 'pets.note.editPinned': 'pin', 'pets.note.delete': 'pin',
      'pets.log.delete': 'pin', 'pets.log.correctTime': 'pin', 'pets.medication.confirmLegacy': 'pin',
      'pets.course.edit': 'pin', 'pets.course.finish': 'pin', 'pets.slots.confirm': 'pin', 'pets.slots.edit': 'pin',
      'pets.profile.edit': 'pin', 'pets.pet.create': 'pin', 'pets.pet.delete': 'pin', 'pets.photo.upload': 'not_on_tablets',
    };
    for (const [capability, levelClass] of Object.entries(expected)) {
      assert.ok(isDeviceCapability(capability), capability);
      assert.equal(policy(capability as DeviceCapability).levelClass, levelClass, capability);
      if (levelClass === 'face') assert.equal(policy(capability as DeviceCapability).faceNeedsUndoProof, true, `${capability} is face*`);
      assert.equal(policy(capability as DeviceCapability).section, 'pets');
      assert.ok(!policy(capability as DeviceCapability).points, `${capability} never asks for the points PIN (WT-22d)`);
    }
    assert.deepEqual(policy('pets.course.finish').permissions, ['pets.addLogs']);
    assert.deepEqual(policy('pets.profile.edit').permissions, ['pets.editProfiles']);
    assert.equal(policy('pets.feed.undo').actorRule, 'original-actor-or-delete-permission');
    assert.equal(policy('pets.feed.undo').actorRulePermission, 'pets.deleteLogs');
  });

  it('chores: complete, take and their Undo are face* points actions; the rest not on tablets', () => {
    for (const capability of ['chores.complete', 'chores.complete.undo', 'chores.take', 'chores.take.undo'] as const) {
      assert.equal(policy(capability).levelClass, 'face');
      assert.equal(policy(capability).faceNeedsUndoProof, true);
      assert.equal(policy(capability).points, true);
    }
    assert.deepEqual(policy('chores.take').permissions, ['chores.assign']);
    for (const capability of ['chores.steps.tick', 'chores.move', 'chores.reopen.own', 'chores.reopen.others', 'chores.reassign.others',
      'chores.edit.repeats', 'chores.manager', 'chores.leaderboard.hide', 'chores.delete', 'chores.upkeep'] as const) {
      assert.equal(policy(capability).levelClass, 'not_on_tablets', capability);
    }
  });

  it('shopping, maintenance, AI, household admin and automation are not on tablets; personal things never', () => {
    for (const capability of DEVICE_CAPABILITIES) {
      if (/^(shopping|maintenance|ai|household|automation)\./.test(capability)) assert.equal(policy(capability).levelClass, 'not_on_tablets', capability);
    }
    for (const capability of ['profile.edit', 'push.register', 'notifications.targeted', 'reminders.personal'] as const) {
      assert.equal(policy(capability).levelClass, 'never');
    }
  });

  it('device capabilities: heartbeat and comfort need no actor; settings and exits a fresh admin PIN (30 s)', () => {
    assert.equal(policy('device.heartbeat').levelClass, 'device');
    assert.equal(policy('device.comfort').levelClass, 'device');
    for (const capability of ['device.settings', 'device.exit.remove', 'device.exit.personal', 'device.exit.newCode'] as const) {
      assert.equal(policy(capability).levelClass, 'admin-pin');
      assert.equal(policy(capability).freshPinSec, 30);
    }
  });

  it('an unknown action name is not a capability (refused as unclassified)', () => {
    assert.equal(isDeviceCapability('pets.feed.everything'), false);
    assert.equal(isDeviceCapability('toString'), false);
    assert.equal(isDeviceCapability(undefined), false);
  });

  it('UNDO_PROVEN is empty until the 10.4 proof lands (F4)', () => {
    assert.equal(UNDO_PROVEN.size, 0);
  });

  it('opIds are required for face and PIN capabilities only', () => {
    assert.equal(requiresOpId('pets.feed'), true);
    assert.equal(requiresOpId('pets.pet.delete'), true);
    assert.equal(requiresOpId('device.comfort'), false);
    assert.equal(requiresOpId('device.settings'), false);
  });

  it('only face actions may queue', () => {
    for (const capability of DEVICE_CAPABILITIES) {
      if (policy(capability).queueable) assert.equal(policy(capability).levelClass, 'face', capability);
    }
  });
});

describe('Undo targets (Codex P2: explicit map, no prefix matching)', () => {
  const expected: Record<string, string[]> = {
    'pets.feed.undo': ['pets.feed', 'pets.feed.backdated', 'pets.feed.backdated.old'],
    'pets.dose.undo': ['pets.dose.give', 'pets.dose.give.old'],
    'pets.care.undo': ['pets.care.add'],
    'pets.note.undo': ['pets.note.add'],
    'pets.weight.undo': ['pets.weight.add'],
    'chores.complete.undo': ['chores.complete'],
    'chores.take.undo': ['chores.take'],
    'notifications.dismiss.undo': ['notifications.dismiss'],
  };

  it('every Undo capability has an explicit list of the actions it reverses, and nothing else is a key', () => {
    const undos = DEVICE_CAPABILITIES.filter(isUndoCapability).sort();
    assert.deepEqual(Object.keys(UNDO_OF).sort(), undos);
    assert.deepEqual(Object.keys(expected).sort(), undos);
    for (const [undo, targets] of Object.entries(UNDO_OF)) {
      assert.deepEqual([...targets].sort(), [...expected[undo]].sort(), undo);
      for (const target of targets) assert.ok(isDeviceCapability(target) && !isUndoCapability(target), `${undo} -> ${target}`);
    }
  });

  it('across every pair of catalog capabilities, an Undo accepts only its mapped actions', () => {
    let accepted = 0;
    for (const undo of DEVICE_CAPABILITIES) {
      for (const forward of DEVICE_CAPABILITIES) {
        const ok = undoAccepts(undo, forward);
        const want = isUndoCapability(undo) && (expected[undo] ?? []).includes(forward);
        assert.equal(ok, want, `${undo} on ${forward}`);
        if (ok) accepted += 1;
      }
    }
    assert.equal(accepted, Object.values(expected).flat().length);
    // The prefix trap: a note Undo never reverses pin/unpin/edit/delete of a note.
    for (const forward of ['pets.note.pin', 'pets.note.unpin', 'pets.note.editPinned', 'pets.note.delete'] as const) {
      assert.equal(undoAccepts('pets.note.undo', forward), false);
    }
    assert.equal(undoAccepts('pets.feed.undo', 'pets.feed.undo'), false);
    assert.equal(undoAccepts('pets.feed.undo', 'pets.feed.anything'), false);
  });
});

describe('required level', () => {
  const adult = { pointsPin: 'off' as const, actorRole: 'member' as const };
  const proven = new Set<DeviceCapability>(['pets.feed', 'chores.complete']);

  it('face* is PIN until its Undo is proven, then face', () => {
    assert.equal(requiredLevel('pets.feed', adult), 'pin');
    assert.equal(requiredLevel('pets.feed', adult, proven), 'face');
    assert.equal(requiredLevel('pets.pet.delete', adult, proven), 'pin');
    assert.equal(requiredLevel('device.settings', adult), 'admin-pin');
    assert.equal(requiredLevel('device.comfort', adult), 'device');
    assert.equal(requiredLevel('shopping.add', adult), 'not_on_tablets');
    assert.equal(requiredLevel('profile.edit', adult), 'never');
  });

  it('points PIN: Off / Kids only (Child role) / Everyone; never for feeding (WT-22d)', () => {
    const cases: Array<['off' | 'kids' | 'everyone', 'child' | 'member' | 'owner', string]> = [
      ['off', 'child', 'face'], ['off', 'owner', 'face'],
      ['kids', 'child', 'pin'], ['kids', 'member', 'face'], ['kids', 'owner', 'face'],
      ['everyone', 'child', 'pin'], ['everyone', 'member', 'pin'], ['everyone', 'owner', 'pin'],
    ];
    for (const [pointsPin, actorRole, level] of cases) {
      assert.equal(requiredLevel('chores.complete', { pointsPin, actorRole }, proven), level, `${pointsPin}/${actorRole}`);
      assert.equal(requiredLevel('pets.feed', { pointsPin, actorRole }, proven), 'face');
    }
  });

  it('reads the household setting, defaulting to Off', () => {
    assert.equal(readPointsPinPolicy(undefined), 'off');
    assert.equal(readPointsPinPolicy({}), 'off');
    assert.equal(readPointsPinPolicy({ devicePolicy: { pointsPin: 'kids' } }), 'kids');
    assert.equal(readPointsPinPolicy({ devicePolicy: { pointsPin: 'sometimes' } }), 'off');
  });

  it('backdated feeds and doses: face* within 12 hours, PIN when older (JC-27)', () => {
    const now = new Date('2026-11-14T20:00:00Z');
    assert.equal(backdatedCapability('feed', new Date('2026-11-14T08:00:00Z'), now), 'pets.feed.backdated');
    assert.equal(backdatedCapability('feed', new Date('2026-11-14T07:59:59Z'), now), 'pets.feed.backdated.old');
    assert.equal(backdatedCapability('dose', new Date('2026-11-14T19:00:00Z'), now), 'pets.dose.give');
    assert.equal(backdatedCapability('dose', new Date('2026-11-13T19:00:00Z'), now), 'pets.dose.give.old');
  });
});

describe('refusal copy (8.5)', () => {
  it('maps every code to a tablet response', () => {
    const codes: DeviceRefusal[] = ['unauthenticated', 'device_revoked', 'not_a_device', 'wrong_household', 'household_deleting',
      'section_off', 'unavailable', 'not_on_tablets', 'unclassified', 'actor_required', 'actor_not_member', 'actor_inactive', 'actor_guest', 'forbidden',
      'admin_pin_required', 'no_pin_set', 'pin_required', 'pin_fresh_required', 'pin_session_invalid', 'pin_wrong', 'pin_locked',
      'pin_locked_member', 'pin_unavailable', 'changed_since', 'undo_expired', 'already_undone', 'not_undoable', 'stale_intent',
      'rate_limited', 'busy', 'invalid_input', 'conflict', 'failed'];
    for (const code of codes) assert.ok(deviceRefusalResponse(code).kind, code);
  });

  it('uses the agreed wording', () => {
    assert.deepEqual(deviceRefusalResponse('device_revoked'), { kind: 'revoked', message: 'This tablet was removed.' });
    assert.deepEqual(deviceRefusalResponse('household_deleting'), { kind: 'revoked', message: 'This household is being deleted.' });
    assert.deepEqual(deviceRefusalResponse('section_off'), { kind: 'message', message: "That isn't available on this tablet.", leaveSection: true });
    assert.equal((deviceRefusalResponse('unclassified') as { message: string }).message, "That isn't available on wall tablets yet. Use your phone.");
    assert.equal((deviceRefusalResponse('not_on_tablets') as { message: string }).message, "That isn't available on wall tablets yet. Use your phone.");
    assert.equal((deviceRefusalResponse('unavailable') as { message: string }).message, "Can't reach HomeHub right now. Try again in a moment.");
    assert.deepEqual(deviceRefusalResponse('actor_required'), { kind: 'who' });
    assert.equal((deviceRefusalResponse('actor_guest', { name: 'Mia' }) as { message: string }).message, "Mia can't do that from this tablet any more.");
    assert.equal((deviceRefusalResponse('forbidden', { name: 'Mia' }) as { message: string }).message, "Mia's role doesn't allow that.");
    assert.equal((deviceRefusalResponse('admin_pin_required') as { message: string }).message, 'An owner or admin PIN is needed.');
    assert.equal((deviceRefusalResponse('no_pin_set', { name: 'Alex' }) as { message: string }).message, 'Alex needs a PIN first. Set one from your phone in Profile.');
    assert.equal((deviceRefusalResponse('no_pin_set', { name: 'Mia', kid: true }) as { message: string }).message, 'Mia needs a PIN first. Ask a parent to set one.');
    assert.deepEqual(deviceRefusalResponse('pin_required'), { kind: 'pin-pad' });
    assert.deepEqual(deviceRefusalResponse('pin_fresh_required'), { kind: 'pin-pad' });
    assert.deepEqual(deviceRefusalResponse('pin_session_invalid'), { kind: 'pin-pad', message: 'Enter your PIN again.' });
    assert.equal((deviceRefusalResponse('pin_wrong') as { message: string }).message, "That PIN isn't right.");
    assert.equal((deviceRefusalResponse('pin_locked', { retryAfterSec: 125 }) as { message: string }).message, 'Too many tries. Try again in 3 min.');
    assert.equal((deviceRefusalResponse('pin_locked_member') as { message: string }).message, 'PIN locked. An owner or admin can unlock it from their phone.');
    assert.equal((deviceRefusalResponse('pin_unavailable') as { message: string }).message, "PINs aren't working right now. Try again later.");
    assert.equal((deviceRefusalResponse('undo_expired') as { message: string }).message, 'Too late to undo.');
    assert.deepEqual(deviceRefusalResponse('already_undone'), { kind: 'silent' });
    assert.deepEqual(deviceRefusalResponse('stale_intent'), { kind: 'queue' });
    assert.equal((deviceRefusalResponse('busy') as { message: string }).message, 'One moment, try again.');
    assert.equal((deviceRefusalResponse('conflict') as { message: string }).message, "Couldn't save. Try again.");
  });
});

describe('not on tablets vs unavailable', () => {
  it('a capability not offered on tablets is permanent; an outage is retryable; neither ends the session', () => {
    const permanent = deviceRefusalResponse('not_on_tablets');
    const outage = deviceRefusalResponse('unavailable');
    assert.equal(permanent.kind, 'message');
    assert.equal(outage.kind, 'message');
    assert.notEqual((permanent as { message: string }).message, (outage as { message: string }).message);
    assert.equal((permanent as { retry?: true }).retry, undefined);
    assert.equal((outage as { retry?: true }).retry, true);
    // F1's session rule: only verdicts on the credential end a tablet's session.
    assert.equal(endsTabletSession('unavailable'), false);
    assert.equal(endsTabletSession('not_on_tablets'), false);
    assert.equal(deviceRefusalResponse('device_revoked').kind, 'revoked');
  });

  it('every not-on-tablets and never capability is refused with not_on_tablets by class', () => {
    for (const capability of DEVICE_CAPABILITIES) {
      const levelClass = policy(capability).levelClass;
      if (levelClass === 'not_on_tablets' || levelClass === 'never') {
        assert.ok(['not_on_tablets', 'never'].includes(requiredLevel(capability, { pointsPin: 'off', actorRole: 'member' })));
      }
    }
  });
});

describe('PIN format (D-T11, JC-11)', () => {
  it('accepts 4-6 digits that are not all the same and not a straight run', () => {
    for (const pin of ['2580', '13579', '402917', '1123', '9870']) assert.ok(validatePinFormat(pin).ok, pin);
    for (const pin of ['123', '1234567', '12a4', '', ' 1234', '0000', '777777', '1234', '0123', '987654', '3210', 1234, null]) {
      assert.equal(validatePinFormat(pin).ok, false, String(pin));
    }
  });
});

describe('lockout arithmetic', () => {
  const t0 = Date.parse('2026-11-14T12:00:00Z');
  const fail = (guard: DeviceGuard, id: string, now = t0) => {
    const result = reserveDeviceGuard(guard, id, now);
    assert.ok(!('refused' in result), `${id} refused`);
    return result as { guard: DeviceGuard; seq: number };
  };

  it('5 consecutive failures lock for 1 min, then 2, 4, 8, capped at 15', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(deviceLockDuration), [60_000, 120_000, 240_000, 480_000, 900_000, DEVICE_LOCK_CAP_MS]);
    let guard = emptyDeviceGuard();
    let now = t0;
    for (let round = 1; round <= 5; round++) {
      for (let i = 0; i < 4; i++) guard = fail(guard, `r${round}-${i}`, now).guard;
      const locking = fail(guard, `r${round}-lock`, now);
      guard = locking.guard;
      assert.equal(guard.lockouts, round);
      assert.equal(guard.lockedUntil, now + deviceLockDuration(round));
      const refused = reserveDeviceGuard(guard, 'while-locked', now + 1000);
      assert.ok('refused' in refused && refused.refused === 'pin_locked');
      now = guard.lockedUntil!;
    }
  });

  it('a correct PIN resets the guard, but never failures recorded by concurrent attempts (R2)', () => {
    let guard = fail(emptyDeviceGuard(), 'a').guard;
    guard = fail(guard, 'b').guard;
    const mine = fail(guard, 'mine');
    guard = mine.guard;
    // A concurrent attempt reserved after mine and counted.
    guard = fail(guard, 'c').guard;
    const settled = settleDeviceGuardCorrect(guard, mine.seq);
    assert.deepEqual(settled.attempts.map(a => a.id), ['c']);
    assert.equal(settled.failures, 1);
    assert.equal(settled.lockouts, 0);
  });

  it('a correct PIN that triggered the lock in advance lifts it; a later concurrent lock stays', () => {
    let guard = emptyDeviceGuard();
    for (const id of ['a', 'b', 'c', 'd']) guard = fail(guard, id).guard;
    const mine = fail(guard, 'mine');
    assert.ok(mine.guard.lockedUntil);
    assert.equal(settleDeviceGuardCorrect(mine.guard, mine.seq).lockedUntil, null);
    // Another attempt locked it after mine was reserved.
    guard = emptyDeviceGuard();
    const early = fail(guard, 'early');
    guard = early.guard;
    for (const id of ['b', 'c', 'd', 'e']) guard = fail(guard, id).guard;
    assert.ok(guard.lockedUntil);
    const settled = settleDeviceGuardCorrect(guard, early.seq);
    assert.equal(settled.lockedUntil, guard.lockedUntil);
    assert.equal(settled.lockouts, 1);
  });

  it('member guard: 20 failures within an hour hard-lock; older ones fall out; a correct PIN removes only its own entry', () => {
    let guard: MemberGuard = emptyMemberGuard();
    for (let i = 0; i < 19; i++) {
      const result = reserveMemberGuard(guard, `f${i}`, t0 + i * 1000);
      assert.ok(!('refused' in result));
      guard = result.guard;
      assert.equal(result.locked, false);
    }
    // An hour later the first ones no longer count.
    const later = reserveMemberGuard(guard, 'late', t0 + 60 * 60_000 + 500);
    assert.ok(!('refused' in later) && !later.locked);
    const twentieth = reserveMemberGuard(guard, 'twentieth', t0 + 30_000);
    assert.ok(!('refused' in twentieth) && twentieth.locked);
    const locked = (twentieth as { guard: MemberGuard }).guard;
    assert.ok('refused' in reserveMemberGuard(locked, 'next', t0 + 31_000));
    // The 20th was right: it lifts only its own lock and entry.
    const settled = settleMemberGuardCorrect(locked, 'twentieth', (twentieth as { seq: number }).seq);
    assert.equal(settled.lockedAt, null);
    assert.equal(settled.recentFailures.length, 19);
    // Someone else's correct PIN never lifts it.
    assert.ok(settleMemberGuardCorrect(locked, 'f3', 4).lockedAt);
  });

  it('slow guessing: 50 failures since the last correct PIN hard-lock, whatever the pace (security review 1)', () => {
    let guard: MemberGuard = emptyMemberGuard();
    // One failure every 4 minutes never reaches 20 within an hour ...
    for (let i = 0; i < MEMBER_FAILURES_SINCE_SUCCESS_LOCK - 1; i++) {
      const result = reserveMemberGuard(guard, `slow${i}`, t0 + i * 4 * 60_000);
      assert.ok(!('refused' in result) && !result.locked, `failure ${i}`);
      guard = result.guard;
    }
    // ... but the 50th since the last correct PIN locks.
    const fiftieth = reserveMemberGuard(guard, 'slow49', t0 + 49 * 4 * 60_000);
    assert.ok(!('refused' in fiftieth) && fiftieth.locked);
    assert.equal((fiftieth as { guard: MemberGuard }).guard.lockedReason, 'total');
    // A correct PIN in between forgives the earlier ones (not concurrent later ones).
    const early = (reserveMemberGuard(emptyMemberGuard(), 'early', t0) as { guard: MemberGuard }).guard;
    const mine = reserveMemberGuard(early, 'right', t0 + 1) as { guard: MemberGuard; seq: number };
    const later = reserveMemberGuard(mine.guard, 'concurrent', t0 + 2) as { guard: MemberGuard; seq: number };
    const settled = settleMemberGuardCorrect(later.guard, 'right', mine.seq);
    assert.deepEqual(settled.sinceSuccess.map(f => f.id), ['concurrent']);
  });

  it('clearing a lockout keeps the sequence numbers monotonic (security review 4)', () => {
    let device = emptyDeviceGuard();
    for (const id of ['a', 'b', 'c']) device = (reserveDeviceGuard(device, id, t0) as { guard: DeviceGuard }).guard;
    const inflight = reserveDeviceGuard(device, 'inflight', t0) as { guard: DeviceGuard; seq: number };
    const cleared = clearedDeviceGuard(inflight.guard);
    assert.equal(cleared.seq, inflight.guard.seq);
    assert.equal(cleared.failures, 0);
    // A failure after the clear stays when the earlier in-flight attempt turns out right.
    const after = reserveDeviceGuard(cleared, 'after', t0) as { guard: DeviceGuard; seq: number };
    assert.ok(after.seq > inflight.seq);
    assert.deepEqual(settleDeviceGuardCorrect(after.guard, inflight.seq).attempts.map(a => a.id), ['after']);
    const member = reserveMemberGuard(emptyMemberGuard(), 'm', t0) as { guard: MemberGuard; seq: number };
    assert.equal(clearedMemberGuard(member.guard).seq, member.seq);
    assert.deepEqual(clearedMemberGuard(member.guard).sinceSuccess, []);
  });
});

describe('rate windows (security review 2)', () => {
  it('counts per key per minute', () => {
    const windows: RateWindows = new Map();
    for (let i = 0; i < 3; i++) assert.ok(takeRateWindowSlot(windows, 'k', 3, 1000));
    assert.equal(takeRateWindowSlot(windows, 'k', 3, 1000), false);
    assert.ok(takeRateWindowSlot(windows, 'k', 3, 61_001));
  });

  it('deletes keys whose window has emptied and stays bounded', () => {
    const windows: RateWindows = new Map();
    const options = { sweepEvery: 10, maxKeys: 100 };
    for (let i = 0; i < 50; i++) takeRateWindowSlot(windows, `old${i}`, 5, 0, options);
    for (let i = 0; i < 10; i++) takeRateWindowSlot(windows, `new${i}`, 5, 120_000, options);
    assert.ok([...windows.keys()].every(key => key.startsWith('new')), 'emptied windows were swept');
    sweepRateWindows(windows, 300_000);
    assert.equal(windows.size, 0);
    for (let i = 0; i < 500; i++) takeRateWindowSlot(windows, `flood${i}`, 5, 400_000, options);
    assert.ok(windows.size <= 100);
    assert.ok(windows.has('flood499'));
  });

  it('IPv6 addresses share a bucket per /64; IPv4 and mapped IPv4 stay per address', () => {
    assert.equal(addressBucket('2001:db8:1:2:aaaa::1'), addressBucket('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    assert.notEqual(addressBucket('2001:db8:1:2::1'), addressBucket('2001:db8:1:3::1'));
    assert.equal(addressBucket('2001:0db8:0001:0002::1'), '2001:db8:1:2::/64');
    assert.equal(addressBucket('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(addressBucket('::ffff:203.0.113.9'), '203.0.113.9');
    assert.equal(addressBucket('203.0.113.9'), '203.0.113.9');
    assert.equal(addressBucket('unknown'), 'unknown');
  });
});

describe('PIN hashing (S7)', () => {
  it('hashes with the production parameters (async scrypt, explicit maxmem) and compares in constant time', async () => {
    assert.deepEqual({ ...PIN_SCRYPT_PARAMS }, { alg: 'scrypt', N: 32768, r: 8, p: 1, keyLen: 32, maxmem: 64 * 1024 * 1024 });
    const pepper = Buffer.from('p'.repeat(40));
    const salt = newPinSalt();
    const a = await hashPinValue('2580', salt, pepper);
    const b = await hashPinValue('2580', salt, pepper);
    const c = await hashPinValue('2581', salt, pepper);
    const d = await hashPinValue('2580', salt, Buffer.from('q'.repeat(40)));
    assert.equal(a.length, 32);
    assert.ok(hashesEqual(a, b));
    assert.ok(!hashesEqual(a, c));
    assert.ok(!hashesEqual(a, d));
  });

  it('peppers come from the server environment and fail closed when missing or short', () => {
    const env = { HOMEHUB_PIN_PEPPER_CURRENT: 'v2', HOMEHUB_PIN_PEPPER_v2: 'x'.repeat(32), HOMEHUB_PIN_PEPPER_v1: 'short' };
    assert.equal(currentPepperId(env), 'v2');
    assert.ok(pepperFor('v2', env));
    assert.equal(pepperFor('v1', env), null);
    assert.equal(pepperFor('../x', env), null);
    assert.equal(currentPepperId({}), null);
    assert.equal(currentPepperId({ HOMEHUB_PIN_PEPPER_CURRENT: 'v3' }), null);
  });

  it('resolves the production id V1 case-exact to HOMEHUB_PIN_PEPPER_V1 (apphosting.yaml)', () => {
    const secret = 's'.repeat(48);
    const env = { HOMEHUB_PIN_PEPPER_CURRENT: 'V1', HOMEHUB_PIN_PEPPER_V1: secret };
    assert.equal(currentPepperId(env), 'V1');
    assert.equal(pepperFor('V1', env)?.toString('utf8'), secret);
    // Never a case-folded name.
    assert.equal(pepperFor('v1', env), null);
    assert.equal(currentPepperId({ HOMEHUB_PIN_PEPPER_CURRENT: 'V1', HOMEHUB_PIN_PEPPER_v1: secret }), null);
    // The repository's apphosting.yaml names exactly these variables.
    const yaml = readFileSync('apphosting.yaml', 'utf8');
    assert.match(yaml, /- variable: HOMEHUB_PIN_PEPPER_V1\r?\n\s+secret: homehubPinPepperV1\r?\n\s+availability:\r?\n\s+- RUNTIME\r?\n/);
    assert.match(yaml, /- variable: HOMEHUB_PIN_PEPPER_CURRENT\r?\n\s+value: V1\r?\n/);
  });
});

describe('kid profiles', () => {
  it('uid, name and photo path helpers', () => {
    assert.ok(isChildIdentityUid('kid_ABCDEFGHIJ0123456789'));
    assert.equal(isChildIdentityUid('kid_short'), false);
    assert.equal(isChildIdentityUid('device_ABCDEFGHIJ0123456789'), false);
    assert.equal(readChildName('  Mia  '), 'Mia');
    assert.equal(readChildName('mia@example.com'), null);
    assert.equal(readChildName('x'.repeat(41)), null);
    const path = 'households/H/members/kid_ABCDEFGHIJ0123456789/avatar/a.png';
    assert.equal(kidAvatarPathOf(`https://firebasestorage.googleapis.com/v0/b/bucket/o/${encodeURIComponent(path)}?alt=media`, 'bucket'), path);
    // Only the app's own bucket (security review 8); no bucket configured: nothing accepted.
    assert.equal(kidAvatarPathOf(`https://firebasestorage.googleapis.com/v0/b/other-bucket/o/${encodeURIComponent(path)}?alt=media`, 'bucket'), null);
    assert.equal(kidAvatarPathOf(`https://firebasestorage.googleapis.com/v0/b/bucket/o/${encodeURIComponent(path)}?alt=media`, ''), null);
    assert.equal(kidAvatarPathOf(`https://evil.example/v0/b/bucket/o/${encodeURIComponent(path)}`, 'bucket'), null);
    assert.equal(kidAvatarPathOf(`https://firebasestorage.googleapis.com/v0/b/bucket/o/${encodeURIComponent('users/u/avatars/a.png')}`, 'bucket'), null);
  });

  it('the member directory includes kid profiles (names, leaderboard) but pickers leave them out (HO-15d)', () => {
    const kid = personFromMemberRecord({ uid: 'kid_ABCDEFGHIJ0123456789', kind: 'identity', role: 'child', status: 'active', displayName: 'Mia' })!;
    const adult = personFromMemberRecord({ uid: 'u1', role: 'member', status: 'active', displayName: 'Alex' })!;
    assert.equal(kid.kind, 'identity');
    assert.equal(adult.kind, undefined);
    assert.deepEqual(assignablePeople([kid, adult]).map(p => p.uid), ['u1']);
    assert.deepEqual(assignablePeople([kid, adult], kid.uid).map(p => p.uid), [kid.uid, 'u1']);
  });

  it('a kid profile has a fixed role and cannot own the household', () => {
    const owner = { uid: 'o', role: 'owner' as const, status: 'active' as const };
    const kid = { uid: 'kid_ABCDEFGHIJ0123456789', role: 'child' as const, status: 'active' as const, kind: 'identity' as const };
    assert.deepEqual(canAssignRole(owner, kid, 'member'), { ok: false, reason: 'identity_fixed_role' });
    assert.deepEqual(canTransferOwnership(owner, kid), { ok: false, reason: 'target_identity' });
    assert.deepEqual(canAssignRole(owner, { ...kid, kind: 'account' as const }, 'member'), { ok: true });
  });
});

describe('kid profile save (Codex B: a retry after a failed photo step never duplicates)', () => {
  const deps = (log: string[], failUpdate: () => boolean): KidSaveDeps => ({
    create: async (name) => { log.push(`create:${name}`); return { ok: true, childId: 'kid_NEW00000000000000000' }; },
    upload: async (childId) => { log.push(`upload:${childId}`); return 'https://photo'; },
    update: async (childId, patch) => { log.push(`update:${childId}:${Object.keys(patch).sort().join(',')}`); return !failUpdate(); },
  });

  it('a failed update after create keeps the new id; the retry updates that profile', async () => {
    const log: string[] = [];
    let fail = true;
    const first = await saveKidProfile(deps(log, () => fail), { existingId: null }, { name: 'Mia', photo: {} as File, removePhoto: false });
    assert.deepEqual(first, { ok: false, childId: 'kid_NEW00000000000000000' });
    fail = false;
    const retry = await saveKidProfile(deps(log, () => fail), { existingId: first.childId }, { name: 'Mia', photo: {} as File, removePhoto: false });
    assert.deepEqual(retry, { ok: true, childId: 'kid_NEW00000000000000000' });
    assert.equal(log.filter(entry => entry.startsWith('create')).length, 1);
    assert.deepEqual(log, [
      'create:Mia', 'upload:kid_NEW00000000000000000', 'update:kid_NEW00000000000000000:avatarUrl',
      'upload:kid_NEW00000000000000000', 'update:kid_NEW00000000000000000:avatarUrl,name',
    ]);
  });

  it('create without a photo needs no update; editing sends the name', async () => {
    const log: string[] = [];
    assert.deepEqual(await saveKidProfile(deps(log, () => false), { existingId: null }, { name: 'Noa', photo: null, removePhoto: false }),
      { ok: true, childId: 'kid_NEW00000000000000000' });
    assert.deepEqual(log, ['create:Noa']);
    const edit: string[] = [];
    await saveKidProfile(deps(edit, () => false), { existingId: 'kid_OLD00000000000000000' }, { name: 'Noah', photo: null, removePhoto: true });
    assert.deepEqual(edit, ['update:kid_OLD00000000000000000:avatarUrl,name']);
  });
});

describe('activity attribution (WT-18b)', () => {
  it('shows the person, the level and the tablet', () => {
    assert.equal(describeAuditActor({ actorName: 'Alex', via: 'device', deviceName: 'Kitchen tablet', level: 'pin' }), 'as Alex (PIN) on Kitchen tablet');
    assert.equal(describeAuditActor({ actorName: 'Alex', via: 'device', deviceName: 'Kitchen tablet', level: 'face' }), 'as Alex (face) on Kitchen tablet');
    assert.equal(describeAuditActor({ actorName: 'Olive', via: 'devices-list', deviceName: 'Kitchen tablet' }), 'Olive');
  });
});
