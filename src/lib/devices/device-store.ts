// Durable tablet storage (docs/modules/devices/README.md, "Offline queue and Undo
// journal"; design 10.3, 11.2). One IndexedDB database, `homehub-device`, with two
// stores keyed by `opId`: `queue` (face actions waiting to sync) and `undo` (the Undo
// journal). Deleted as a whole when the tablet observes its removal (section 13).
// `memoryStore` has the same interface for tests and for browsers without IndexedDB
// (nothing then survives a reload, and the UI never claims it did).

export const DEVICE_DB_NAME = 'homehub-device';
export const DEVICE_DB_VERSION = 1;
export type DeviceStoreName = 'queue' | 'undo';

export type RecordStore<T extends { opId: string }> = {
  /** True when writes survive a reload (IndexedDB), false for the in-memory fallback. */
  readonly durable: boolean;
  all(): Promise<T[]>;
  get(opId: string): Promise<T | undefined>;
  put(value: T): Promise<void>;
  delete(opId: string): Promise<void>;
  clear(): Promise<void>;
};

export function memoryStore<T extends { opId: string }>(): RecordStore<T> {
  const rows = new Map<string, T>();
  const copy = (value: T): T => structuredClone(value);
  return {
    durable: false,
    all: async () => [...rows.values()].map(copy),
    get: async (opId) => (rows.has(opId) ? copy(rows.get(opId)!) : undefined),
    put: async (value) => { rows.set(value.opId, copy(value)); },
    delete: async (opId) => { rows.delete(opId); },
    clear: async () => { rows.clear(); },
  };
}

const request = <R,>(req: IDBRequest<R>): Promise<R> => new Promise<R>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
});

let opening: Promise<IDBDatabase> | null = null;

const openDb = (): Promise<IDBDatabase> => {
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DEVICE_DB_NAME, DEVICE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ['queue', 'undo'] as const) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'opId' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab deleting the database (revocation) closes this connection.
      db.onversionchange = () => { db.close(); opening = null; };
      resolve(db);
    };
    req.onerror = () => { opening = null; reject(req.error ?? new Error('IndexedDB open failed')); };
    req.onblocked = () => undefined;
  });
  return opening;
};

/** The IndexedDB-backed store, or the in-memory one where IndexedDB is missing. */
export function deviceStore<T extends { opId: string }>(name: DeviceStoreName): RecordStore<T> {
  if (typeof indexedDB === 'undefined') return memoryStore<T>();
  const run = async <R,>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<R>): Promise<R> => {
    const db = await openDb();
    const tx = db.transaction(name, mode);
    // Attached before the request settles, so the completion is never missed.
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
    const [result] = await Promise.all([request(work(tx.objectStore(name))), done]);
    return result;
  };
  return {
    durable: true,
    all: () => run('readonly', (store) => store.getAll() as IDBRequest<T[]>),
    get: (opId) => run('readonly', (store) => store.get(opId) as IDBRequest<T | undefined>),
    put: async (value) => { await run('readwrite', (store) => store.put(value)); },
    delete: async (opId) => { await run('readwrite', (store) => store.delete(opId)); },
    clear: async () => { await run('readwrite', (store) => store.clear()); },
  };
}

/**
 * Deletes the whole `homehub-device` database (queue and Undo journal). Best effort and
 * never waits on other tabs: when another tab still has it open the delete is blocked;
 * this resolves `false` at once and the browser finishes the delete when that tab closes
 * its connection (every connection here closes on `versionchange`).
 */
export async function deleteDeviceDatabase(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return true;
  if (opening) {
    try { (await opening).close(); } catch { /* never opened */ }
    opening = null;
  }
  return new Promise<boolean>((resolve) => {
    const req = indexedDB.deleteDatabase(DEVICE_DB_NAME);
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
    req.onblocked = () => resolve(false);
  });
}

/** The cross-tab lock every queue reader and writer holds (design 10.3, 11.2). */
export const QUEUE_LOCK = 'homehub-device-queue';

type LockManagerLike = { request: <R>(name: string, callback: () => Promise<R>) => Promise<R> };

let localChain: Promise<unknown> = Promise.resolve();

/**
 * Runs `work` holding the Web Lock `homehub-device-queue` (one sync owner across tabs).
 * Without the Web Locks API it serializes within this page only.
 */
export function withQueueLock<R>(work: () => Promise<R>, locks: LockManagerLike | null | undefined = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManagerLike }).locks : undefined): Promise<R> {
  if (locks) return locks.request(QUEUE_LOCK, work);
  const next = localChain.then(work, work);
  localChain = next.catch(() => undefined);
  return next;
}
