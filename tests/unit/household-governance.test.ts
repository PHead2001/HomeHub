import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HOUSEHOLD_NAME_MAX,
  OWNER_ONLY_PERMISSIONS,
  changedPermissions,
  choreStatsByEmail,
  mergeChoresById,
  customizedPermissions,
  describeAuditAction,
  formatInviteInput,
  householdNameError,
  inviteCodeError,
  inviteState,
  memberFirstName,
  normalizeOverrides,
  permissionDraftKey,
  relativeTime,
  roleLabel,
  sortMembers,
  startOfNextWeek,
  startOfWeek,
  togglePermissionOverride,
} from '../../src/components/household/household-model';
import { avatarFileError, AVATAR_MAX_BYTES } from '../../src/components/profile/profile-validation';
import { entityStateLabel, entityStateTone } from '../../src/components/automation/entity-state';
import { getEffectivePermissions, getRolePresetPermissions } from '../../src/lib/permissions';
import type { HouseholdMember } from '../../src/lib/types';

const member = (uid: string, role: HouseholdMember['role'], displayName?: string): HouseholdMember => ({
  uid,
  email: `${uid}@example.test`,
  displayName,
  role,
  status: role === 'newuser' ? 'pending' : 'active',
  joinedAt: '2026-01-01T00:00:00.000Z',
});

describe('household names and invite codes', () => {
  it('asks for a name and enforces the rules limit', () => {
    assert.equal(householdNameError('   '), 'Give your household a name.');
    assert.equal(householdNameError('The Millers'), null);
    assert.equal(householdNameError('x'.repeat(HOUSEHOLD_NAME_MAX)), null);
    assert.match(householdNameError('x'.repeat(HOUSEHOLD_NAME_MAX + 1)) ?? '', /under 80/);
  });

  it('re-inserts dashes in invite codes typed or pasted without them', () => {
    assert.equal(formatInviteInput('u4tr9kzda4'), 'U4TR-9KZD-A4');
    assert.equal(formatInviteInput('u4tr 9kzd-a4'), 'U4TR-9KZD-A4');
    assert.equal(formatInviteInput('abcd'), 'ABCD');
    assert.equal(formatInviteInput('abcde'), 'ABCD-E');
    assert.equal(formatInviteInput('ABCD-EFGH-JKLMNOP'), 'ABCD-EFGH-JK');
  });

  it('explains an incomplete invite code inline', () => {
    assert.equal(inviteCodeError(''), 'Enter the invite code you were given.');
    assert.match(inviteCodeError('ABCD-EF') ?? '', /10 letters and numbers/);
    assert.equal(inviteCodeError('ABCD-EFGH-JK'), null);
  });

  it('classifies invites', () => {
    const now = new Date('2026-08-01T12:00:00Z');
    const base = { expiresAt: '2026-08-01T12:30:00Z', maxUses: 1, useCount: 0 };
    assert.equal(inviteState(base, now), 'active');
    assert.equal(inviteState({ ...base, revokedAt: '2026-08-01T12:01:00Z' }, now), 'revoked');
    assert.equal(inviteState({ ...base, useCount: 1 }, now), 'used');
    assert.equal(inviteState({ ...base, expiresAt: '2026-08-01T11:00:00Z' }, now), 'expired');
    assert.equal(inviteState({ ...base, expiresAt: 'not a date' }, now), 'expired');
  });
});

describe('members', () => {
  it('never shows the internal newuser name', () => {
    assert.equal(roleLabel('newuser'), 'Pending');
    assert.equal(roleLabel('owner'), 'Owner');
  });

  it('sorts owner first and pending last', () => {
    const sorted = sortMembers([member('p', 'newuser'), member('g', 'guest'), member('o', 'owner'), member('a', 'admin')]);
    assert.deepEqual(sorted.map((m) => m.uid), ['o', 'a', 'g', 'p']);
  });

  it('uses the first name for short prompts', () => {
    assert.equal(memberFirstName(member('j', 'newuser', 'Jamie Pending')), 'Jamie');
    assert.equal(memberFirstName(member('jamie.p', 'newuser')), 'jamie.p');
  });

  it('counts chores done this week and still open per assignee', () => {
    const weekStart = new Date('2026-07-27T00:00:00Z');
    const stats = choreStatsByEmail([
      { assignedToEmail: 'Sam@example.test', isCompleted: true, completedAt: '2026-07-28T10:00:00Z' },
      { assignedToEmail: 'sam@example.test', isCompleted: true, completedAt: '2026-07-20T10:00:00Z' },
      { assignedToEmail: 'sam@example.test', isCompleted: false },
      { assignedToEmail: '', isCompleted: false },
    ], weekStart);
    assert.deepEqual(stats.get('sam@example.test'), { doneThisWeek: 1, open: 1 });
    assert.equal(stats.size, 1);
  });

  it('counts this week by the server stamp, and a chore found by both completion queries once', () => {
    const weekStart = new Date('2026-07-27T00:00:00Z');
    // The client string says last week (skewed clock); the server stamp says this week.
    const stamped = {
      id: 'k', assignedToEmail: 'sam@example.test', isCompleted: true,
      completedAt: '2026-07-26T23:00:00Z', completedAtServer: { toDate: () => new Date('2026-07-27T09:00:00Z') },
    };
    const legacy = { id: 'l', assignedToEmail: 'sam@example.test', isCompleted: true, completedAt: '2026-07-28T10:00:00Z' };
    const open = { id: 'o', assignedToEmail: 'sam@example.test', isCompleted: false };
    // The server-stamp query and the legacy query can both return the same document.
    const merged = mergeChoresById([open], [stamped, legacy], [legacy]);
    assert.equal(merged.length, 3);
    assert.deepEqual(choreStatsByEmail(merged, weekStart).get('sam@example.test'), { doneThisWeek: 2, open: 1 });
    // A server stamp from last week wins over a client string from this week.
    const backdated = { id: 'b', assignedToEmail: 'sam@example.test', isCompleted: true, completedAt: '2026-07-28T10:00:00Z', completedAtServer: { seconds: Date.parse('2026-07-20T10:00:00Z') / 1000 } };
    assert.equal(choreStatsByEmail([backdated], weekStart).get('sam@example.test'), undefined);
  });

  it('starts the week on Monday', () => {
    const start = startOfWeek(new Date(2026, 7, 1, 15)); // Saturday 1 Aug 2026
    assert.equal(start.getDay(), 1);
    assert.equal(start.getDate(), 27);
    assert.equal(start.getHours(), 0);
  });

  it('advances the week boundary at the next local Monday midnight', () => {
    const sunday = new Date(2026, 7, 2, 23, 59); // Sunday 2 Aug 2026
    const next = startOfNextWeek(sunday);
    assert.equal(next.getDay(), 1);
    assert.equal(next.getDate(), 3);
    assert.equal(next.getHours(), 0);
    // Just after the rollover, the current week starts there, so last week's
    // completions fall before the boundary.
    assert.equal(startOfWeek(new Date(2026, 7, 3, 0, 1)).getTime(), next.getTime());
    const stats = choreStatsByEmail(
      [{ assignedToEmail: 'a@example.test', isCompleted: true, completedAt: new Date(2026, 7, 1, 12).toISOString() }],
      startOfWeek(new Date(2026, 7, 3, 0, 1)),
    );
    assert.equal(stats.get('a@example.test'), undefined);
  });

  it('formats relative times', () => {
    const now = new Date('2026-08-01T12:00:00Z');
    assert.equal(relativeTime('2026-08-01T11:59:40Z', now), 'just now');
    assert.equal(relativeTime('2026-08-01T11:55:00Z', now), '5 min ago');
    assert.equal(relativeTime('2026-08-01T12:20:00Z', now), 'in 20 min');
    assert.equal(relativeTime('2026-07-30T12:00:00Z', now), '2 days ago');
    assert.equal(relativeTime(undefined, now), '');
  });
});

describe('permission matrix', () => {
  it('stores only differences from the role default', () => {
    let draft = togglePermissionOverride('member', {}, 'shopping.delete');
    assert.deepEqual(draft, { 'shopping.delete': true });
    draft = togglePermissionOverride('member', draft, 'shopping.delete');
    assert.deepEqual(draft, {});
    draft = togglePermissionOverride('member', draft, 'chores.view');
    assert.deepEqual(draft, { 'chores.view': false });
    assert.equal(getEffectivePermissions('member', draft)['chores.view'], false);
  });

  it('never grants owner-only permissions and never edits the owner', () => {
    for (const permission of OWNER_ONLY_PERMISSIONS) {
      assert.deepEqual(togglePermissionOverride('admin', {}, permission), {});
    }
    assert.deepEqual(togglePermissionOverride('owner', {}, 'chores.view'), {});
    assert.deepEqual(normalizeOverrides('admin', { 'household.delete': true, 'chores.view': true, 'shopping.delete': false }), {
      'shopping.delete': false,
    });
  });

  it('invalidates a permission draft when the role changes but stored overrides do not', () => {
    const before = { ...member('s', 'member'), permissions: {} };
    const after = { ...before, role: 'guest' as const };
    assert.notEqual(permissionDraftKey(before), permissionDraftKey(after));
    assert.equal(permissionDraftKey(before), permissionDraftKey({ ...before }));
    assert.notEqual(permissionDraftKey(before), permissionDraftKey({ ...before, permissions: { 'shopping.delete': true } }));
    assert.equal(permissionDraftKey(null), '');
  });

  it('reports changed and customized permissions', () => {
    assert.deepEqual(changedPermissions('guest', {}, { 'shopping.edit': true }), ['shopping.edit']);
    assert.deepEqual(changedPermissions('guest', { 'shopping.edit': true }, { 'shopping.edit': true }), []);
    assert.deepEqual(customizedPermissions('guest', { 'shopping.view': true, 'shopping.edit': true }), ['shopping.edit']);
    assert.equal(getRolePresetPermissions('guest')['shopping.view'], true);
  });
});

describe('activity wording', () => {
  it('turns audit actions into sentences', () => {
    assert.equal(describeAuditAction({ action: 'invite.generated' }), 'Created an invite code');
    assert.equal(describeAuditAction({ action: 'member.role_changed', details: { role: 'newuser' } }), 'Changed a role to Pending');
    assert.equal(describeAuditAction({ action: 'member.joined_pending' }), 'Asked to join');
    assert.equal(describeAuditAction({ action: 'something.new_thing' }), 'Something new thing');
  });
});

describe('profile photo', () => {
  it('checks type and the 5 MB storage limit inline', () => {
    assert.equal(avatarFileError({ type: 'image/png', size: 1000 }), null);
    assert.match(avatarFileError({ type: 'image/svg+xml', size: 1000 }) ?? '', /JPG, PNG, GIF or WebP/);
    assert.match(avatarFileError({ type: 'image/jpeg', size: AVATAR_MAX_BYTES + 1 }) ?? '', /over 5 MB/);
  });
});

describe('Home Assistant states', () => {
  it('labels and tones states for people', () => {
    assert.equal(entityStateLabel('not_home'), 'Not home');
    assert.equal(entityStateTone('not_home'), 'off');
    assert.equal(entityStateLabel('21.5', '°C'), '21.5 °C');
    assert.equal(entityStateTone('21.5'), 'value');
    assert.equal(entityStateTone('unavailable'), 'unavailable');
    assert.equal(entityStateLabel(''), 'No state');
    assert.equal(entityStateTone('on'), 'on');
  });
});
