import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { ListenerStatus } from '../../src/lib/dashboard/resilient-listener';
import { petSnapshotListener } from '../../src/lib/pets/live-listener';

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
