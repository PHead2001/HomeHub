import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  OWNER_ONLY_PERMISSIONS,
  canAssignRole,
  canDeleteHousehold,
  canEditPermissions,
  canGrantPermission,
  canManageInvites,
  canManageMember,
  canRemoveMember,
  canRenameHousehold,
  canTransferOwnership,
  effectivePermissions,
  holdsPermission,
  normalizeOverrides,
  permissionChanges,
  rank,
  refusalMessage,
  type PolicyDecision,
  type PolicyMember,
  type PolicyRefusal,
} from '../../src/lib/household-policy';
import { lockedPermissionCells } from '../../src/components/household/household-model';
import { assignableRoles, householdPermissions } from '../../src/lib/permissions';
import type { HouseholdRole, PermissionOverrides } from '../../src/lib/types';

const ROLES: readonly HouseholdRole[] = ['owner', 'admin', 'member', 'child', 'guest', 'newuser'];

const person = (role: HouseholdRole, permissions: PermissionOverrides = {}, uid = `${role}-1`): PolicyMember => ({
  uid,
  role,
  status: role === 'newuser' ? 'pending' : 'active',
  permissions,
});

const reasonOf = (decision: PolicyDecision): PolicyRefusal | 'ok' => (decision.ok ? 'ok' : decision.reason);

describe('rank', () => {
  it('orders owner > admin > member > child = guest > pending', () => {
    assert.ok(rank('owner') > rank('admin'));
    assert.ok(rank('admin') > rank('member'));
    assert.ok(rank('member') > rank('child'));
    assert.equal(rank('child'), rank('guest'));
    assert.ok(rank('guest') > rank('newuser'));
  });

  it('gives unknown, legacy and missing roles the lowest rank', () => {
    assert.equal(rank(undefined), 0);
    assert.equal(rank(null), 0);
    assert.equal(rank('super-admin' as HouseholdRole), 0);
    assert.equal(rank('newuser'), 0);
  });
});

describe('effective permissions', () => {
  it('gives the owner everything whatever the overrides say', () => {
    const owner = person('owner', { 'household.delete': false, 'chores.view': false });
    for (const permission of householdPermissions) assert.equal(holdsPermission(owner, permission), true, permission);
  });

  it('never gives the owner-only permissions to anyone else, even with a stored override', () => {
    for (const role of ROLES.filter((r) => r !== 'owner')) {
      const member = { ...person(role, { 'household.delete': true, 'household.transferOwnership': true }), status: 'active' as const };
      for (const permission of OWNER_ONLY_PERMISSIONS) assert.equal(holdsPermission(member, permission), false, `${role} ${permission}`);
    }
  });

  it('merges the role preset with overrides', () => {
    assert.equal(holdsPermission(person('member'), 'household.manageInvites'), false);
    assert.equal(holdsPermission(person('member', { 'household.manageInvites': true }), 'household.manageInvites'), true);
    assert.equal(holdsPermission(person('admin', { 'household.manageInvites': false }), 'household.manageInvites'), false);
  });

  it('gives pending, inactive and missing people nothing', () => {
    const none = (member: PolicyMember | null) => householdPermissions.every((p) => !effectivePermissions(member)[p]);
    assert.ok(none(person('newuser', { 'household.manageMembers': true })));
    assert.ok(none({ uid: 'x', role: 'admin', status: 'pending' }));
    assert.ok(none({ uid: 'x', role: 'owner', status: 'deleting' }));
    assert.ok(none(null));
  });

  it('treats a missing status as active, like the rules', () => {
    assert.equal(holdsPermission({ uid: 'x', role: 'admin' }, 'household.manageMembers'), true);
  });
});

describe('invites and rename work as ticked', () => {
  const cases: Array<[string, PolicyMember | null, PolicyRefusal | 'ok', PolicyRefusal | 'ok']> = [
    // label, actor, canManageInvites, canRenameHousehold
    ['owner', person('owner'), 'ok', 'ok'],
    ['admin', person('admin'), 'ok', 'ok'],
    ['admin with manageInvites unticked', person('admin', { 'household.manageInvites': false }), 'missing_permission', 'ok'],
    ['admin with manageMembers unticked', person('admin', { 'household.manageMembers': false }), 'ok', 'missing_permission'],
    ['member', person('member'), 'missing_permission', 'missing_permission'],
    ['member with manageInvites ticked', person('member', { 'household.manageInvites': true }), 'ok', 'missing_permission'],
    ['guest with manageMembers ticked', person('guest', { 'household.manageMembers': true }), 'missing_permission', 'ok'],
    ['child', person('child'), 'missing_permission', 'missing_permission'],
    ['pending with overrides', person('newuser', { 'household.manageInvites': true, 'household.manageMembers': true }), 'not_member', 'not_member'],
    ['inactive admin', { uid: 'x', role: 'admin', status: 'deleting' }, 'not_member', 'not_member'],
    ['nobody', null, 'not_member', 'not_member'],
  ];
  for (const [label, actor, invites, rename] of cases) {
    it(label, () => {
      assert.equal(reasonOf(canManageInvites(actor)), invites);
      assert.equal(reasonOf(canRenameHousehold(actor)), rename);
    });
  }
});

describe('manageMembers: every role pair', () => {
  const grant: PermissionOverrides = { 'household.manageMembers': true };

  for (const actorRole of ROLES) {
    for (const targetRole of ROLES) {
      it(`${actorRole} (granted manageMembers) acting on ${targetRole}`, () => {
        const actor = person(actorRole, grant, 'actor');
        const target = person(targetRole, {}, 'target');
        const expected: PolicyRefusal | 'ok' = actorRole === 'newuser'
          ? 'not_member'
          : rank(actorRole) > rank(targetRole) ? 'ok' : 'rank';
        assert.equal(reasonOf(canManageMember(actor, target)), expected);
        assert.equal(reasonOf(canRemoveMember(actor, target)), expected);

        for (const newRole of ROLES) {
          const assign: PolicyRefusal | 'ok' = expected !== 'ok'
            ? expected
            : !assignableRoles.includes(newRole)
              ? 'role_not_assignable'
              : rank(newRole) < rank(actorRole) ? 'ok' : 'role_too_high';
          assert.equal(reasonOf(canAssignRole(actor, target, newRole)), assign, `assign ${newRole}`);
        }
      });
    }
  }

  it('needs the permission: the default member, child and guest cannot manage anyone', () => {
    for (const role of ['member', 'child', 'guest'] as const) {
      assert.equal(reasonOf(canManageMember(person(role, {}, 'actor'), person('newuser', {}, 'target'))), 'missing_permission');
      assert.equal(reasonOf(canAssignRole(person(role, {}, 'actor'), person('newuser', {}, 'target'), 'guest')), 'missing_permission');
    }
  });

  it('an admin with manageMembers unticked cannot manage anyone', () => {
    const admin = person('admin', { 'household.manageMembers': false }, 'actor');
    assert.equal(reasonOf(canManageMember(admin, person('guest', {}, 'target'))), 'missing_permission');
  });

  it('nobody manages themselves', () => {
    for (const role of ROLES.filter((r) => r !== 'newuser')) {
      const self = person(role, grant, 'same');
      assert.equal(reasonOf(canManageMember(self, self)), 'self', role);
      assert.equal(reasonOf(canAssignRole(self, self, 'guest')), 'self', role);
    }
  });

  it('the owner is never a target, and equal ranks never manage each other', () => {
    assert.equal(reasonOf(canManageMember(person('admin', {}, 'a'), person('owner', {}, 'o'))), 'rank');
    assert.equal(reasonOf(canManageMember(person('admin', {}, 'a'), person('admin', {}, 'b'))), 'rank');
    assert.equal(reasonOf(canManageMember(person('child', grant, 'a'), person('guest', {}, 'b'))), 'rank');
    assert.equal(reasonOf(canManageMember(person('guest', grant, 'a'), person('child', {}, 'b'))), 'rank');
    assert.equal(reasonOf(canManageMember(person('member', grant, 'a'), person('member', {}, 'b'))), 'rank');
  });

  it('a missing target is refused', () => {
    assert.equal(reasonOf(canManageMember(person('owner'), null)), 'not_member');
    assert.equal(reasonOf(canAssignRole(person('owner'), undefined, 'member')), 'not_member');
  });

  it('nobody assigns a role at or above their own, owner or pending', () => {
    const pending = person('newuser', {}, 'target');
    // An admin cannot make another admin; a granted member cannot approve as member or admin.
    assert.equal(reasonOf(canAssignRole(person('admin', {}, 'a'), pending, 'admin')), 'role_too_high');
    assert.equal(reasonOf(canAssignRole(person('admin', {}, 'a'), pending, 'member')), 'ok');
    assert.equal(reasonOf(canAssignRole(person('member', grant, 'a'), pending, 'member')), 'role_too_high');
    assert.equal(reasonOf(canAssignRole(person('member', grant, 'a'), pending, 'admin')), 'role_too_high');
    assert.equal(reasonOf(canAssignRole(person('member', grant, 'a'), pending, 'child')), 'ok');
    assert.equal(reasonOf(canAssignRole(person('guest', grant, 'a'), pending, 'guest')), 'role_too_high');
    assert.equal(reasonOf(canAssignRole(person('owner', {}, 'a'), pending, 'admin')), 'ok');
    assert.equal(reasonOf(canAssignRole(person('owner', {}, 'a'), pending, 'owner')), 'role_not_assignable');
    assert.equal(reasonOf(canAssignRole(person('owner', {}, 'a'), person('member', {}, 't'), 'newuser')), 'role_not_assignable');
  });
});

describe('manageRoles: editing permission overrides', () => {
  const grant: PermissionOverrides = { 'household.manageRoles': true };

  for (const actorRole of ROLES) {
    for (const targetRole of ROLES) {
      it(`${actorRole} (granted manageRoles) editing ${targetRole}`, () => {
        const actor = person(actorRole, grant, 'actor');
        const target = person(targetRole, {}, 'target');
        const expected: PolicyRefusal | 'ok' = actorRole === 'newuser'
          ? 'not_member'
          : rank(actorRole) <= rank(targetRole)
            ? 'rank'
            : targetRole === 'newuser' ? 'target_pending' : 'ok';
        assert.equal(reasonOf(canEditPermissions(actor, target)), expected);
        // Revoking is allowed under exactly the same guard.
        assert.equal(reasonOf(canEditPermissions(actor, target, { 'chores.view': false })), expected);
      });
    }
  }

  it('needs the permission', () => {
    assert.equal(reasonOf(canEditPermissions(person('member', {}, 'a'), person('guest', {}, 't'))), 'missing_permission');
    assert.equal(reasonOf(canEditPermissions(person('admin', { 'household.manageRoles': false }, 'a'), person('guest', {}, 't'))), 'missing_permission');
  });

  it('guard 1: nobody changes their own permissions, not even the owner', () => {
    for (const role of ROLES.filter((r) => r !== 'newuser')) {
      const self = person(role, grant, 'same');
      assert.equal(reasonOf(canEditPermissions(self, self)), 'self', role);
      assert.equal(reasonOf(canEditPermissions(self, self, { 'household.manageMembers': true })), 'self', role);
      assert.equal(reasonOf(canEditPermissions(self, self, { 'chores.view': false })), 'self', role);
    }
  });

  it('guard 2: nobody grants a permission they do not hold', () => {
    const admin = person('admin', { 'shopping.delete': false }, 'a');
    const target = person('member', {}, 't');
    assert.equal(reasonOf(canEditPermissions(admin, target, { 'shopping.delete': true })), 'grant_unheld');
    assert.equal(reasonOf(canEditPermissions(admin, target, { 'chores.delete': true })), 'ok');
    // One unheld grant refuses the whole edit.
    assert.equal(reasonOf(canEditPermissions(admin, target, { 'chores.delete': true, 'shopping.delete': true })), 'grant_unheld');

    // A member granted manageRoles can pass on only what they hold.
    const member = person('member', grant, 'a');
    const guest = person('guest', {}, 't');
    assert.equal(reasonOf(canEditPermissions(member, guest, { 'shopping.edit': true })), 'ok');
    assert.equal(reasonOf(canEditPermissions(member, guest, { 'household.manageRoles': true })), 'ok');
    assert.equal(reasonOf(canEditPermissions(member, guest, { 'household.manageMembers': true })), 'grant_unheld');
    assert.equal(reasonOf(canEditPermissions(member, guest, { 'shopping.delete': true })), 'grant_unheld');
  });

  it('revoking a permission the actor does not hold is allowed', () => {
    const admin = person('admin', { 'shopping.delete': false }, 'a');
    const target = person('member', { 'shopping.delete': true }, 't');
    assert.equal(reasonOf(canEditPermissions(admin, target, { 'shopping.delete': false })), 'ok');
  });

  it('guard 3: nobody edits someone at or above their own rank', () => {
    assert.equal(reasonOf(canEditPermissions(person('admin', {}, 'a'), person('admin', {}, 'b'), { 'chores.view': false })), 'rank');
    assert.equal(reasonOf(canEditPermissions(person('admin', {}, 'a'), person('owner', {}, 'o'), { 'chores.view': false })), 'rank');
    assert.equal(reasonOf(canEditPermissions(person('member', grant, 'a'), person('member', {}, 'b'))), 'rank');
    assert.equal(reasonOf(canEditPermissions(person('member', grant, 'a'), person('admin', {}, 'b'))), 'rank');
    assert.equal(reasonOf(canEditPermissions(person('child', grant, 'a'), person('guest', {}, 'b'))), 'rank');
  });

  it('owner-only permissions can never be granted, even by the owner', () => {
    const target = person('admin', {}, 't');
    for (const permission of OWNER_ONLY_PERMISSIONS) {
      assert.equal(reasonOf(canEditPermissions(person('owner'), target, { [permission]: true })), 'owner_only', permission);
      assert.equal(reasonOf(canGrantPermission(person('owner'), permission)), 'owner_only', permission);
    }
  });

  it('self-escalation through a helper is refused at every step', () => {
    // A member holding only manageRoles cannot give a guest accomplice manageMembers,
    // cannot raise anyone to their own rank, and cannot touch an equal.
    const schemer = person('member', grant, 'schemer');
    const accomplice = person('guest', {}, 'accomplice');
    assert.equal(reasonOf(canEditPermissions(schemer, accomplice, { 'household.manageMembers': true })), 'grant_unheld');
    assert.equal(reasonOf(canAssignRole(schemer, accomplice, 'admin')), 'missing_permission');
    assert.equal(reasonOf(canEditPermissions(accomplice, schemer, { 'household.manageMembers': true })), 'missing_permission');
    // Even with manageRoles the lower-ranked accomplice cannot edit the schemer.
    const armed = person('guest', grant, 'accomplice');
    assert.equal(reasonOf(canEditPermissions(armed, schemer, { 'household.manageRoles': true })), 'rank');
  });

  it('canGrantPermission follows what the actor holds', () => {
    assert.equal(reasonOf(canGrantPermission(person('admin'), 'chores.delete')), 'ok');
    assert.equal(reasonOf(canGrantPermission(person('admin', { 'chores.delete': false }), 'chores.delete')), 'grant_unheld');
    assert.equal(reasonOf(canGrantPermission(null, 'chores.view')), 'grant_unheld');
  });
});

describe('permission changes and stored overrides', () => {
  it('permissionChanges lists only effective differences', () => {
    assert.deepEqual(permissionChanges('member', {}, {}), {});
    assert.deepEqual(permissionChanges('member', {}, { 'shopping.delete': true, 'chores.view': true }), { 'shopping.delete': true });
    assert.deepEqual(permissionChanges('member', { 'shopping.delete': true }, {}), { 'shopping.delete': false });
    assert.deepEqual(permissionChanges('member', { 'chores.view': false }, { 'chores.edit': false }), { 'chores.view': true, 'chores.edit': false });
  });

  it('a stored owner-only override is not a difference (it never counted)', () => {
    assert.deepEqual(permissionChanges('admin', { 'household.delete': true }, {}), {});
    assert.deepEqual(permissionChanges('admin', {}, { 'household.delete': true }), {});
  });

  it('normalizeOverrides keeps only real differences and drops owner-only grants', () => {
    assert.deepEqual(
      normalizeOverrides('admin', { 'household.delete': true, 'household.transferOwnership': true, 'chores.view': true, 'shopping.delete': false }),
      { 'shopping.delete': false },
    );
    assert.deepEqual(normalizeOverrides('member', undefined), {});
  });

  it('the editor locks owner-only cells and permissions the viewer cannot grant', () => {
    const admin = person('admin', { 'shopping.delete': false });
    const locked = lockedPermissionCells(admin, 'member', {});
    assert.ok(locked['household.delete']);
    assert.ok(locked['household.transferOwnership']);
    assert.ok(locked['shopping.delete'], 'cannot tick what the viewer lacks');
    assert.equal(locked['chores.delete'], undefined);
    // A permission the member already has stays editable so it can be taken away.
    assert.equal(lockedPermissionCells(admin, 'member', { 'shopping.delete': true })['shopping.delete'], undefined);
    // The owner holds everything: only the two owner-only cells are locked.
    assert.deepEqual(Object.keys(lockedPermissionCells(person('owner'), 'guest', {})).sort(), [...OWNER_ONLY_PERMISSIONS].sort());
  });
});

describe('owner-only operations', () => {
  it('only an active owner deletes the household, whatever overrides say', () => {
    assert.equal(reasonOf(canDeleteHousehold(person('owner'))), 'ok');
    for (const role of ROLES.filter((r) => r !== 'owner')) {
      const granted = { ...person(role, { 'household.delete': true }), status: 'active' as const };
      assert.equal(reasonOf(canDeleteHousehold(granted)), 'owner_only', role);
    }
    assert.equal(reasonOf(canDeleteHousehold({ uid: 'o', role: 'owner', status: 'deleting' })), 'owner_only');
    assert.equal(reasonOf(canDeleteHousehold(null)), 'not_member');
  });

  it('only the owner transfers ownership, to another approved member', () => {
    const owner = person('owner', {}, 'o');
    for (const role of ['admin', 'member', 'child', 'guest'] as const) {
      assert.equal(reasonOf(canTransferOwnership(owner, person(role, {}, 't'))), 'ok', role);
      const granted = person(role, { 'household.transferOwnership': true }, 'a');
      assert.equal(reasonOf(canTransferOwnership(granted, person('member', {}, 't'))), 'owner_only', role);
      assert.equal(reasonOf(canTransferOwnership(granted, owner)), 'owner_only', role);
    }
    assert.equal(reasonOf(canTransferOwnership(owner, owner)), 'self');
    assert.equal(reasonOf(canTransferOwnership(owner, person('newuser', {}, 't'))), 'target_pending');
    assert.equal(reasonOf(canTransferOwnership(owner, { uid: 't', role: 'member', status: 'pending' })), 'target_pending');
    assert.equal(reasonOf(canTransferOwnership(owner, null)), 'not_member');
    assert.equal(reasonOf(canTransferOwnership(null, owner)), 'not_member');
  });
});

describe('refusal messages', () => {
  it('every refusal has a plain-language sentence with no internal names', () => {
    const reasons: PolicyRefusal[] = ['not_member', 'missing_permission', 'self', 'rank', 'role_not_assignable', 'role_too_high', 'owner_only', 'grant_unheld', 'target_pending'];
    for (const reason of reasons) {
      const message = refusalMessage(reason);
      assert.ok(message.length > 10, reason);
      assert.doesNotMatch(message, /newuser|household\.[a-z]|_/, reason);
    }
  });
});
