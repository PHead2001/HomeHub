import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rosterFrom } from '../../src/lib/devices/roster';
import { neededListItems } from '../../src/lib/devices/tablet-shopping';
import { computeShoppingFacts } from '../../src/lib/dashboard/facts';
import {
  CLEAR_ORDER,
  TimeoutError,
  clearTabletSession,
  parseDeviceNotice,
  redactEmails,
  withTimeout,
  type ClearDeps,
  type ClearStep,
} from '../../src/lib/devices/device-session';
import {
  TABLET_MARKER_KEY,
  forgetTabletMarker,
  hasTabletMarker,
  markTabletBrowser,
  formerTabletReloadUrl,
  recoverFormerTablet,
  resetFormerTabletForTests,
  shouldStripSetupFragment,
} from '../../src/lib/devices/former-tablet';
import { codeFromSetupFragment } from '../../src/lib/devices/device-codes';
import { readFileSync } from 'node:fs';

// PR #178 review round 1 (docs/modules/devices/README.md): the shopping list view shows a
// list's full items, a member without `status` is on the roster, a tablet removed while
// switched off is cleared at the next start, clearing and exits are time-boxed, and
// household notices never show an email.

const memoryStorage = () => {
  const rows = new Map<string, string>();
  return {
    rows,
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => { rows.set(key, value); },
    removeItem: (key: string) => { rows.delete(key); },
  };
};

describe('shopping list view: the selected list\'s full items (Codex A)', () => {
  const items = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`, name: `${prefix} item ${i}`, status: i % 5 === 4 ? 'purchased' : 'needed', createdAt: `2026-08-01T10:${String(i).padStart(2, '0')}:00.000Z`,
  }));

  it('every needed item of one list, oldest first, past the dashboard preview cap', () => {
    const second = items('b', 12);
    const needed = neededListItems(second);
    assert.equal(needed.length, 10, 'twelve items, two purchased: ten needed');
    assert.deepEqual(needed.slice(0, 3).map((i) => i.id), ['b0', 'b1', 'b2']);
    // The dashboard preview is capped across lists, so a later list may show nothing there.
    const facts = computeShoppingFacts([{ id: 'a', name: 'A list' }, { id: 'b', name: 'B list' }], { a: items('a', 8), b: second });
    assert.equal(facts.firstItems.filter((i) => i.listId === 'b').length, 0, 'the preview holds none of list B');
    assert.equal(facts.lists.find((l) => l.id === 'b')?.needed, 10);
  });

  it('defaults for names and quantities', () => {
    assert.deepEqual(neededListItems([{ id: 'x', name: '  ', quantity: -2 }]), [{ id: 'x', name: 'Item', quantity: 1 }]);
  });
});

describe('roster: a member record without status is active (Codex B)', () => {
  it('includes a record with no status; still excludes explicit pending, deleting and removed', () => {
    const roster = rosterFrom([
      { id: 'legacy', data: { role: 'member', displayName: 'Lee' } },
      { id: 'p', data: { role: 'member', status: 'pending', displayName: 'Pat' } },
      { id: 'd', data: { role: 'member', status: 'deleting', displayName: 'Dee' } },
      { id: 'r', data: { role: 'member', status: 'removed', displayName: 'Rae' } },
    ]);
    assert.deepEqual(roster.map((p) => p.uid), ['legacy']);
  });
});

describe('a tablet removed while switched off is cleared at the next start (review 1)', () => {
  const deps = () => {
    const ran: string[] = [];
    return {
      ran,
      deps: {
        signedIn: () => false,
        deleteDeviceDatabase: () => { ran.push('db'); },
        forgetHousehold: () => { ran.push('household'); },
        clearFirestore: () => { ran.push('firestore'); },
        clearPush: () => { ran.push('push'); },
        navigate: () => { ran.push('navigate'); },
      },
    };
  };

  it('does nothing without the marker', async () => {
    resetFormerTabletForTests();
    const storage = memoryStorage();
    const { ran, deps: d } = deps();
    assert.equal(await recoverFormerTablet(d, storage), 'not-needed');
    assert.deepEqual(ran, []);
  });

  it('with the marker: clears everything, removes the marker, then reloads setup; once', async () => {
    resetFormerTabletForTests();
    const storage = memoryStorage();
    markTabletBrowser(storage);
    assert.equal(storage.rows.get(TABLET_MARKER_KEY), '1');
    assert.equal(hasTabletMarker(storage), true);
    const { ran, deps: d } = deps();
    assert.equal(await recoverFormerTablet(d, storage), 'ran');
    assert.deepEqual(ran, ['db', 'household', 'firestore', 'push', 'navigate']);
    assert.equal(hasTabletMarker(storage), false);
    assert.equal(await recoverFormerTablet(d, storage), 'not-needed', 'the marker is gone: no second run');
  });

  it('a failing or hanging step never stops the rest', async () => {
    resetFormerTabletForTests();
    const storage = memoryStorage();
    markTabletBrowser(storage);
    const { ran, deps: d } = deps();
    const result = await recoverFormerTablet({
      ...d,
      deleteDeviceDatabase: () => new Promise(() => undefined),
      clearFirestore: () => { throw new Error('two tabs'); },
    }, storage, 20);
    assert.equal(result, 'ran');
    assert.deepEqual(ran, ['household', 'push', 'navigate']);
    assert.equal(hasTabletMarker(storage), false);
  });

  it('blocked storage is harmless', () => {
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    assert.doesNotThrow(() => markTabletBrowser(throwing));
    assert.equal(hasTabletMarker(throwing), false);
    assert.doesNotThrow(() => forgetTabletMarker(throwing));
  });

  it('the shell\'s own clearing removes the marker before signing out', () => {
    assert.ok(CLEAR_ORDER.indexOf('forget-tablet-marker') > CLEAR_ORDER.indexOf('clear-push'));
    assert.ok(CLEAR_ORDER.indexOf('forget-tablet-marker') < CLEAR_ORDER.indexOf('sign-out'));
  });
});

describe('time limits on clearing and on exits (review 3, 4)', () => {
  it('withTimeout answers with the work, or a TimeoutError', async () => {
    assert.equal(await withTimeout(Promise.resolve(7), 50), 7);
    await assert.rejects(withTimeout(new Promise(() => undefined), 10, 'tablet exit'), (error: unknown) => error instanceof TimeoutError && /tablet exit/.test(error.message));
    await assert.rejects(withTimeout(Promise.reject(new Error('refused')), 50), /refused/);
  });

  it('a hanging clearing step times out; every later step still runs and navigation is last', async () => {
    const ran: ClearStep[] = [];
    const deps = Object.fromEntries(CLEAR_ORDER.map((step) => [step, () => {
      ran.push(step);
      return step === 'delete-device-database' || step === 'clear-firestore' ? new Promise(() => undefined) : undefined;
    }])) as ClearDeps;
    const failed = await clearTabletSession(deps, { stepTimeoutMs: 15 });
    assert.deepEqual(failed, ['delete-device-database', 'clear-firestore']);
    assert.deepEqual(ran, [...CLEAR_ORDER]);
  });
});

describe('household notices never show an email on a tablet (review 6)', () => {
  it('redacts anything email-shaped in titles and messages', () => {
    assert.equal(redactEmails('sam@example.test is now the owner of Home.'), 'a member is now the owner of Home.');
    assert.equal(redactEmails('No email here'), 'No email here');
    const notice = parseDeviceNotice('n1', { title: 'From a@b.co', message: 'x.y@z.org joined', category: 'system' }, Date.now());
    assert.equal(notice?.title, 'From a member');
    assert.equal(notice?.message, 'a member joined');
  });

  it('expired notices are dropped; text is capped', () => {
    const now = Date.parse('2026-11-14T15:00:00Z');
    assert.equal(parseDeviceNotice('n', { expiresAt: '2026-11-14T14:00:00Z' }, now), null);
    assert.equal(parseDeviceNotice('n', { title: 'x'.repeat(500) }, now)?.title.length, 120);
  });
});

describe('a new setup link opened on a former tablet keeps its code (round 5)', () => {
  const ORIGIN = 'https://homehub.example';
  const CODE = 'ABCD-EFGH-JK';

  it('marker plus a setup link: the code is captured, recovery reloads with it, the fragment is stripped only afterwards', async () => {
    resetFormerTabletForTests();
    const storage = memoryStorage();
    markTabletBrowser(storage);
    const events: string[] = [];
    // 1. The page opens with the link; the code is read before anything else.
    const hash = `#code=${CODE}`;
    const captured = codeFromSetupFragment(hash);
    assert.equal(captured, CODE);
    // 2. While recovery is owed, the setup screen leaves the fragment alone.
    assert.equal(shouldStripSetupFragment(hasTabletMarker(storage)), false);
    // 3. Recovery clears, removes the marker, then reloads to a URL that still carries the code.
    let reloadedTo = '';
    await recoverFormerTablet({
      signedIn: () => false,
      deleteDeviceDatabase: () => { events.push('clear'); },
      forgetHousehold: () => undefined,
      clearFirestore: () => undefined,
      clearPush: () => undefined,
      navigate: () => { events.push('reload'); reloadedTo = formerTabletReloadUrl(ORIGIN, captured); },
    }, storage);
    assert.deepEqual(events, ['clear', 'reload']);
    assert.equal(reloadedTo, `${ORIGIN}/setup#code=${encodeURIComponent(CODE)}`);
    assert.equal(codeFromSetupFragment(new URL(reloadedTo).hash), CODE, 'the reloaded page prefills the same code');
    // 4. After the reload the marker is gone: the fragment is stripped now.
    assert.equal(shouldStripSetupFragment(hasTabletMarker(storage)), true);
  });

  it('without a setup link the reload goes to the plain setup screen', () => {
    assert.equal(formerTabletReloadUrl(ORIGIN, null), `${ORIGIN}/setup`);
    assert.equal(codeFromSetupFragment(''), null);
  });

  it('guards: both entry points capture the code before the asynchronous recovery, and the setup screen defers stripping', () => {
    const setup = readFileSync('src/components/devices/setup-screen.tsx', 'utf8');
    assert.match(setup, /initialCode = useRef<string \| null>\(typeof window === 'undefined' \? null : codeFromSetupFragment\(window\.location\.hash\)\)/);
    assert.match(setup, /recoverFormerTabletHere\(initialCode\.current\)/);
    assert.match(setup, /shouldStripSetupFragment\(hasTabletMarker\(\)\)/);
    const auth = readFileSync('src/contexts/auth-context.tsx', 'utf8');
    assert.match(auth, /const setupCode = codeFromSetupFragment\(window\.location\.hash\);\s*void import\('@\/lib\/devices\/former-tablet'\)\.then\(\(mod\) => mod\.recoverFormerTabletHere\(setupCode\)\)/);
  });
});
