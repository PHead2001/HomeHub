import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { ASK_AN_ADMIN, disabledCheckHint, mayRemoveChore, templateRights } from '../../src/lib/chores/rights';
import { choreCapabilities } from '../../src/lib/chores/list';
import { getEffectivePermissions } from '../../src/lib/permissions';

const caps = (role: 'owner' | 'admin' | 'member' | 'child' | 'guest', overrides = {}) => choreCapabilities(getEffectivePermissions(role, overrides));
const open = (extra = {}) => ({ isCompleted: false, ...extra });

describe('creators manage their own chores (CH-24), as the rules allow', () => {
  it('lets a member change, stop and delete a library chore they created, not anyone else\'s or an older one', () => {
    const member = caps('member');
    assert.deepEqual(templateRights({ createdByUid: 'me' }, 'me', member), { own: true, edit: true, remove: true, repeat: true });
    assert.deepEqual(templateRights({ createdByUid: 'them' }, 'me', member), { own: false, edit: true, remove: false, repeat: false });
    assert.deepEqual(templateRights({}, 'me', member), { own: false, edit: true, remove: false, repeat: false });
    assert.equal(templateRights({ createdByUid: 'them' }, 'me', caps('admin')).repeat, true);
    // A kid has no chores.create: a document naming them gives them nothing.
    assert.deepEqual(templateRights({ createdByUid: 'kid' }, 'kid', caps('child')), { own: false, edit: false, remove: false, repeat: false });
  });

  it('lets a creator delete open chores of theirs, never a completed one', () => {
    const member = caps('member');
    assert.equal(mayRemoveChore(open({ createdByUid: 'me', sourceType: 'temporary' }), null, 'me', member), true);
    assert.equal(mayRemoveChore(open({ isCompleted: true, createdByUid: 'me' }), null, 'me', member), false);
    assert.equal(mayRemoveChore(open({ templateId: 't' }), { createdByUid: 'me' }, 'me', member), true, 'an open day of my repeat');
    assert.equal(mayRemoveChore(open({ templateId: 't', sourceType: 'template' }), { createdByUid: 'me' }, 'me', member), false, 'a one-time assignment someone else made');
    assert.equal(mayRemoveChore(open({ templateId: 't' }), { createdByUid: 'them' }, 'me', member), false);
    assert.equal(mayRemoveChore(open({ isCompleted: true }), null, 'me', caps('admin')), true);
    assert.equal(mayRemoveChore(open({ createdByUid: 'me' }), null, 'me', caps('member', { 'chores.create': false })), false);
  });

  it('explains a disabled check', () => {
    assert.match(disabledCheckHint({ canComplete: false, isFuture: false, dueLabel: 'Today' })!, /Ask an admin/);
    assert.equal(disabledCheckHint({ canComplete: true, isFuture: true, dueLabel: 'Tomorrow' }), 'Not due yet. It can be ticked from Tomorrow.');
    assert.equal(disabledCheckHint({ canComplete: true, isFuture: false, dueLabel: 'Today' }), null);
    assert.match(ASK_AN_ADMIN, /Ask an admin/);
  });

  it('writes the creator on every chore and library chore this page creates, and mirrors it in the rules', () => {
    const page = readFileSync(resolve(process.cwd(), 'src/components/chore-chart-client.tsx'), 'utf8');
    assert.equal((page.match(/createdByUid: currentUser\.uid/g) ?? []).length, 4);
    const rules = readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8');
    assert.match(rules, /function choreCreatorMayDelete\(householdId\)/);
    assert.match(rules, /hasHouseholdPermission\(householdId, 'chores.delete'\) \|\|\s+choreCreatorMayDelete\(householdId\);/);
  });
});
