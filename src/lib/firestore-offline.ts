import {
  getDoc,
  getDocFromCache,
  getDocs,
  getDocsFromCache,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Query,
  type QuerySnapshot,
} from 'firebase/firestore';

/** True only when the browser reports no network. Unknown (server, old browsers) counts as online. */
export const isBrowserOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/**
 * Reads a query from the server when online. When the browser is offline it reads
 * the persistent cache immediately instead of waiting for Firestore to give up on
 * the network, falling back to the normal read if the cache read fails.
 */
export async function getDocsOfflineAware<T = DocumentData>(query: Query<T>): Promise<QuerySnapshot<T>> {
  if (isBrowserOffline()) {
    try {
      return await getDocsFromCache(query);
    } catch {
      // Fall through to the regular read, which also serves cached data offline.
    }
  }
  return getDocs(query);
}

/** Single-document variant of {@link getDocsOfflineAware}. */
export async function getDocOfflineAware<T = DocumentData>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
  if (isBrowserOffline()) {
    try {
      return await getDocFromCache(ref);
    } catch {
      // Not cached: fall through.
    }
  }
  return getDoc(ref);
}

/**
 * Firestore write promises resolve only once the server acknowledges them, so an
 * offline write would leave a spinner up forever. Offline, this returns
 * `'queued'` right away (the write stays in the persistent queue and syncs on
 * reconnect) and reports a later rejection, such as a permission denial, through
 * `onLateError`. Online it awaits the write and returns `'saved'`, rethrowing failures.
 */
export async function awaitWriteUnlessOffline(
  write: Promise<unknown>,
  onLateError?: (error: unknown) => void,
): Promise<'saved' | 'queued'> {
  if (isBrowserOffline()) {
    write.catch((error: unknown) => onLateError?.(error));
    return 'queued';
  }
  await write;
  return 'saved';
}
