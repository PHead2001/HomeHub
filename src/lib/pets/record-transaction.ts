/**
 * Notes and weights, Firestore side (P5: PE-29, PE-28), with the Firestore
 * instance passed in, so the app (`src/components/pets/records-api.ts` binds
 * the app's `db`) and the emulator tests run the same code. The decisions are
 * pure (`notes.ts`, `weights.ts`, `pet-actions.ts`).
 *
 * - **One add, one record.** The caller takes an operation id once per add
 *   (`newRecordOpId`) and reuses it on Retry; the record is created under that
 *   id only. Online a transaction reads the id first: if it exists and is the
 *   caller's, the add already happened (`replayed`, nothing written); a foreign
 *   record under that id is refused. Two sessions running the same add at once
 *   end with one record (the second commit fails the "does not exist"
 *   precondition, retries and finds the first). The rules refuse a create over
 *   an existing id (it would be an update, and an update must be a real edit).
 * - **Offline** the create is queued once under the same id (`queued`).
 * - **Edits are bound to what was shown.** Editing a note's text sends the text
 *   the form opened with; if someone changed it meanwhile the transaction
 *   writes nothing and says so (`NoteChangedError`), so a stale form never
 *   overwrites a newer edit. Offline the edit is queued as is.
 */
import {
  deleteDoc,
  deleteField,
  doc,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  type DocumentReference,
  type Firestore,
} from 'firebase/firestore';
import { awaitWriteUnlessOffline, isBrowserOffline } from '../firestore-offline';
import { noteCreateFields, recordDocId, type NoteDraft, type NoteTag } from './notes';
import type { WeightUnit } from './weights';

export type RecordWriteOutcome = 'saved' | 'replayed' | 'queued';
type Author = { uid: string; name: string };

const notesPath = (householdId: string, petId: string) => ['households', householdId, 'pets', petId, 'notes'] as const;
const weightsPath = (householdId: string, petId: string) => ['households', householdId, 'pets', petId, 'weights'] as const;

export const noteRef = (db: Firestore, householdId: string, petId: string, noteId: string) => doc(db, ...notesPath(householdId, petId), noteId);
export const weightRef = (db: Firestore, householdId: string, petId: string, weightId: string) => doc(db, ...weightsPath(householdId, petId), weightId);

/** A record id already used by someone else's record (a forged or colliding operation id). */
export class RecordIdTakenError extends Error {
  constructor() {
    super('That entry could not be saved. Please try again.');
    this.name = 'RecordIdTakenError';
  }
}

/** The note changed (or was removed) since the form opened. */
export class NoteChangedError extends Error {
  constructor(readonly gone: boolean) {
    super(gone ? 'This note was removed meanwhile.' : 'Someone changed this note meanwhile. Check it and save again.');
    this.name = 'NoteChangedError';
  }
}

async function createOnce(db: Firestore, ref: DocumentReference, data: Record<string, unknown>, author: Author, onLateError?: (error: unknown) => void): Promise<RecordWriteOutcome> {
  if (isBrowserOffline()) {
    // The persistent queue sends it once; a press already queued on this device is the same id.
    return awaitWriteUnlessOffline(setDoc(ref, data), onLateError);
  }
  return runTransaction(db, async (transaction) => {
    const existing = await transaction.get(ref);
    if (existing.exists()) {
      if (existing.get('loggedByUid') === author.uid) return 'replayed' as const;
      throw new RecordIdTakenError();
    }
    transaction.set(ref, data);
    return 'saved' as const;
  });
}

/* ------------------------------------------------------------------------- */
/* Notes (PE-29, D-P11)                                                       */
/* ------------------------------------------------------------------------- */

export type CreateNoteInput = {
  householdId: string;
  petId: string;
  /** One per add (`newRecordOpId`), reused by Retry. */
  opId: string;
  draft: NoteDraft;
  author: Author;
  /** The note's effective time (`noteDate`). */
  date: Date;
  onLateError?: (error: unknown) => void;
};

export function runCreateNote(db: Firestore, input: CreateNoteInput): Promise<RecordWriteOutcome> {
  const ref = noteRef(db, input.householdId, input.petId, recordDocId(input.opId));
  const data = {
    ...noteCreateFields(input.draft, input.author, input.date),
    loggedAt: serverTimestamp(),
    ...(input.draft.pinned ? { pinnedAt: serverTimestamp() } : {}),
  };
  return createOnce(db, ref, data, input.author, input.onLateError);
}

export type EditNoteInput = {
  householdId: string;
  petId: string;
  noteId: string;
  /** The text and tag the form opened with (a newer edit by someone else is not overwritten). */
  expected: { text: string; tag: NoteTag | null };
  text: string;
  tag: NoteTag | null;
  editor: Author;
  onLateError?: (error: unknown) => void;
};

export async function runEditNote(db: Firestore, input: EditNoteInput): Promise<'saved' | 'queued'> {
  const ref = noteRef(db, input.householdId, input.petId, input.noteId);
  const fields = {
    text: input.text.trim(),
    tag: input.tag ?? deleteField(),
    editedAt: serverTimestamp(),
    editedByUid: input.editor.uid,
    editedByName: input.editor.name,
  };
  if (isBrowserOffline()) return awaitWriteUnlessOffline(updateDoc(ref, fields), input.onLateError);
  await runTransaction(db, async (transaction) => {
    const current = await transaction.get(ref);
    if (!current.exists()) throw new NoteChangedError(true);
    const tag = current.get('tag') ?? null;
    if (current.get('text') !== input.expected.text || tag !== input.expected.tag) throw new NoteChangedError(false);
    transaction.update(ref, fields);
  });
  return 'saved';
}

/**
 * Pins (or moves first: a pinned note pinned again comes first) or unpins a
 * note. Idempotent by intent: unpinning an unpinned note changes nothing.
 */
export async function runSetNotePinned(
  db: Firestore,
  input: { householdId: string; petId: string; noteId: string; pinned: boolean; onLateError?: (error: unknown) => void },
): Promise<'saved' | 'queued'> {
  const ref = noteRef(db, input.householdId, input.petId, input.noteId);
  const fields = input.pinned ? { pinned: true, pinnedAt: serverTimestamp() } : { pinned: false, pinnedAt: deleteField() };
  if (isBrowserOffline()) return awaitWriteUnlessOffline(updateDoc(ref, fields), input.onLateError);
  await runTransaction(db, async (transaction) => {
    const current = await transaction.get(ref);
    if (!current.exists()) throw new NoteChangedError(true);
    if (!input.pinned && current.get('pinned') !== true) return;
    transaction.update(ref, fields);
  });
  return 'saved';
}

export function runDeleteNote(db: Firestore, input: { householdId: string; petId: string; noteId: string; onLateError?: (error: unknown) => void }): Promise<'saved' | 'queued'> {
  return awaitWriteUnlessOffline(deleteDoc(noteRef(db, input.householdId, input.petId, input.noteId)), input.onLateError);
}

/* ------------------------------------------------------------------------- */
/* Weights (PE-28b)                                                           */
/* ------------------------------------------------------------------------- */

export type CreateWeightInput = {
  householdId: string;
  petId: string;
  opId: string;
  value: number;
  unit: WeightUnit;
  date: Date;
  author: Author;
  onLateError?: (error: unknown) => void;
};

export function runCreateWeight(db: Firestore, input: CreateWeightInput): Promise<RecordWriteOutcome> {
  const ref = weightRef(db, input.householdId, input.petId, recordDocId(input.opId));
  const data = {
    value: input.value,
    unit: input.unit,
    date: input.date,
    loggedAt: serverTimestamp(),
    loggedByUid: input.author.uid,
    loggedByName: input.author.name,
  };
  return createOnce(db, ref, data, input.author, input.onLateError);
}

export function runDeleteWeight(db: Firestore, input: { householdId: string; petId: string; weightId: string; onLateError?: (error: unknown) => void }): Promise<'saved' | 'queued'> {
  return awaitWriteUnlessOffline(deleteDoc(weightRef(db, input.householdId, input.petId, input.weightId)), input.onLateError);
}
