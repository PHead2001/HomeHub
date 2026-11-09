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
    // The cached profile is read inside the onAuthStateChanged callback, keyed by the restored user,
    // marked provisional, and the server fetch still follows it and confirms it.
    const restore = source.slice(source.indexOf('onAuthStateChanged(auth, async (firebaseUser)'));
    const cachedAt = restore.indexOf("readCached(['users', firebaseUser.email])");
    assert.ok(cachedAt > 0 && cachedAt < 1200);
    assert.ok(restore.indexOf('setProfileConfirmed(false)') > cachedAt);
    const serverAt = restore.indexOf('fetchOrCreateUserProfile(firebaseUser)');
    assert.ok(serverAt > cachedAt);
    assert.ok(restore.indexOf('setProfileConfirmed(true)') > serverAt);
    // The cache read never touches the network.
    assert.match(source, /getDocFromCache\(/);
  });

  it('uses the cache only for the session restore, and survives the new-profile race', () => {
    const source = readFileSync(resolve(__dirname, '../../src/contexts/auth-context.tsx'), 'utf8');
    const restore = source.slice(source.indexOf('onAuthStateChanged(auth, async (firebaseUser)'));
    // Captured and cleared before any branch, so a sign-in after a signed-out first callback
    // never takes the cache path.
    assert.ok(restore.indexOf('restoringSession.current = false;') < restore.indexOf('if (firebaseUser)'));
    assert.match(restore, /const cached = restoring && firebaseUser\.email/);
    // A denied create re-reads the profile the other path created instead of throwing.
    const create = source.slice(source.indexOf('const createProfile = async'), source.indexOf('if (docSnap.exists())'));
    assert.match(create, /code !== 'permission-denied'\) throw error;/);
    assert.match(create, /const existing = await getDoc\(userDocRef\);/);
    assert.equal((source.match(/await setDoc\(userDocRef, dataToSave\)/g) ?? []).length, 0);
  });

  it('never lets a provisional profile or a superseded load clear the household', () => {
    const source = readFileSync(resolve(__dirname, '../../src/contexts/auth-context.tsx'), 'utf8');
    const fetchHousehold = source.slice(source.indexOf('const fetchHousehold = async'), source.indexOf('fetchHousehold();'));
    // Provisional profile: only the cached household is shown, then it returns, before any
    // server read or the stale-household cleanup.
    const provisional = fetchHousehold.indexOf('if (!profileConfirmed)');
    assert.ok(provisional > 0);
    assert.ok(fetchHousehold.indexOf('return;', provisional) < fetchHousehold.indexOf('loadMembership('));
    assert.ok(fetchHousehold.indexOf('return;', provisional) < fetchHousehold.indexOf('clearStaleHousehold()'));
    // Only a definite "not a member" (null), never a superseded load (undefined), clears it.
    assert.match(fetchHousehold, /if \(member === null\) await clearStaleHousehold\(\);/);
    // Each run is cancelled by the next, and a cancelled run neither writes nor updates state.
    assert.match(source, /return \(\) => \{ active = false; \};/);
    const clear = source.slice(source.indexOf('const clearStaleHousehold = async'), source.indexOf('const showCachedHousehold'));
    assert.match(clear, /^const clearStaleHousehold = async \(\) => \{\s+if \(!active\) return;/);
    assert.ok(clear.indexOf('if (!active) return;', clear.indexOf('loadData()')) < clear.indexOf('setDoc('));
    const load = source.slice(source.indexOf('const loadMembership = async'), source.indexOf('const clearStaleHousehold'));
    assert.equal((load.match(/if \(!active\) return undefined;/g) ?? []).length, 2);
  });

  it('builds the profile forms only from the server-confirmed profile', () => {
    const page = readFileSync(resolve(__dirname, '../../src/app/profile/page.tsx'), 'utf8');
    assert.match(page, /profileConfirmed \? \(\s*<ProfileClient \/>/);
  });

  it('syncs appearance only from the server-confirmed profile', () => {
    const source = readFileSync(resolve(__dirname, '../../src/components/appearance-provider.tsx'), 'utf8');
    const sync = source.slice(source.indexOf('const syncedProfileFor = useRef'));
    assert.ok(sync.indexOf('if (!profileConfirmed) return;') < sync.indexOf('syncedProfileFor.current = currentUser.email'));
  });
});
