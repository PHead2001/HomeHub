import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  GUEST_PASS_HOURS,
  accessUntilMs,
  memberIsCurrent,
  guestPassEnded,
  guestPassLabel,
  hasGuestPass,
  isGuestIdentityUid,
  passUntilText,
  readGuestName,
  readGuestPassHours,
  readTabletPassUntil,
  tabletPassOverrides,
} from '../../src/lib/guest-pass';
import { canTransferOwnership } from '../../src/lib/household-policy';
import { guestPassCurrent, isApprovedMemberAt } from '../../functions/src/push-policy';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const ts = (ms: number) => ({ toMillis: () => ms });

describe('guest passes (HO-14, HO-24)', () => {
  test('pass lengths are 4 hours, 1 day or 1 week, nothing else', () => {
    assert.deepEqual([...GUEST_PASS_HOURS], [4, 24, 168]);
    for (const hours of GUEST_PASS_HOURS) assert.equal(readGuestPassHours(hours), hours);
    for (const bad of [0, 5, '4', null, undefined, 1e9]) assert.equal(readGuestPassHours(bad), null);
    assert.deepEqual(GUEST_PASS_HOURS.map(guestPassLabel), ['4 hours', '1 day', '1 week']);
  });

  test('accessUntil is read from a Timestamp, a Date, an ISO string or a number', () => {
    assert.equal(accessUntilMs(ts(NOW)), NOW);
    assert.equal(accessUntilMs(new Date(NOW)), NOW);
    assert.equal(accessUntilMs(new Date(NOW).toISOString()), NOW);
    assert.equal(accessUntilMs(NOW), NOW);
    assert.equal(accessUntilMs(null), null);
    assert.equal(accessUntilMs('soon'), null);
  });

  test('a pass ends at its time; no pass never ends; an unreadable one counts as ended', () => {
    assert.equal(guestPassEnded({}, NOW), false);
    assert.equal(guestPassEnded({ accessUntil: null }, NOW), false);
    assert.equal(guestPassEnded({ accessUntil: ts(NOW + 1) }, NOW), false);
    assert.equal(guestPassEnded({ accessUntil: ts(NOW) }, NOW), true);
    assert.equal(guestPassEnded({ accessUntil: 'garbage' }, NOW), true);
    assert.equal(hasGuestPass({ accessUntil: ts(NOW) }), true);
    assert.equal(hasGuestPass({}), false);
  });

  test('memberIsCurrent: active and not past a guest pass', () => {
    assert.equal(memberIsCurrent({}, NOW), true);
    assert.equal(memberIsCurrent({ status: 'active', accessUntil: ts(NOW + 1) }, NOW), true);
    assert.equal(memberIsCurrent({ status: 'active', accessUntil: ts(NOW) }, NOW), false);
    assert.equal(memberIsCurrent({ status: 'pending' }, NOW), false);
    assert.equal(memberIsCurrent(null, NOW), false);
  });

  test('push delivery skips an ended pass, as the rules do', () => {
    const guest = { uid: 'g', role: 'guest', status: 'active' };
    assert.equal(isApprovedMemberAt(guest, NOW), true);
    assert.equal(isApprovedMemberAt({ ...guest, accessUntil: ts(NOW + 60_000) }, NOW), true);
    assert.equal(isApprovedMemberAt({ ...guest, accessUntil: ts(NOW) }, NOW), false);
    assert.equal(guestPassCurrent('2099-01-01', NOW), false, 'not a Timestamp: fail closed');
  });

  test('someone on a pass can never become the owner', () => {
    const owner = { uid: 'o', role: 'owner' as const, status: 'active' as const };
    const guest = { uid: 'g', role: 'guest' as const, status: 'active' as const, guestPass: true };
    assert.deepEqual(canTransferOwnership(owner, guest), { ok: false, reason: 'target_guest_pass' });
    assert.deepEqual(canTransferOwnership(owner, { ...guest, status: 'expired' as const }), { ok: false, reason: 'target_pending' });
  });

  test('tablet passes: ids, names, abilities and an end within a week', () => {
    assert.equal(isGuestIdentityUid('guest_ABCDEFGHIJKLMNOPQRST'), true);
    assert.equal(isGuestIdentityUid('kid_ABCDEFGHIJKLMNOPQRST'), false);
    assert.equal(isGuestIdentityUid('guest_short'), false);
    assert.equal(readGuestName('  Babysitter  '), 'Babysitter');
    assert.equal(readGuestName('sam@example.com'), null);
    assert.equal(readGuestName('x'.repeat(41)), null);
    assert.deepEqual(tabletPassOverrides({ feedPets: true, tickChores: true }), { 'pets.addLogs': true, 'chores.complete': true });
    assert.deepEqual(tabletPassOverrides({}), {});
    assert.equal(readTabletPassUntil(NOW + 3_600_000, NOW), NOW + 3_600_000);
    assert.equal(readTabletPassUntil(NOW - 1, NOW), null);
    assert.equal(readTabletPassUntil(NOW + 8 * 24 * 3_600_000, NOW), null);
  });

  test('"until" reads in the household time zone', () => {
    const at = Date.parse('2026-08-01T15:00:00.000Z'); // 10:00 AM in Chicago
    assert.equal(passUntilText(Date.parse('2026-08-02T04:00:00.000Z'), at, 'America/Chicago'), 'until 11:00 PM');
    assert.equal(passUntilText(Date.parse('2026-08-03T04:00:00.000Z'), at, 'America/Chicago'), 'until Sun, Aug 2, 11:00 PM');
  });
});
