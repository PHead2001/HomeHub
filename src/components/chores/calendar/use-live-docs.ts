'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collection, onSnapshot, query, type QuerySnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { resilientListener, type ResilientHandle } from '@/lib/dashboard/resilient-listener';
import type { LiveDoc } from '@/lib/chores/live';

/** One collection to listen to: `key` names it in the result, `path` is its Firestore path. */
export type LiveSpec = { key: string; path: readonly string[] };

export type LiveDocsState = {
  /** Each key's documents, or null until its first answer. */
  docs: ReadonlyMap<string, LiveDoc[] | null>;
  /** Keys whose listener is failing (retrying with backoff, or refused). */
  failed: ReadonlySet<string>;
};

/**
 * Live documents of a changing set of collections (audit CA-1): one `onSnapshot` listener
 * per spec, each a `resilientListener` (bounded backoff, retried at once on `online` and when
 * the page is visible again), as the Chores page (`useChoreLiveData`) and Maintenance do.
 * When the specs change (a pet added, a permission granted) only the listeners that
 * changed start or stop; the others keep their data. Nothing is ever re-read after a write:
 * changes from this page, other devices and the server arrive here.
 */
export function useLiveDocs(specs: readonly LiveSpec[]): LiveDocsState & { retry: () => void } {
  const [docs, setDocs] = useState<Map<string, LiveDoc[] | null>>(() => new Map());
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const handles = useRef(new Map<string, { path: string; handle: ResilientHandle }>());
  // **Try again** starts every listener over, also one that settled on `unauthorized`.
  const [restart, setRestart] = useState(0);
  const signature = specs.map(spec => `${spec.key}=${spec.path.join('/')}`).join('|');

  useEffect(() => {
    const wanted = new Map(specs.map(spec => [spec.key, spec]));
    const active = handles.current;
    // Stop what is no longer wanted (or moved to another path) and forget its data.
    for (const [key, entry] of [...active]) {
      const spec = wanted.get(key);
      if (spec && spec.path.join('/') === entry.path) continue;
      entry.handle.stop();
      active.delete(key);
      setDocs(previous => { const next = new Map(previous); next.delete(key); return next; });
      setFailed(previous => { if (!previous.has(key)) return previous; const next = new Set(previous); next.delete(key); return next; });
    }
    for (const spec of specs) {
      if (active.has(spec.key)) continue;
      const [first, ...rest] = spec.path;
      const source = query(collection(db, first, ...rest));
      let answered = false;
      let fromServer = false;
      // A restarted listener keeps what it showed until its new answer arrives.
      setDocs(previous => (previous.has(spec.key) ? previous : new Map(previous).set(spec.key, null)));
      const handle = resilientListener<QuerySnapshot>(
        (next, error) => onSnapshot(source, { includeMetadataChanges: true }, next, error),
        {
          next: (snapshot) => {
            const confirmed = !snapshot.metadata.fromCache;
            if (answered && snapshot.docChanges().length === 0 && (fromServer || !confirmed)) return;
            answered = true;
            fromServer ||= confirmed;
            const list = snapshot.docs.map(item => ({ id: item.id, data: item.data() }));
            setDocs(previous => (handles.current.get(spec.key)?.handle === handle ? new Map(previous).set(spec.key, list) : previous));
            setFailed(previous => { if (!previous.has(spec.key)) return previous; const next = new Set(previous); next.delete(spec.key); return next; });
          },
          confirmed: (snapshot) => !snapshot.metadata.fromCache,
          status: (status) => {
            if (status.kind === 'live') return;
            if (status.kind === 'retrying') console.warn(`Calendar ${spec.key} listener failed; retrying in ${status.delayMs} ms.`);
            setFailed(previous => (previous.has(spec.key) ? previous : new Set(previous).add(spec.key)));
          },
        },
      );
      active.set(spec.key, { path: spec.path.join('/'), handle });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the specs' signature
  }, [signature, restart]);

  useEffect(() => () => {
    handles.current.forEach(entry => entry.handle.stop());
    handles.current.clear();
  }, []);

  const retry = useCallback(() => {
    handles.current.forEach(entry => entry.handle.stop());
    handles.current.clear();
    setRestart(n => n + 1);
  }, []);
  return useMemo(() => ({ docs, failed, retry }), [docs, failed, retry]);
}

/** Ready once every key answered; an error when one that has not answered is failing. */
export function liveGroupStatus(state: LiveDocsState, keys: readonly string[]): 'loading' | 'ready' | 'error' {
  const missing = keys.filter(key => (state.docs.get(key) ?? null) === null);
  if (missing.length === 0) return 'ready';
  return missing.some(key => state.failed.has(key)) ? 'error' : 'loading';
}
