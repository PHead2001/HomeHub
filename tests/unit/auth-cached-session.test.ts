import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeMember, sameProfile } from '../../src/lib/auth/cached-session';
import type { HouseholdMember, User } from '../../src/lib/types';

const member = (fields: Partial<HouseholdMember>) => fields as HouseholdMember;
const profile = (fields: Partial<User>) => fields as User;

describe('repeat-visit fast path (H01)', () => {
  it('normalizes a membership record the same way for cached and server copies', () => {
    assert.deepEqual(normalizeMember(member({ role: 'owner', email: 'a@x' }), 'uid-1'), { role: 'owner', email: 'a@x', uid: 'uid-1', status: 'active' });
    assert.equal(normalizeMember(member({ role: 'newuser' }), 'u').status, 'pending');
    assert.equal(normalizeMember(member({ role: 'member', status: 'deleting' }), 'u').status, 'deleting');
    // The stored uid never overrides the signed-in user's uid.
    assert.equal(normalizeMember(member({ role: 'member', uid: 'someone-else' }), 'me').uid, 'me');
  });

  it('treats profiles with the same data as the same, whatever the key order', () => {
    const a = profile({ uid: 'u', email: 'a@x', householdId: 'h', permissions: { 'chores.view': true, 'shopping.edit': false } });
    const b = profile({ permissions: { 'shopping.edit': false, 'chores.view': true }, householdId: 'h', email: 'a@x', uid: 'u' });
    assert.equal(sameProfile(a, b), true);
    assert.equal(sameProfile(a, a), true);
    assert.equal(sameProfile(null, null), true);
  });

  it('sees any changed field, so the server copy replaces a stale cached one', () => {
    const cached = profile({ uid: 'u', email: 'a@x', householdId: 'h', role: 'member' });
    assert.equal(sameProfile(cached, profile({ ...cached, householdId: null })), false);
    assert.equal(sameProfile(cached, profile({ ...cached, role: 'admin' })), false);
    assert.equal(sameProfile(cached, profile({ ...cached, permissions: { 'chores.view': false } })), false);
    assert.equal(sameProfile(cached, null), false);
    assert.equal(sameProfile(null, cached), false);
  });

  it('reads the cache only after Auth restores the session, then still confirms with the server', () => {
    const source = readFileSync(resolve(__dirname, '../../src/contexts/auth-context.tsx'), 'utf8');
    // The cached profile is read inside the onAuthStateChanged callback, keyed by the restored user...
    const restore = source.slice(source.indexOf('onAuthStateChanged(auth, async (firebaseUser)'));
    assert.match(restore.slice(0, 1200), /readCached\(\['users', firebaseUser\.email\]\)/);
    // ...and the server fetch still follows it.
    assert.ok(restore.indexOf('fetchOrCreateUserProfile(firebaseUser)') > restore.indexOf("readCached(['users'"));
    // The cached household phase runs before the unchanged server membership check.
    const fetchHousehold = source.slice(source.indexOf('const fetchHousehold = async'));
    assert.ok(fetchHousehold.indexOf("readCached(['households'") < fetchHousehold.indexOf('await loadMembership('));
    assert.match(fetchHousehold, /if \(!member\) await clearStaleHousehold\(\);/);
    // The cache read never touches the network.
    assert.match(source, /getDocFromCache\(/);
  });
});
