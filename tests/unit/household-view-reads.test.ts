import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { householdManagerReads } from '../../src/components/household/household-model';
import { getMemberPermissions } from '../../src/lib/permissions';
import type { HouseholdMember } from '../../src/lib/types';

type MemberRecord = Pick<HouseholdMember, 'role' | 'status' | 'permissions'>;
const readsFor = (member: MemberRecord | null) => householdManagerReads(getMemberPermissions(member));
const none = { page: false, invites: false, audit: false, contacts: false, choreStats: false };

describe('householdManagerReads (HO-2a)', () => {
  it('gives owners and admins every Household Manager read', () => {
    const all = { page: true, invites: true, audit: true, contacts: true, choreStats: true };
    assert.deepEqual(readsFor({ role: 'owner', status: 'active', permissions: {} }), all);
    assert.deepEqual(readsFor({ role: 'admin', status: 'active', permissions: {} }), all);
    // Owners hold everything, whatever an override says.
    assert.deepEqual(readsFor({ role: 'owner', status: 'active', permissions: { 'household.view': false } }), all);
  });

  it('gives members, children and guests the page but no manager-only data', () => {
    for (const role of ['member', 'child', 'guest'] as const) {
      const reads = readsFor({ role, status: 'active', permissions: {} });
      assert.equal(reads.page, true, role);
      assert.equal(reads.invites, false, role);
      assert.equal(reads.audit, false, role);
      assert.equal(reads.contacts, false, role);
      assert.equal(reads.choreStats, true, role);
    }
  });

  it('opens nothing without household.view, whatever else is held', () => {
    assert.deepEqual(readsFor({ role: 'admin', status: 'active', permissions: { 'household.view': false } }), none);
    assert.deepEqual(readsFor({
      role: 'member',
      status: 'active',
      permissions: { 'household.view': false, 'household.manageInvites': true, 'household.manageMembers': true },
    }), none);
  });

  it('follows overrides that grant the manager permissions', () => {
    const reads = readsFor({
      role: 'child',
      status: 'active',
      permissions: { 'household.manageInvites': true, 'household.manageMembers': true },
    });
    assert.deepEqual(reads, { page: true, invites: true, audit: true, contacts: true, choreStats: true });
    assert.deepEqual(readsFor({ role: 'guest', status: 'active', permissions: { 'household.manageInvites': true } }),
      { page: true, invites: true, audit: false, contacts: false, choreStats: true });
  });

  it('gives pending people, inactive records and no record nothing', () => {
    assert.deepEqual(readsFor({ role: 'newuser', status: 'pending', permissions: { 'household.view': true } }), none);
    assert.deepEqual(readsFor({ role: 'admin', status: 'deleting', permissions: {} }), none);
    assert.deepEqual(readsFor(null), none);
    assert.deepEqual(householdManagerReads(null), none);
  });
});
