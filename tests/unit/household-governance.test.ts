import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  HOUSEHOLD_NAME_MAX,
  OWNER_ONLY_PERMISSIONS,
  canSeeMemberOverrides,
  changedPermissions,
  choreStatsByMember,
  mergeChoresById,
  customizedPermissions,
  describeAuditAction,
  formatInviteInput,
  householdPageGate,
  inviteLiveKey,
  isActiveInvite,
  showSoloMembersState,
  transferOwnershipDescription,
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

const statsPeople = [{ uid: 'uid-sam', email: 'sam@example.test' }, { uid: 'uid-ana', email: 'ana@example.test' }];

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
    // No display name: a neutral word, never the email or its local part.
    assert.equal(memberFirstName(member('jamie.p', 'newuser')), 'Member');
  });

  it('counts chores done this week and still open per assignee', () => {
    const weekStart = new Date('2026-07-27T00:00:00Z');
    const stats = choreStatsByMember([
      { assignedToEmail: 'Sam@example.test', isCompleted: true, completedAt: '2026-07-28T10:00:00Z' },
      { assignedToEmail: 'sam@example.test', isCompleted: true, completedAt: '2026-07-20T10:00:00Z' },
      { assignedToEmail: 'sam@example.test', isCompleted: false },
      // Newer chores carry the uid (and the email while it is known).
      { assignedToUid: 'uid-sam', assignedToEmail: '', isCompleted: false },
      { assignedToEmail: '', isCompleted: false },
      { assignedToUid: 'uid-gone', isCompleted: false },
    ], statsPeople, weekStart);
    assert.deepEqual(stats.get('uid-sam'), { doneThisWeek: 1, open: 2 });
    assert.equal(stats.size, 1);
  });

  it('counts a chore an older build reassigned by email to the new assignee', () => {
    const weekStart = new Date('2026-07-27T00:00:00Z');
    // An older build rewrites only the email and leaves the previous uid behind.
    const stats = choreStatsByMember([
      { assignedToUid: 'uid-ana', assignedToEmail: 'sam@example.test', isCompleted: false },
    ], statsPeople, weekStart);
    assert.deepEqual([...stats.keys()], ['uid-sam']);
    // Once emails are no longer readable, the uid decides.
    assert.deepEqual([...choreStatsByMember([{ assignedToUid: 'uid-ana', assignedToEmail: '', isCompleted: false }], [{ uid: 'uid-ana' }], weekStart).keys()], ['uid-ana']);
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
    assert.deepEqual(choreStatsByMember(merged, statsPeople, weekStart).get('uid-sam'), { doneThisWeek: 2, open: 1 });
    // A server stamp from last week wins over a client string from this week.
    const backdated = { id: 'b', assignedToEmail: 'sam@example.test', isCompleted: true, completedAt: '2026-07-28T10:00:00Z', completedAtServer: { seconds: Date.parse('2026-07-20T10:00:00Z') / 1000 } };
    assert.equal(choreStatsByMember([backdated], statsPeople, weekStart).get('uid-sam'), undefined);
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
    const stats = choreStatsByMember(
      [{ assignedToEmail: 'a@example.test', isCompleted: true, completedAt: new Date(2026, 7, 1, 12).toISOString() }],
      [{ uid: 'uid-a', email: 'a@example.test' }],
      startOfWeek(new Date(2026, 7, 3, 0, 1)),
    );
    assert.equal(stats.get('uid-a'), undefined);
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

  it('says what changed when the server recorded it (HO-8)', () => {
    // Role changes: from and to; approvals and denials keep their own sentences.
    assert.equal(describeAuditAction({ action: 'member.role_changed', details: { role: 'admin', previousRole: 'member' } }), 'Changed a role from Member to Admin');
    assert.equal(describeAuditAction({ action: 'member.approved', details: { role: 'child', previousRole: 'newuser' } }), 'Approved a member as Child');
    assert.equal(describeAuditAction({ action: 'member.removed', details: { pending: true } }), 'Denied a request to join');
    assert.equal(describeAuditAction({ action: 'member.removed' }), 'Removed a member');
    // Renames: old and new names.
    assert.equal(describeAuditAction({ action: 'household.renamed', details: { householdName: 'The Foxes', previousName: 'Foxes' } }), 'Renamed the household from "Foxes" to "The Foxes"');
    assert.equal(describeAuditAction({ action: 'household.renamed', details: { householdName: 'The Foxes', previousName: '' } }), 'Renamed the household to "The Foxes"');
    assert.equal(describeAuditAction({ action: 'household.renamed' }), 'Renamed the household');
    // Permission edits: what was given and taken away, in plain labels.
    assert.equal(
      describeAuditAction({ action: 'member.permissions_changed', details: { granted: 'household.manageInvites, shopping.delete', revoked: 'chores.view' } }),
      'Customized permissions: allowed Manage invites, Delete shopping; took away View chores',
    );
    assert.equal(describeAuditAction({ action: 'member.permissions_changed', details: { granted: '', revoked: 'pets.view' } }), 'Customized permissions: took away View pets');
    assert.equal(describeAuditAction({ action: 'member.permissions_changed', details: { granted: '', revoked: '' } }), 'Customized permissions');
  });
});

describe('Household page gate (HO-8)', () => {
  const owner = { role: 'owner' as const, status: 'active' as const };
  const ownerPermissions = getEffectivePermissions('owner', {});
  const base = { signedIn: true, householdLoading: false, hasHousehold: true, member: owner, permissions: ownerPermissions };

  it('shows a skeleton, not "No household yet", while the household loads', () => {
    assert.equal(householdPageGate({ ...base, hasHousehold: false, householdLoading: true, member: null }), 'loading');
    assert.equal(householdPageGate({ ...base, hasHousehold: false, householdLoading: false, member: null }), 'no-household');
    assert.equal(householdPageGate({ ...base, signedIn: false, hasHousehold: false, householdLoading: true }), 'sign-in');
  });

  it('decides access from resolved permissions and status, not the role name', () => {
    assert.equal(householdPageGate(base), 'page');
    // An admin whose View household was turned off.
    const admin = { role: 'admin' as const, status: 'active' as const };
    assert.equal(householdPageGate({ ...base, member: admin, permissions: getEffectivePermissions('admin', { 'household.view': false }) }), 'not-available');
    // A pending person, and a record that is not active (permissions resolve to nothing).
    assert.equal(householdPageGate({ ...base, member: { role: 'newuser', status: 'pending' }, permissions: getRolePresetPermissions('newuser') }), 'waiting');
    assert.equal(householdPageGate({ ...base, member: { role: 'admin', status: 'deleting' }, permissions: getRolePresetPermissions('newuser') }), 'not-available');
  });
});

describe('Members after a failed load (HO-8)', () => {
  it('never says "It\'s just you so far" under a failed load', () => {
    assert.equal(showSoloMembersState(1, 0, false), true);
    assert.equal(showSoloMembersState(1, 0, true), false);
    assert.equal(showSoloMembersState(2, 0, false), false);
    assert.equal(showSoloMembersState(1, 1, false), false);
  });
});

describe('Make owner warning (HO-8)', () => {
  it('warns when ownership would go to a Child or Guest', () => {
    for (const role of ['child', 'guest'] as const) {
      const text = transferOwnershipDescription({ displayName: 'Casey', role });
      assert.match(text, new RegExp(`^Casey is a ${role === 'child' ? 'Child' : 'Guest'}, a role with limited access\\. They get full control`));
    }
    for (const role of ['admin', 'member'] as const) {
      assert.equal(transferOwnershipDescription({ displayName: 'Sam', role }), 'They get full control, including deleting the household. You become an admin.');
    }
  });
});

describe('invite clock (HO-8)', () => {
  it('keeps the clock moving only while a code can still expire', () => {
    const invite = (code: string, extra: Record<string, unknown> = {}) => ({ code, maxUses: 1, useCount: 0, expiresAt: '', ...extra });
    const now = new Date('2026-08-01T12:00:00.000Z');
    const live = { expiresAt: '2026-08-01T12:30:00.000Z' };
    assert.equal(inviteLiveKey([], now), '');
    assert.equal(inviteLiveKey([
      invite('B', live), invite('A', live),
      invite('R', { ...live, revokedAt: 'x' }), invite('U', { ...live, useCount: 1 }),
      invite('E', { expiresAt: '2026-08-01T11:59:00.000Z' }),
    ], now), 'A|B');
    // Once the last code has expired the key is empty and the clock stops.
    assert.equal(inviteLiveKey([invite('A', live)], new Date('2026-08-01T12:30:00.000Z')), '');
  });

  it('measures expiry against the time it is given, so a ticking clock flips the state', () => {
    const code = { revokedAt: undefined, maxUses: 1, useCount: 0, expiresAt: '2026-08-01T12:30:00.000Z' };
    assert.equal(isActiveInvite(code, new Date('2026-08-01T12:29:59.000Z')), true);
    assert.equal(isActiveInvite(code, new Date('2026-08-01T12:30:00.000Z')), false);
    assert.equal(relativeTime(code.expiresAt, new Date('2026-08-01T12:00:00.000Z')), 'in 30 min');
    assert.equal(relativeTime(code.expiresAt, new Date('2026-08-01T12:20:00.000Z')), 'in 10 min');
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

describe('create household form', () => {
  // A browser submits a form when Enter is pressed in its only text field, as long as
  // the field sits inside the <form>, the form has a submit button and nothing on the
  // field swallows the key. No browser runs here, so this checks exactly that wiring.
  const source = readFileSync(resolve(process.cwd(), 'src/components/household-manager.tsx'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('function CreateHouseholdForm');
  const form = source.slice(start, source.indexOf('function JoinHouseholdForm', start));

  it('keeps the name field inside the form with a submit button, so Enter submits', () => {
    assert.ok(start >= 0, 'CreateHouseholdForm exists');
    const open = form.indexOf('<form');
    const field = form.indexOf("fieldErrorProps('householdName'");
    const submit = form.indexOf('<Button type="submit"');
    const close = form.indexOf('</form>');
    assert.ok(open >= 0 && open < field && field < submit && submit < close, 'field and submit button sit inside the form');
    assert.equal(form.match(/<Input\b/g)?.length, 1, 'one text field, so implicit submission applies');
    assert.doesNotMatch(form, /onKeyDown|onKeyPress|onKeyUp/, 'nothing intercepts Enter');
    assert.match(form, /enterKeyHint="go"/);
  });

  it('handles the submit itself: no page reload, validates, then creates with the trimmed name', () => {
    assert.match(form, /onSubmit=\{\(event\) => \{\s*event\.preventDefault\(\);\s*setSubmitted\(true\);\s*if \(!householdNameError\(name\) && !isCreating\) onCreate\(name\.trim\(\)\);/);
  });
});

describe('who sees custom permissions (HO-12)', () => {
  it('the person themself and holders of Manage roles; never other kids, guests or members', () => {
    const manager = { uid: 'a', permissions: { 'household.manageRoles': true } };
    assert.equal(canSeeMemberOverrides(manager, 'b'), true);
    assert.equal(canSeeMemberOverrides({ uid: 'b', permissions: {} }, 'b'), true);
    assert.equal(canSeeMemberOverrides({ uid: 'c', permissions: { 'household.view': true } }, 'b'), false);
    assert.equal(canSeeMemberOverrides({ uid: 'c', permissions: { 'household.manageRoles': false } }, 'b'), false);
    assert.equal(canSeeMemberOverrides(null, 'b'), false);
  });
});
