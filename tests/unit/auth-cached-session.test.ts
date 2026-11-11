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

  it('never leaves the household loading: loading follows the live membership, never a flag set ahead', () => {
    const source = readFileSync(resolve(__dirname, '../../src/contexts/auth-context.tsx'), 'utf8');
    const publish = source.slice(source.indexOf('const publishProfile = useCallback'), source.indexOf('}, []);', source.indexOf('const publishProfile = useCallback')));
    // Unchanged profile: nothing happens at all.
    assert.match(publish, /if \(sameProfile\(profileRef\.current, next\)\) return;/);
    // Both server-profile paths (session restore and the sign-in handler) go through it.
    assert.equal((source.match(/publishProfile\(userProfile\)/g) ?? []).length, 2);
    // Loading is derived from the membership view (a pointer not watched yet is loading,
    // see tests/unit/live-membership.test.ts); no flag can be left on.
    assert.match(source, /const householdLoading = profile \? view\.phase === 'loading' : loading;/);
    assert.equal((source.match(/setHouseholdLoading\(/g) ?? []).length, 0);
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

  it('never lets a provisional profile or a superseded listener clear the household', () => {
    const source = readFileSync(resolve(__dirname, '../../src/contexts/auth-context.tsx'), 'utf8');
    // The stale-pointer cleanup waits for the server-confirmed profile, once per household.
    assert.match(source, /const stalePointer = profileConfirmed && profileHouseholdId !== null && \(/);
    const clear = source.slice(source.indexOf('const clearedPointer = useRef'), source.indexOf('const shownHousehold ='));
    assert.match(clear, /if \(!stalePointer \|\| !email \|\| clearedPointer\.current === stalePointer\) return;/);
    // Each listener is stopped by the next run, and answers for another household are ignored
    // by the state machine (tests/unit/live-membership.test.ts).
    assert.ok((source.match(/return \(\) => \{ stopped = true; stop\?\.\(\); \};/g) ?? []).length >= 3);
    // The membership view shows an ended or stale membership as loading until the profile is confirmed.
    assert.match(source, /membershipView\(membership, profileHouseholdId, profileConfirmed\)/);
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
