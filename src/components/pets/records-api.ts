'use client';

import { useEffect, useState } from 'react';
import { collection, limit as limitTo, onSnapshot, orderBy, query, where, type Query, type QuerySnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/hooks/use-auth';
import { petListenerKey, petSnapshotListener, type LiveFailure } from '@/lib/pets/live-listener';
import { behaviourEntries, headlineNote, pinnedNotes, PINNED_NOTES_MAX, readNote, type PetNote } from '@/lib/pets/notes';
import { readWeight, type WeightEntry } from '@/lib/pets/weights';
import {
  runCreateNote,
  runCreateWeight,
  runDeleteNote,
  runDeleteWeight,
  runEditNote,
  runSetNotePinned,
  type CreateNoteInput,
  type CreateWeightInput,
  type EditNoteInput,
} from '@/lib/pets/record-transaction';

/* ------------------------------------------------------------------------- */
/* Writes, bound to the app's Firestore                                       */
/* ------------------------------------------------------------------------- */

export const createNote = (input: CreateNoteInput) => runCreateNote(db, input);
export const editNote = (input: EditNoteInput) => runEditNote(db, input);
export const setNotePinned = (input: Parameters<typeof runSetNotePinned>[1]) => runSetNotePinned(db, input);
export const deleteNote = (input: Parameters<typeof runDeleteNote>[1]) => runDeleteNote(db, input);
export const createWeight = (input: CreateWeightInput) => runCreateWeight(db, input);
export const deleteWeight = (input: Parameters<typeof runDeleteWeight>[1]) => runDeleteWeight(db, input);

/* ------------------------------------------------------------------------- */
/* Live reads                                                                 */
/* ------------------------------------------------------------------------- */

type LiveDocs<T> = {
  /** `base#limit` of the subscription that answered. */
  key: string | null;
  items: T[];
  size: number;
  loaded: boolean;
  failed: LiveFailure;
  error: unknown;
};

export type LiveList<T> = {
  items: T[];
  loading: boolean;
  error: unknown;
  failure?: LiveFailure;
  hasMore: boolean;
  loadingMore: boolean;
};

/**
 * One live, limited query with the Pets resilient listener (PE-8g): a failed
 * read resubscribes on its own and is reported (never as an empty list); a
 * larger limit of the same query keeps the items already shown while it loads
 * ("Load more", PE-21h); another pet's items never show.
 */
function useLiveDocs<T>(scope: string | null, max: number, build: (() => Query) | null, read: (id: string, data: Record<string, unknown>) => T): LiveList<T> {
  const [state, setState] = useState<LiveDocs<T>>({ key: null, items: [], size: 0, loaded: false, failed: false, error: null });
  // Keyed on the reader too (P3's pattern, `petListenerKey`): a listener refused before
  // access returned, or for another member, is recreated instead of staying refused.
  const { currentUser, permissions } = useAuth();
  const base = petListenerKey(scope, { uid: currentUser?.uid ?? null, canView: Boolean(permissions['pets.view']) });
  const key = base ? `${base}#${max}` : null;

  useEffect(() => {
    if (!key || !build) return;
    const handle = petSnapshotListener<QuerySnapshot>(
      (next, error) => onSnapshot(build(), { includeMetadataChanges: true }, next, error),
      {
        next: (snapshot) => {
          setState({
            key,
            items: snapshot.docs.map((entry) => read(entry.id, entry.data({ serverTimestamps: 'estimate' }))),
            size: snapshot.size,
            loaded: true,
            failed: false,
            error: null,
          });
        },
        status: (status) => {
          if (status.kind === 'live') return;
          console.error('Error loading pet records:', status.error);
          setState((previous) => ({ ...previous, key, failed: status.kind, error: status.error ?? new Error('unavailable'), loaded: previous.key === key && previous.loaded }));
        },
      },
    );
    return () => handle.stop();
    // `build` and `read` are derived from the key's parts; the key identifies the query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!key) return { items: [], loading: false, error: null, hasMore: false, loadingMore: false };
  if (state.key !== key) {
    const previousMax = base && state.key?.startsWith(`${base}#`) ? Number(state.key.slice(base.length + 1)) : Number.NaN;
    if (!state.error && state.loaded && Number.isFinite(previousMax) && previousMax < max) {
      return { items: state.items, loading: false, error: null, hasMore: true, loadingMore: true };
    }
    return { items: [], loading: true, error: null, hasMore: false, loadingMore: false };
  }
  if (state.error) return { items: [], loading: false, error: state.error, failure: state.failed || 'retrying', hasMore: false, loadingMore: false };
  return { items: state.items, loading: false, error: null, hasMore: state.size >= max, loadingMore: false };
}

const notesRef = (householdId: string, petId: string) => collection(db, 'households', householdId, 'pets', petId, 'notes');
const weightsRef = (householdId: string, petId: string) => collection(db, 'households', householdId, 'pets', petId, 'weights');

/** How many pinned notes are read (more than the form allows, so a race past the cap still shows). */
const PINNED_READ = PINNED_NOTES_MAX * 2;

/**
 * A pet's pinned notes, live (PE-29b/c): one small query (`pinned == true`,
 * single-field index), sorted newest pin first on the client. The card's
 * headline line and the Notes tab use the same query, which Firestore serves
 * from one listener target.
 */
export function usePinnedNotes(householdId: string | null | undefined, petId: string): LiveList<PetNote> & { headline: PetNote | null } {
  const base = householdId ? `${householdId}/${petId}/pinned` : null;
  const list = useLiveDocs(base, PINNED_READ, householdId ? () => query(notesRef(householdId, petId), where('pinned', '==', true), limitTo(PINNED_READ)) : null, readNote);
  const items = pinnedNotes(list.items);
  return { ...list, items, hasMore: false, headline: headlineNote(items) };
}

/** A pet's behaviour entries (unpinned notes), newest first, live, paginated (PE-29d, PE-21h). */
export function useBehaviourEntries(householdId: string | null | undefined, petId: string, max: number): LiveList<PetNote> {
  const base = householdId ? `${householdId}/${petId}/notes` : null;
  // Ordered by `date` (one field); pinned notes in the window are left out here, as the pinned list shows them.
  const list = useLiveDocs(base, max, householdId ? () => query(notesRef(householdId, petId), orderBy('date', 'desc'), limitTo(max)) : null, readNote);
  return { ...list, items: behaviourEntries(list.items) };
}

/** A pet's weights, newest first, live, paginated (PE-28b/c, PE-21h). */
export function usePetWeights(householdId: string | null | undefined, petId: string, max: number): LiveList<WeightEntry> {
  const base = householdId ? `${householdId}/${petId}/weights` : null;
  return useLiveDocs(base, max, householdId ? () => query(weightsRef(householdId, petId), orderBy('date', 'desc'), limitTo(max)) : null, readWeight);
}
