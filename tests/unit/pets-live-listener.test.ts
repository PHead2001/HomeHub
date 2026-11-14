import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { ListenerStatus } from '../../src/lib/dashboard/resilient-listener';
import { liveAnswer, liveFailure, liveNotice, petListenerKey, petSnapshotListener, settledPetAccess, staleNoticeText, unavailableText, type PetAccess } from '../../src/lib/pets/live-listener';

type Snapshot = { metadata: { fromCache: boolean }; value: number };
const cached = (value = 1): Snapshot => ({ metadata: { fromCache: true }, value });
const fromServer = (value = 1): Snapshot => ({ metadata: { fromCache: false }, value });

function fakeSource() {
  const calls: Array<{ next: (value: Snapshot) => void; error: (error: unknown) => void }> = [];
  const subscribe = (next: (value: Snapshot) => void, error: (error: unknown) => void) => {
    calls.push({ next, error });
    return () => undefined;
  };
  return { calls, subscribe, last: () => calls[calls.length - 1] };
}

const environment = () => ({ window: new EventTarget(), document: Object.assign(new EventTarget(), { visibilityState: 'visible' }), random: () => 0.5 });
const denied = Object.assign(new Error('denied'), { code: 'permission-denied' });
const unavailable = new Error('unavailable');

describe('Pets live listeners: only a server answer counts as recovered (PE-8g)', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  it('a member who lost access settles on unauthorized even when every retry first serves the cache', () => {
    const source = fakeSource();
    const statuses: ListenerStatus['kind'][] = [];
    const handle = petSnapshotListener<Snapshot>(source.subscribe, { next: () => undefined, status: (status) => statuses.push(status.kind) }, environment());
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const call = source.last();
      call.next(cached()); // Firestore answers from the persistent cache before the server refuses
      call.error(denied);
      if (statuses.at(-1) === 'unauthorized') break;
      mock.timers.tick(60_000);
    }
    assert.equal(statuses.at(-1), 'unauthorized');
    assert.equal(source.calls.length, 3, 'two permission retries, then it stops');
    mock.timers.tick(10 * 60_000);
    assert.equal(source.calls.length, 3, 'no further resubscribing');
    handle.stop();
  });

  it('cached answers do not reset the backoff; a server answer does', () => {
    const source = fakeSource();
    const delays: number[] = [];
    const handle = petSnapshotListener<Snapshot>(source.subscribe, {
      next: () => undefined,
      status: (status) => { if (status.kind === 'retrying') delays.push(status.delayMs); },
    }, environment());
    source.last().next(cached());
    source.last().error(unavailable);
    mock.timers.tick(delays.at(-1)!);
    source.last().next(cached());
    source.last().error(unavailable);
    assert.deepEqual(delays, [1000, 2000], 'the cached answer did not reset the schedule');
    mock.timers.tick(delays.at(-1)!);
    source.last().next(fromServer());
    source.last().error(unavailable);
    assert.equal(delays.at(-1), 1000, 'a confirmed server answer resets it');
    handle.stop();
  });

  it('every Pets listener uses it, with metadata changes so a cached answer turning live is seen', () => {
    const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
    for (const file of ['src/components/pets/pet-log-api.ts', 'src/components/pets-client.tsx', 'src/app/pets/[petId]/page.tsx']) {
      const source = read(file);
      assert.match(source, /petSnapshotListener</, file);
      assert.doesNotMatch(source, /resilientListener</, file);
      assert.match(source, /includeMetadataChanges: true/, file);
    }
  });
});

describe('a listener that fails after loading keeps the content and says why (PE-8g, PE-18c)', () => {
  it('records retrying and unauthorized on content already shown, and clears it on the next answer', () => {
    const loaded = liveAnswer('h/rex', { name: 'Rex' });
    const retrying = liveFailure(loaded, 'h/rex', 'retrying');
    assert.deepEqual(retrying, { key: 'h/rex', value: { name: 'Rex' }, loaded: true, failed: 'retrying' });
    const refused = liveFailure(retrying, 'h/rex', 'unauthorized');
    assert.equal(refused.failed, 'unauthorized');
    assert.deepEqual(refused.value, { name: 'Rex' });
    assert.equal(liveNotice(refused), 'access-changed');
    assert.equal(liveNotice(retrying), 'reconnecting');
    assert.equal(liveNotice(loaded), null);
    assert.deepEqual(liveAnswer('h/rex', { name: 'Rex 2' }).failed, false);
  });

  it('with nothing loaded (or another key) the failure is the whole state, with no stale content', () => {
    const before = liveAnswer('h/rex', { name: 'Rex' });
    assert.deepEqual(liveFailure(before, 'h/maple', 'retrying'), { key: 'h/maple', value: null, loaded: false, failed: 'retrying' });
    assert.equal(liveNotice(liveFailure(before, 'h/maple', 'unauthorized')), null, 'no notice: the page shows its own failure state');
  });

  it('the notice and the history copy are honest: access changed has no retry, reconnecting says so', () => {
    assert.match(staleNoticeText('access-changed', 'this pet'), /access to pets changed/);
    assert.match(staleNoticeText('reconnecting', 'this pet'), /Reconnecting/);
    assert.match(unavailableText('Feeding history', 'unauthorized'), /access to pets changed/);
    assert.match(unavailableText('Feeding history', 'retrying'), /unavailable right now/);
  });

  it('the pet page, the list and the tabs use them', () => {
    const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
    const page = read('src/app/pets/[petId]/page.tsx');
    assert.match(page, /liveFailure\(/);
    assert.match(page, /staleNoticeText\(/);
    assert.doesNotMatch(page, /previous\.pet \? previous :/, 'a failure after loading is never dropped');
    assert.match(read('src/components/pets-client.tsx'), /staleNoticeText\(/);
    for (const file of ['src/components/feeding-log.tsx', 'src/components/medication-log.tsx', 'src/components/care-log.tsx']) {
      assert.match(read(file), /unavailableText\(/, file);
    }
    assert.match(read('src/components/pets/pet-log-api.ts'), /failures\[index\] = status\.kind/);
  });
});

describe('Pets listeners restart when access changes (finding: unauthorized never recovers)', () => {
  it('the listener key follows the member and their pets.view, so granting access resubscribes', () => {
    const denied = petListenerKey('h1/pets', { uid: 'sam', canView: false });
    const granted = petListenerKey('h1/pets', { uid: 'sam', canView: true });
    assert.ok(denied && granted);
    assert.notEqual(denied, granted, 'pets.view granted: a new listener');
    assert.notEqual(petListenerKey('h1/pets', { uid: 'alex', canView: true }), granted, 'another member: a new listener');
    assert.equal(petListenerKey('h1/pets', { uid: 'sam', canView: true }), granted, 'nothing changed: the same listener');
    assert.equal(petListenerKey(null, { uid: 'sam', canView: true }), null);
  });

  it('the pet list, the pet page and the log histories key their listeners on it', () => {
    const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
    for (const file of ['src/components/pets-client.tsx', 'src/app/pets/[petId]/page.tsx', 'src/components/pets/pet-log-api.ts']) {
      assert.match(read(file), /petListenerKey\(/, file);
    }
  });
});

describe('Pets listeners wait for a settled access key (no second subscription, no loading flash)', () => {
  type Frame = { uid: string | null; canView: boolean; settled: boolean };
  /** Renders a sequence of auth states as the hook does: the key each render subscribes with. */
  function keysOver(frames: Frame[]): (string | null)[] {
    let kept: PetAccess | null = null;
    return frames.map((frame) => {
      kept = settledPetAccess(kept, { uid: frame.uid, canView: frame.canView }, frame.settled);
      return kept ? petListenerKey('h1/pets', kept) : null;
    });
  }
  const subscriptions = (keys: (string | null)[]) => keys.filter((key, index) => key !== null && key !== keys[index - 1]).length;

  it('nothing subscribes until membership has settled; permissions arriving with it give one subscription', () => {
    const keys = keysOver([
      { uid: 'sam', canView: false, settled: false }, // signed in, membership still loading
      { uid: 'sam', canView: false, settled: false },
      { uid: 'sam', canView: true, settled: true }, // membership and permissions arrive
      { uid: 'sam', canView: true, settled: true },
    ]);
    assert.deepEqual(keys.slice(0, 2), [null, null]);
    assert.equal(subscriptions(keys), 1);
  });

  it('a membership snapshot loading again (a transient empty member) keeps the key: no re-subscribe, no skeleton', () => {
    const keys = keysOver([
      { uid: 'sam', canView: true, settled: true },
      { uid: 'sam', canView: false, settled: false },
      { uid: 'sam', canView: true, settled: true },
    ]);
    assert.equal(new Set(keys).size, 1);
    assert.equal(subscriptions(keys), 1);
  });

  it('a real change once settled still recreates the listener (access revoked, granted again, another member)', () => {
    const keys = keysOver([
      { uid: 'sam', canView: true, settled: true },
      { uid: 'sam', canView: false, settled: true },
      { uid: 'sam', canView: true, settled: true },
      { uid: 'alex', canView: true, settled: true },
    ]);
    assert.equal(subscriptions(keys), 4);
    assert.match(keys[1]!, /no-view$/);
  });

  it('the kept access is the same object while nothing changes (the hook settles in one extra render)', () => {
    const first = settledPetAccess(null, { uid: 'sam', canView: true }, true)!;
    assert.equal(settledPetAccess(first, { uid: 'sam', canView: true }, true), first);
    assert.equal(settledPetAccess(first, { uid: null, canView: false }, false), first);
    assert.equal(settledPetAccess(null, { uid: 'sam', canView: true }, false), null);
  });

  it('every Pets listener keyed on access uses the settled access and reads as loading until then', () => {
    const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
    for (const file of ['src/components/pets-client.tsx', 'src/app/pets/[petId]/page.tsx', 'src/components/pets/pet-log-api.ts', 'src/components/pets/medication-api.ts']) {
      const text = read(file);
      assert.match(text, /useSettledPetAccess\(\)/, file);
      assert.doesNotMatch(text, /canView: Boolean\(permissions/, `${file} keys on raw permissions`);
    }
    assert.match(read('src/components/pets/pet-log-api.ts'), /if \(householdId && !access\) return \{ logs: \[\], loading: true/);
    assert.match(read('src/app/pets/[petId]/page.tsx'), /\(Boolean\(householdId\) && !access\)/);
  });
});
