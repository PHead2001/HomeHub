import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  TABLET_MARKER_KEY,
  hasTabletMarker,
  markTabletBrowser,
  recoverFormerTablet,
  resetFormerTabletForTests,
  type FormerTabletDeps,
} from '../../src/lib/devices/former-tablet';

// F3 follow-ups (docs/modules/devices/README.md, "Revocation on the tablet"): recovery of a
// former tablet only ever runs while nobody is signed in, stops if someone signs in
// meanwhile, and never reloads a page in a loop.

const storageOf = (options: { removeThrows?: boolean } = {}) => {
  const rows = new Map<string, string>();
  return {
    rows,
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => { rows.set(key, value); },
    removeItem: (key: string) => {
      if (options.removeThrows) throw new Error('storage refuses writes');
      rows.delete(key);
    },
  };
};

/** Injected auth: `signInAfter` makes a person sign in once that many steps have run. */
const recorder = (options: { signedIn?: boolean; signInAfter?: string } = {}) => {
  const ran: string[] = [];
  let signedIn = Boolean(options.signedIn);
  const step = (name: string) => () => {
    ran.push(name);
    if (options.signInAfter === name) signedIn = true;
  };
  const deps: FormerTabletDeps = {
    signedIn: () => signedIn,
    deleteDeviceDatabase: step('db'),
    forgetHousehold: step('household'),
    clearFirestore: step('firestore'),
    clearPush: step('push'),
    navigate: step('navigate'),
  };
  return { ran, deps };
};

describe('recovery never runs under a signed-in person (A)', () => {
  it('a person already signed in: nothing is cleared, the marker stays', async () => {
    resetFormerTabletForTests();
    const storage = storageOf();
    markTabletBrowser(storage);
    const { ran, deps } = recorder({ signedIn: true });
    assert.equal(await recoverFormerTablet(deps, storage), 'signed-in');
    assert.deepEqual(ran, []);
    assert.equal(hasTabletMarker(storage), true);
  });

  for (const [after, expected] of [
    ['db', ['db']],
    ['household', ['db', 'household']],
    ['firestore', ['db', 'household', 'firestore']],
    ['push', ['db', 'household', 'firestore', 'push']],
  ] as const) {
    it(`a person signs in after "${after}": stops before the next step and before the reload; the marker is kept for the next signed-out start`, async () => {
      resetFormerTabletForTests();
      const storage = storageOf();
      markTabletBrowser(storage);
      const { ran, deps } = recorder({ signInAfter: after });
      assert.equal(await recoverFormerTablet(deps, storage), 'signed-in');
      assert.deepEqual(ran, expected);
      assert.equal(ran.includes('navigate'), false);
      assert.equal(hasTabletMarker(storage), true);
    });
  }

  it('signed out throughout: everything runs, the reload last', async () => {
    resetFormerTabletForTests();
    const storage = storageOf();
    markTabletBrowser(storage);
    const { ran, deps } = recorder();
    assert.equal(await recoverFormerTablet(deps, storage), 'ran');
    assert.deepEqual(ran, ['db', 'household', 'firestore', 'push', 'navigate']);
    assert.equal(hasTabletMarker(storage), false);
  });

  it('guards: both entry points start recovery only while nobody is signed in', () => {
    const setup = readFileSync('src/components/devices/setup-screen.tsx', 'utf8');
    assert.match(setup, /if \(loading \|\| currentUser \|\| principal\.kind !== 'personal' \|\| recoveryTried\.current\) return;/);
    const auth = readFileSync('src/contexts/auth-context.tsx', 'utf8');
    assert.match(auth, /if \(hasTabletMarker\(\) && auth\.currentUser === null\) \{/);
    const tablet = readFileSync('src/lib/devices/former-tablet.ts', 'utf8');
    assert.match(tablet, /signedIn: \(\) => auth\.currentUser !== null/);
  });
});

describe('recovery never reloads in a loop (B)', () => {
  it('a marker that cannot be removed: nothing is cleared, no reload, and the next start behaves the same', async () => {
    for (let start = 0; start < 3; start += 1) {
      resetFormerTabletForTests();
      const storage = storageOf({ removeThrows: true });
      storage.rows.set(TABLET_MARKER_KEY, '1');
      const { ran, deps } = recorder();
      assert.equal(await recoverFormerTablet(deps, storage), 'marker-stuck');
      assert.deepEqual(ran, [], 'no clearing and no navigation');
      assert.equal(hasTabletMarker(storage), true, 'left for a later start');
    }
  });
});
