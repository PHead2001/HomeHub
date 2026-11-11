/**
 * Which local cache this tab's Firestore instance actually runs on (SH-4a). No
 * Firebase imports: `src/lib/firebase.ts` passes what it observed, so the decision
 * is unit tested with plain values (tests/unit/firestore-persistence.test.ts).
 *
 * `durable` needs positive proof that THIS instance started IndexedDB persistence.
 * Asking for the persistent cache is not proof (the SDK falls back to a memory
 * cache when IndexedDB cannot be opened, for example a database written by a newer
 * client, a private mode or blocked storage), and an IndexedDB database existing in
 * the browser profile is not proof either: it can be left over from an earlier
 * session or held by another tab while this one runs on memory.
 */

export type LocalPersistence = 'durable' | 'memory' | 'unknown';

/** What the cache inspection found on the running instance. */
export type ActiveCache = 'indexeddb' | 'memory' | 'unknown';

export type PersistenceObservation = {
  /** The build or runtime chose the memory cache (server code, emulator runs, opt-out flag). */
  memoryConfigured: boolean;
  /**
   * `initializeFirestore` with `persistentLocalCache` returned this instance. `false`
   * when it threw and an existing instance with an unknown cache is reused.
   */
  persistentRequested: boolean;
  /** The cache the running instance uses, once the client has started. */
  activeCache: ActiveCache;
};

/** Pure: the persistence state for an observation. */
export function decideLocalPersistence({
  memoryConfigured,
  persistentRequested,
  activeCache,
}: PersistenceObservation): LocalPersistence {
  if (memoryConfigured) return 'memory';
  if (activeCache === 'memory') return 'memory';
  if (!persistentRequested) return 'unknown';
  return activeCache === 'indexeddb' ? 'durable' : 'unknown';
}

type MaybeRecord = Record<string, unknown> | null | undefined;
const asRecord = (value: unknown): MaybeRecord =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

/**
 * Reads which cache a Firestore instance's started client uses. The SDK has no
 * public API for this; the inspected fields (`_firestoreClient._offlineComponents
 * .persistence`, an IndexedDB persistence's `persistenceKey` and
 * `allowTabSynchronization`, `started`) are internal, so any other shape, a client
 * not started yet, or a terminated or stopped one gives `unknown`, never
 * `indexeddb`. Pure (reads only).
 */
export function inspectActiveCache(firestore: unknown): ActiveCache {
  const client = asRecord(asRecord(firestore)?._firestoreClient);
  const persistence = asRecord(asRecord(client?._offlineComponents)?.persistence);
  if (!persistence) return 'unknown';
  if (persistence.started !== true) return 'unknown';
  const isIndexedDb = typeof persistence.persistenceKey === 'string'
    && typeof persistence.allowTabSynchronization === 'boolean';
  if (isIndexedDb) return 'indexeddb';
  // Memory persistence has neither field but does have a reference delegate.
  return 'referenceDelegate' in persistence ? 'memory' : 'unknown';
}
