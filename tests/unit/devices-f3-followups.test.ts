import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  TABLET_CLEANUP_KEY,
  TABLET_MARKER_KEY,
  hasTabletMarker,
  markTabletBrowser,
  recoverFormerTablet,
  resetFormerTabletForTests,
  type FormerTabletDeps,
} from '../../src/lib/devices/former-tablet';

// F3 follow-ups (docs/modules/devices/README.md, "Revocation on the tablet"): recovery of a
// former tablet only runs while nobody is signed in, stops before clearing anything more if
// someone signs in, keeps the cleanup it still owes across a refresh or a closed page and
// resumes it, always reloads once Firestore was shut down, and never reloads in a loop.

type TestStorage = {
  rows: Map<string, string>;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

const storageOf = (options: { removeThrows?: boolean; removeIgnored?: boolean; keep?: string } = {}): TestStorage => {
  const rows = new Map<string, string>();
  return {
    rows,
    getItem: (key) => rows.get(key) ?? null,
    setItem: (key, value) => { rows.set(key, value); },
    removeItem: (key) => {
      if (options.removeThrows) throw new Error('storage refuses writes');
      if (options.removeIgnored || key === options.keep) return;
      rows.delete(key);
    },
  };
};

const ORDER = ['db', 'household', 'push', 'firestore'] as const;
type Step = (typeof ORDER)[number];

/**
 * Injected auth and steps. `signInAfter`: a person signs in once that step has run.
 * `closeDuring`: the page goes away during that step (a refresh or a closed tab): the step
 * never settles, so nothing after it in this run happens.
 */
const recorder = (options: { signedIn?: boolean; signInAfter?: Step; closeDuring?: Step } = {}) => {
  const ran: string[] = [];
  let signedIn = Boolean(options.signedIn);
  const step = (name: Step) => () => {
    ran.push(name);
    if (options.signInAfter === name) signedIn = true;
    if (options.closeDuring === name) return new Promise(() => undefined);
    return undefined;
  };
  const deps: FormerTabletDeps = {
    signedIn: () => signedIn,
    deleteDeviceDatabase: step('db'),
    forgetHousehold: step('household'),
    clearPush: step('push'),
    clearFirestore: step('firestore'),
    navigate: () => { ran.push('navigate'); },
  };
  return { ran, deps };
};

/**
 * A run whose page closes mid-step: abandoned. (In a test the hung step still times out
 * later; the page is gone by then, which the closed run's deps model as "signed in", so it
 * stops without touching anything the next run checks.)
 */
const abandon = async (deps: FormerTabletDeps, storage: TestStorage) => {
  let closed = false;
  void recoverFormerTablet({ ...deps, signedIn: () => closed || deps.signedIn(), navigate: () => { if (!closed) deps.navigate(); } }, storage, 50);
  await new Promise((resolve) => setTimeout(resolve, 5));
  closed = true;
};

describe('recovery never clears under a signed-in person (A)', () => {
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
    ['push', ['db', 'household', 'push']],
  ] as const) {
    it(`a person signs in after "${after}": stops before the next step (Firestore is never shut down), no reload, the debt is kept`, async () => {
      resetFormerTabletForTests();
      const storage = storageOf();
      markTabletBrowser(storage);
      const { ran, deps } = recorder({ signInAfter: after });
      assert.equal(await recoverFormerTablet(deps, storage), 'signed-in');
      assert.deepEqual(ran, expected);
      assert.equal(hasTabletMarker(storage), true);
      assert.equal(storage.rows.get(TABLET_CLEANUP_KEY), String(expected.length));
    });
  }

  it('a person signs in while Firestore is being shut down: the page still reloads (it cannot work without it); nothing else is cleared after the check', async () => {
    resetFormerTabletForTests();
    const storage = storageOf();
    markTabletBrowser(storage);
    const { ran, deps } = recorder({ signInAfter: 'firestore' });
    assert.equal(await recoverFormerTablet(deps, storage), 'ran');
    assert.deepEqual(ran, [...ORDER, 'navigate']);
    assert.equal(hasTabletMarker(storage), false);
    assert.equal(storage.rows.has(TABLET_CLEANUP_KEY), false);
  });

  it('signed out throughout: every step runs, Firestore last, then the reload; marker and progress are gone', async () => {
    resetFormerTabletForTests();
    const storage = storageOf();
    markTabletBrowser(storage);
    const { ran, deps } = recorder();
    assert.equal(await recoverFormerTablet(deps, storage), 'ran');
    assert.deepEqual(ran, [...ORDER, 'navigate']);
    assert.equal(hasTabletMarker(storage), false);
    assert.equal(storage.rows.has(TABLET_CLEANUP_KEY), false);
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

describe('the cleanup owed survives a refresh or a closed page and resumes (B)', () => {
  for (const [index, closeDuring] of ORDER.entries()) {
    it(`interrupted during "${closeDuring}": the marker stays; the next signed-out start resumes at that step and finishes`, async () => {
      resetFormerTabletForTests();
      const storage = storageOf();
      markTabletBrowser(storage);
      const first = recorder({ closeDuring });
      await abandon(first.deps, storage);
      assert.deepEqual(first.ran, ORDER.slice(0, index + 1)); // no reload in the closed page
      assert.equal(hasTabletMarker(storage), true, 'the debt is still recorded');
      assert.equal(storage.rows.get(TABLET_CLEANUP_KEY) ?? '0', String(index), 'the interrupted step is not counted as done');

      // The next page load (a fresh module guard), signed out.
      resetFormerTabletForTests();
      const next = recorder();
      assert.equal(await recoverFormerTablet(next.deps, storage), 'ran');
      assert.deepEqual(next.ran, [...ORDER.slice(index) as string[], 'navigate'], 'steps already done are not repeated');
      assert.equal(hasTabletMarker(storage), false);
      assert.equal(storage.rows.has(TABLET_CLEANUP_KEY), false);
    });
  }

  it('closed after every step but before the reload: the next start only removes the marker (a fresh page needs no reload)', async () => {
    resetFormerTabletForTests();
    const storage = storageOf();
    storage.rows.set(TABLET_MARKER_KEY, '1');
    storage.rows.set(TABLET_CLEANUP_KEY, String(ORDER.length));
    const { ran, deps } = recorder();
    assert.equal(await recoverFormerTablet(deps, storage), 'ran');
    assert.deepEqual(ran, []);
    assert.equal(hasTabletMarker(storage), false);
  });

  it('a tablet session starting again resets old progress (a later cleanup starts from the first step)', () => {
    const storage = storageOf();
    storage.rows.set(TABLET_CLEANUP_KEY, '3');
    markTabletBrowser(storage);
    assert.equal(storage.rows.has(TABLET_CLEANUP_KEY), false);
  });
});

describe('recovery never reloads in a loop (B)', () => {
  it('storage that refuses to remove keys: the probe fails, nothing is cleared, no reload, the same on every start', async () => {
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

  it('storage that silently keeps removed keys: the probe sees it and nothing runs', async () => {
    resetFormerTabletForTests();
    const storage = storageOf({ removeIgnored: true });
    storage.rows.set(TABLET_MARKER_KEY, '1');
    const { ran, deps } = recorder();
    assert.equal(await recoverFormerTablet(deps, storage), 'marker-stuck');
    assert.deepEqual(ran, []);
  });

  it('a marker that still cannot be removed after a full run: one reload, then every later start does nothing', async () => {
    resetFormerTabletForTests();
    const storage = storageOf({ keep: TABLET_MARKER_KEY });
    storage.rows.set(TABLET_MARKER_KEY, '1');
    const first = recorder();
    assert.equal(await recoverFormerTablet(first.deps, storage), 'ran');
    assert.deepEqual(first.ran, [...ORDER, 'navigate']);
    assert.equal(storage.rows.get(TABLET_CLEANUP_KEY), String(ORDER.length), 'every step stays recorded while the marker stays');
    for (let start = 0; start < 3; start += 1) {
      resetFormerTabletForTests();
      const again = recorder();
      assert.equal(await recoverFormerTablet(again.deps, storage), 'marker-stuck');
      assert.deepEqual(again.ran, [], 'no step and no reload');
    }
  });
});
