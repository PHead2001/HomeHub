import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOUSE_SNAPSHOT_KEY, clearHouseSnapshot, readHouseSnapshot, writeHouseSnapshot } from '../../src/lib/dashboard/house-snapshot';
import type { ChoreFacts } from '../../src/lib/dashboard/facts';

const memory = () => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => { items.set(k, v); },
    removeItem: (k: string) => { items.delete(k); },
  };
};

const chores: ChoreFacts = {
  mineOpen: 2, mineOverdue: 1, mineDueToday: 1, todayTotal: 3, todayDone: 1, overdueTotal: 1,
  rooms: [{ id: 'kitchen', name: 'Kitchen', overdue: 1, dueToday: 0, upcoming: 1, doneToday: 0, status: 'overdue', chores: [{ id: 'c1', task: 'Wipe counters', dueLabel: 'Yesterday', overdue: true }] }],
  nextUp: [{ id: 'c1', task: 'Wipe counters', dueLabel: 'Yesterday', overdue: true, mine: true }],
};

describe('last-known house rooms (H01)', () => {
  it('returns the saved rooms only for the same user, household and day', () => {
    const storage = memory();
    writeHouseSnapshot(storage, 'uid-a', 'house-1', '2026-11-09', JSON.stringify(chores));
    assert.deepEqual(readHouseSnapshot(storage, 'uid-a', 'house-1', '2026-11-09'), chores);
    assert.equal(readHouseSnapshot(storage, 'uid-b', 'house-1', '2026-11-09'), null, 'another user on this device');
    assert.equal(readHouseSnapshot(storage, 'uid-a', 'house-2', '2026-11-09'), null, 'another household');
    assert.equal(readHouseSnapshot(storage, 'uid-a', 'house-1', '2026-11-10'), null, 'a new day');
  });

  it('keeps one snapshot per device: a new user or household replaces it', () => {
    const storage = memory();
    writeHouseSnapshot(storage, 'uid-a', 'house-1', 'd', JSON.stringify(chores));
    writeHouseSnapshot(storage, 'uid-b', 'house-2', 'd', JSON.stringify(chores));
    assert.equal(storage.items.size, 1);
    assert.equal(readHouseSnapshot(storage, 'uid-a', 'house-1', 'd'), null);
  });

  it('is deleted by clearHouseSnapshot and ignores missing, foreign or malformed data', () => {
    const storage = memory();
    writeHouseSnapshot(storage, 'uid-a', 'house-1', 'd', JSON.stringify(chores));
    clearHouseSnapshot(storage);
    assert.equal(storage.items.has(HOUSE_SNAPSHOT_KEY), false);
    assert.equal(readHouseSnapshot(storage, 'uid-a', 'house-1', 'd'), null);
    storage.setItem(HOUSE_SNAPSHOT_KEY, '{not json');
    assert.equal(readHouseSnapshot(storage, 'uid-a', 'house-1', 'd'), null);
    storage.setItem(HOUSE_SNAPSHOT_KEY, JSON.stringify({ v: 1, uid: 'uid-a', householdId: 'house-1', day: 'd', chores: { rooms: 'nope' } }));
    assert.equal(readHouseSnapshot(storage, 'uid-a', 'house-1', 'd'), null);
    assert.equal(readHouseSnapshot(null, 'uid-a', 'house-1', 'd'), null);
    assert.equal(readHouseSnapshot(storage, '', 'house-1', 'd'), null);
  });

  it('never throws when storage is blocked', () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    assert.equal(readHouseSnapshot(blocked, 'u', 'h', 'd'), null);
    assert.doesNotThrow(() => writeHouseSnapshot(blocked, 'u', 'h', 'd', JSON.stringify(chores)));
    assert.doesNotThrow(() => writeHouseSnapshot(memory(), 'u', 'h', 'd', '{bad json'));
    assert.doesNotThrow(() => clearHouseSnapshot(blocked));
  });

  it('is shown only until live chores arrive, never after a failure, and cleared on sign-out', () => {
    const hook = readFileSync(resolve(__dirname, '../../src/lib/dashboard/use-dashboard-data.ts'), 'utf8');
    const helper = hook.slice(hook.indexOf('function useHouseSnapshot('));
    // Shown only while live chores are missing and the section hasn't failed...
    assert.match(helper, /const snapshot = !live && householdId && !choresFailed \? readHouseSnapshot\(/);
    assert.match(helper, /return snapshot \? \{ \.\.\.facts, chores: snapshot \} : facts;/);
    // ...every live change is saved...
    assert.match(helper, /if \(liveRooms && householdId && uid\) writeHouseSnapshot\(/);
    // ...and only with chores permission (no household id otherwise).
    assert.match(hook, /useHouseSnapshot\(facts, canChores \? householdId : null, uid, today\)/);
    const auth = readFileSync(resolve(__dirname, '../../src/contexts/auth-context.tsx'), 'utf8');
    const logout = auth.slice(auth.indexOf('const logout = useCallback'));
    assert.ok(logout.indexOf('clearHouseSnapshot(deviceStorage())') < logout.indexOf('signOut(auth)'), 'cleared before sign-out');
    const signedOut = auth.slice(auth.indexOf('// User is not logged in'));
    assert.ok(signedOut.indexOf('clearHouseSnapshot(deviceStorage())') < signedOut.indexOf('setCurrentUser(null)'));
  });
});
