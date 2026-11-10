import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  HOUSEHOLD_NAME_MAX,
  PENDING_REMINDER_INTERVAL_HOURS,
  householdIdFor,
  normalizeTimeZone,
  pendingReminderDue,
  pendingReminderStateKey,
  readHouseholdName,
  slugifyHouseholdName,
} from '../../src/lib/household-records';
import { HOUSEHOLD_NAME_MAX as MODEL_NAME_MAX, householdNameError } from '../../src/components/household/household-model';
import { canRemindPendingMembers } from '../../src/lib/household-policy';
import type { HouseholdRole } from '../../src/lib/types';

describe('household name', () => {
  test('trims and accepts 1-80 characters', () => {
    assert.deepEqual(readHouseholdName('  Maple Street '), { ok: true, name: 'Maple Street' });
    assert.deepEqual(readHouseholdName('x'.repeat(80)), { ok: true, name: 'x'.repeat(80) });
  });

  test('refuses empty, blank, over-long and non-string names with the inline wording', () => {
    for (const raw of ['', '   ', undefined, null, 7, {}]) {
      assert.deepEqual(readHouseholdName(raw), { ok: false, message: 'Give your household a name.' });
    }
    assert.deepEqual(readHouseholdName('x'.repeat(81)), { ok: false, message: 'Keep it under 80 characters.' });
  });

  test('the server check and the form check agree', () => {
    assert.equal(MODEL_NAME_MAX, HOUSEHOLD_NAME_MAX);
    for (const raw of ['', ' ', 'Home', 'x'.repeat(80), 'x'.repeat(81)]) {
      const checked = readHouseholdName(raw);
      assert.equal(checked.ok ? null : checked.message, householdNameError(raw));
    }
  });
});

describe('household ID', () => {
  test('slugifies the name', () => {
    assert.equal(slugifyHouseholdName('  The Smiths\' Place! '), 'the-smiths-place');
    assert.equal(slugifyHouseholdName('Café 21'), 'caf-21');
    assert.equal(slugifyHouseholdName('!!!'), 'household');
  });

  test('adds a four-character suffix from the picker', () => {
    assert.equal(householdIdFor('Maple', () => 0), 'maple-aaaa');
    let call = 0;
    const id = householdIdFor('Maple', n => (call++ === 0 ? n - 1 : 1));
    assert.equal(id, 'maple-9bbb');
    assert.match(householdIdFor('Maple', n => Math.floor(Math.random() * n)), /^maple-[a-z0-9]{4}$/);
  });
});

describe('time zone', () => {
  test('keeps valid IANA zones of at most 64 characters', () => {
    assert.equal(normalizeTimeZone('America/Chicago'), 'America/Chicago');
    assert.equal(normalizeTimeZone('UTC'), 'UTC');
  });

  test('drops anything else', () => {
    for (const value of [undefined, null, '', 42, 'Not/AZone', 'x'.repeat(65)]) {
      assert.equal(normalizeTimeZone(value), undefined);
    }
  });
});

describe('pending-member reminder timing', () => {
  const now = new Date('2026-08-01T12:00:00.000Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000).toISOString();

  test('due when never reminded, unreadable, or at least 24 hours ago', () => {
    assert.equal(PENDING_REMINDER_INTERVAL_HOURS, 24);
    for (const value of [undefined, null, '', 'not a date', {}]) assert.equal(pendingReminderDue(value, now), true);
    assert.equal(pendingReminderDue(hoursAgo(24), now), true);
    assert.equal(pendingReminderDue(hoursAgo(30), now), true);
  });

  test('not due within 24 hours', () => {
    assert.equal(pendingReminderDue(hoursAgo(23.9), now), false);
    assert.equal(pendingReminderDue(hoursAgo(0), now), false);
  });

  test('the state key is per UTC day', () => {
    assert.equal(pendingReminderStateKey(now), 'pending|2026-08-01');
    assert.equal(pendingReminderStateKey(new Date('2026-08-01T23:59:59.000Z')), 'pending|2026-08-01');
    assert.equal(pendingReminderStateKey(new Date('2026-08-02T00:00:00.000Z')), 'pending|2026-08-02');
  });
});

describe('who may send the reminder', () => {
  const member = (role: HouseholdRole, permissions = {}, status: 'active' | 'pending' = 'active') => ({ uid: `u-${role}`, role, status, permissions });

  test('owners and admins by default; members only when granted household.manageMembers', () => {
    assert.equal(canRemindPendingMembers(member('owner')).ok, true);
    assert.equal(canRemindPendingMembers(member('admin')).ok, true);
    assert.deepEqual(canRemindPendingMembers(member('member')), { ok: false, reason: 'missing_permission' });
    assert.equal(canRemindPendingMembers(member('member', { 'household.manageMembers': true })).ok, true);
    assert.deepEqual(canRemindPendingMembers(member('admin', { 'household.manageMembers': false })), { ok: false, reason: 'missing_permission' });
  });

  test('pending people and missing records are refused', () => {
    assert.deepEqual(canRemindPendingMembers(member('newuser', {}, 'pending')), { ok: false, reason: 'not_member' });
    assert.deepEqual(canRemindPendingMembers(null), { ok: false, reason: 'not_member' });
  });
});
