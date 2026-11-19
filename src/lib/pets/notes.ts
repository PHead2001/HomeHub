/**
 * Pet notes (P5: PE-29, D-P11), pure: what a note holds, how a draft is checked,
 * what a create, edit or pin writes, and which pinned note is the pet's
 * headline. The Firestore side is `note-transaction.ts` (instance injected);
 * the UI is `src/components/pets/notes-tab.tsx`. A registered-tablet device
 * action (F4) can call the same planners with the documents it read.
 *
 * One collection per pet, `households/{h}/pets/{p}/notes/{noteId}`:
 * - a **pinned** note is an always-true fact (allergies, temperament,
 *   microchip), listed newest pin first; the first one is the card's line;
 * - an unpinned note is a dated **behaviour entry** with an optional tag,
 *   newest first. Pinning an entry moves it to the pinned list and back.
 */
import { householdDayStart, householdToday } from '../household-day';
import { toDate } from './care';

export const NOTE_TAGS = ['behaviour', 'health', 'training', 'vet'] as const;
export type NoteTag = (typeof NOTE_TAGS)[number];
export const NOTE_TAG_LABELS: Record<NoteTag, string> = {
  behaviour: 'Behaviour',
  health: 'Health',
  training: 'Training',
  vet: 'Vet',
};

/** Longest note text (rules: the same bound). */
export const NOTE_TEXT_MAX = 500;
/** Pinned notes shown at most (a short list of facts; more are refused in the form). */
export const PINNED_NOTES_MAX = 12;
/** A device clock may run a little ahead: a note's date may be at most this far in the future (rules: the same). */
export const NOTE_FUTURE_ALLOWANCE_MS = 10 * 60_000;

/** A stored note, as read (timestamps as dates). */
export type PetNote = {
  id: string;
  text: string;
  tag: NoteTag | null;
  pinned: boolean;
  pinnedAt: Date | null;
  /** When it happened (a behaviour entry) or was written (a pinned note). */
  date: Date | null;
  /** Server time of the write (opens the author's 10-minute delete window). */
  loggedAt: Date | null;
  loggedByUid: string | null;
  loggedByName: string | null;
  editedAt: Date | null;
  editedByName: string | null;
};

const isTag = (value: unknown): value is NoteTag => typeof value === 'string' && (NOTE_TAGS as readonly string[]).includes(value);
const str = (value: unknown) => (typeof value === 'string' ? value : null);

/** Reads a note document; anything malformed reads as harmless values, never a crash. */
export function readNote(id: string, data: Record<string, unknown>): PetNote {
  return {
    id,
    text: str(data.text) ?? '',
    tag: isTag(data.tag) ? data.tag : null,
    pinned: data.pinned === true,
    pinnedAt: toDate(data.pinnedAt),
    date: toDate(data.date),
    loggedAt: toDate(data.loggedAt),
    loggedByUid: str(data.loggedByUid),
    loggedByName: str(data.loggedByName),
    editedAt: toDate(data.editedAt),
    editedByName: str(data.editedByName),
  };
}

/* ------------------------------------------------------------------------- */
/* Operation ids (one press, one note)                                        */
/* ------------------------------------------------------------------------- */

const OP_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** One id per add (taken when the form opens or the press starts), reused by retries. */
export function newRecordOpId(): string {
  return globalThis.crypto.randomUUID();
}

/** The document id of the record an operation creates: the operation id itself. */
export function recordDocId(opId: string): string {
  if (!OP_ID.test(opId)) throw new Error('invalid-record-operation');
  return opId;
}

/* ------------------------------------------------------------------------- */
/* Drafts                                                                     */
/* ------------------------------------------------------------------------- */

export type NoteDraft = {
  text: string;
  tag: NoteTag | '';
  pinned: boolean;
  /** Household day of a behaviour entry (`yyyy-MM-dd`); today when blank. */
  day: string;
};

export type NoteDraftErrors = { text?: string; day?: string; pinned?: string };

/** Checks a note draft. `today` is the household day; `pinnedCount` the pinned notes already there. */
export function validateNoteDraft(draft: NoteDraft, today: string, pinnedCount = 0): NoteDraftErrors {
  const errors: NoteDraftErrors = {};
  const text = draft.text.trim();
  if (!text) errors.text = draft.pinned ? 'Write the fact to pin, e.g. "Allergic to chicken".' : 'Write what happened.';
  else if (text.length > NOTE_TEXT_MAX) errors.text = `Keep it under ${NOTE_TEXT_MAX + 1} characters.`;
  if (!draft.pinned && draft.day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.day)) errors.day = 'Pick a date.';
    else if (draft.day > today) errors.day = 'Pick a day that has already started.';
  }
  if (draft.pinned && pinnedCount >= PINNED_NOTES_MAX) errors.pinned = `Up to ${PINNED_NOTES_MAX} pinned notes. Unpin or remove one first.`;
  return errors;
}

/**
 * The effective time of a new note: now for a pinned note or an entry for
 * today; noon (household time) of an earlier household day otherwise, so the
 * entry sorts on its own day in every zone.
 */
export function noteDate(draft: Pick<NoteDraft, 'pinned' | 'day'>, now: Date, timeZone?: string | null): Date {
  const today = householdToday(timeZone, now);
  if (draft.pinned || !draft.day || draft.day >= today) return now;
  return new Date(householdDayStart(timeZone, draft.day).getTime() + 12 * 3_600_000);
}

/** The fields a create writes besides the server times (`loggedAt`, `pinnedAt`). */
export function noteCreateFields(draft: NoteDraft, author: { uid: string; name: string }, date: Date) {
  return {
    text: draft.text.trim(),
    ...(draft.tag ? { tag: draft.tag } : {}),
    pinned: draft.pinned,
    date,
    loggedByUid: author.uid,
    loggedByName: author.name,
  };
}

/* ------------------------------------------------------------------------- */
/* Lists                                                                      */
/* ------------------------------------------------------------------------- */

const time = (value: Date | null) => value?.getTime() ?? 0;

/** Pinned notes, newest pin first (the first one is the pet's headline note). */
export function pinnedNotes(notes: readonly PetNote[]): PetNote[] {
  return notes.filter((note) => note.pinned).sort((a, b) => time(b.pinnedAt) - time(a.pinnedAt) || time(b.date) - time(a.date) || a.id.localeCompare(b.id));
}

/** Behaviour entries (unpinned), newest first. */
export function behaviourEntries(notes: readonly PetNote[]): PetNote[] {
  return notes.filter((note) => !note.pinned).sort((a, b) => time(b.date) - time(a.date) || time(b.loggedAt) - time(a.loggedAt) || a.id.localeCompare(b.id));
}

/** The pinned note the card and the board show (PE-29c): the first pinned note, or null. */
export function headlineNote(notes: readonly PetNote[]): PetNote | null {
  return pinnedNotes(notes)[0] ?? null;
}

/** "Behaviour · Nov 12 · by Sam" style meta for an entry. */
export function noteTagLabel(tag: NoteTag | null): string | null {
  return tag ? NOTE_TAG_LABELS[tag] : null;
}
