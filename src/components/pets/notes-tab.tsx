'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import { ArrowUpToLine, Loader2, Pencil, Pin, PinOff, PlusCircle, Trash2 } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { PetLogDeleteAlert } from '@/components/pet-log-delete-alert';
import { householdToday } from '@/lib/household-day';
import { loggerName } from '@/lib/pets/care';
import { unavailableText } from '@/lib/pets/live-listener';
import {
  NOTE_TAGS,
  NOTE_TAG_LABELS,
  NOTE_TEXT_MAX,
  newRecordOpId,
  noteDate,
  noteTagLabel,
  validateNoteDraft,
  type NoteDraft,
  type NoteDraftErrors,
  type NoteTag,
  type PetNote,
} from '@/lib/pets/notes';
import { mayDeleteNote, mayEditNote, mayPet } from '@/lib/pets/pet-actions';
import { NoteChangedError } from '@/lib/pets/record-transaction';
import { LoggedBy } from './logged-by';
import { LoadMoreHistory } from './load-more';
import { useHistoryWindow } from './pet-log-api';
import { createNote, deleteNote, editNote, setNotePinned, useBehaviourEntries } from './records-api';
import { useSharedPetCare } from './care-store';
import { useNow } from './use-now';

const NO_TAG = 'none';

function TagPicker({ id, value, onChange }: { id: string; value: NoteTag | ''; onChange: (tag: NoteTag | '') => void }) {
  return (
    <Select value={value || NO_TAG} onValueChange={(next) => onChange(next === NO_TAG ? '' : (next as NoteTag))}>
      <SelectTrigger id={id} className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_TAG}>No tag</SelectItem>
        {NOTE_TAGS.map((tag) => (
          <SelectItem key={tag} value={tag}>{NOTE_TAG_LABELS[tag]}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

type AddForm = { pinned: boolean; opId: string; draft: NoteDraft; errors: NoteDraftErrors; submitted: boolean };

/**
 * The pet page's Notes tab (PE-29a, D-P11): pinned notes (always-true facts,
 * newest pin first; the first one is the card's line) and the behaviour log
 * (dated entries with an optional tag, newest first, paginated). Live for every
 * member; controls follow `PET_ACTION_PERMISSIONS` and the author rules, and
 * the rules enforce them.
 */
export function NotesTab({ petId, petName }: { petId: string; petName: string }) {
  const { currentUser, permissions, household } = useAuth();
  const { toast, toastError } = useToast();
  const now = useNow();
  const timeZone = household?.timeZone ?? null;
  const today = householdToday(timeZone, now);
  const householdId = currentUser?.householdId ?? null;
  const actor = { uid: currentUser?.uid, permissions };
  const canAdd = mayPet('pets.note.add', permissions);
  // The pinned list is the care store's (PE-21a), shared with the headline line.
  const pinned = useSharedPetCare(householdId, petId).pinned;
  const history = useHistoryWindow(petId);
  const entries = useBehaviourEntries(householdId, petId, history.max);

  const [adding, setAdding] = useState<AddForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<PetNote | null>(null);
  const [toDelete, setToDelete] = useState<PetNote | null>(null);
  // The control that opened a dialog gets focus back when it closes (PE-20e).
  const [returnTo, setReturnTo] = useState<HTMLElement | null>(null);
  const focusBack = (event: Event) => {
    if (!returnTo?.isConnected) return;
    event.preventDefault();
    returnTo.focus();
  };

  const author = currentUser ? { uid: currentUser.uid, name: loggerName(currentUser) } : null;
  const lateError = (error: unknown) => toastError(error, "Couldn't save the note");

  // One operation id per opened form: Retry after a failure or a lost answer reuses it (one add, one note).
  const openAdd = (pin: boolean) => setAdding({ pinned: pin, opId: newRecordOpId(), draft: { text: '', tag: '', pinned: pin, day: '' }, errors: {}, submitted: false });
  const changeDraft = (patch: Partial<NoteDraft>) => setAdding((form) => {
    if (!form) return form;
    const draft = { ...form.draft, ...patch };
    return { ...form, draft, errors: form.submitted ? validateNoteDraft(draft, today, pinned.items.length) : form.errors };
  });

  const submitAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!adding || !householdId || !author || saving) return;
    const errors = validateNoteDraft(adding.draft, today, pinned.items.length);
    if (Object.keys(errors).length > 0) {
      setAdding({ ...adding, errors, submitted: true });
      document.getElementById(errors.text ? `note-text-${petId}` : `note-day-${petId}`)?.focus();
      return;
    }
    setSaving(true);
    try {
      const outcome = await createNote({
        householdId,
        petId,
        opId: adding.opId,
        draft: adding.draft,
        author,
        date: noteDate(adding.draft, new Date(), timeZone),
        onLateError: lateError,
      });
      toast(outcome === 'queued'
        ? { title: 'Saved on this device', description: 'The note will sync when you are back online.' }
        : { title: adding.pinned ? 'Note pinned' : 'Entry added', description: adding.draft.text.trim().slice(0, 80) });
      setAdding(null);
    } catch (error) {
      toastError(error, "Couldn't save the note");
    } finally {
      setSaving(false);
    }
  };

  const pinChange = async (note: PetNote, pin: boolean) => {
    if (!householdId) return;
    try {
      await setNotePinned({ householdId, petId, noteId: note.id, pinned: pin, onLateError: lateError });
      toast({ title: pin ? (note.pinned ? 'Shown first' : 'Note pinned') : 'Note unpinned' });
    } catch (error) {
      toastError(error, "Couldn't change the note");
    }
  };

  const remove = async (note: PetNote) => {
    if (!householdId) return;
    try {
      await deleteNote({ householdId, petId, noteId: note.id, onLateError: (error) => toastError(error, "Couldn't remove the note") });
      toast({ title: 'Note removed' });
    } catch (error) {
      toastError(error, "Couldn't remove the note");
    }
  };

  const noteActions = (note: PetNote, first: boolean) => {
    const canEdit = mayEditNote(note, actor);
    const canDelete = mayDeleteNote(note, actor, now);
    if (!canEdit && !canDelete) return null;
    const label = note.text.slice(0, 40);
    return (
      <div className="flex flex-shrink-0 items-center gap-1">
        {canEdit && note.pinned && !first && (
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Show "${label}" first`} onClick={() => void pinChange(note, true)}>
            <ArrowUpToLine className="h-4 w-4" />
          </Button>
        )}
        {canEdit && (
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={note.pinned ? `Unpin "${label}"` : `Pin "${label}"`} onClick={() => void pinChange(note, !note.pinned)}>
            {note.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          </Button>
        )}
        {canEdit && (
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit "${label}"`} onClick={(event) => { setReturnTo(event.currentTarget); setEditing(note); }}>
            <Pencil className="h-4 w-4" />
          </Button>
        )}
        {canDelete && (
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Delete "${label}"`} onClick={(event) => { setReturnTo(event.currentTarget); setToDelete(note); }}>
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
    );
  };

  const meta = (note: PetNote, showDate: boolean) => (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {note.tag && <span className="rounded-full border border-border px-2 py-0.5 text-foreground">{noteTagLabel(note.tag)}</span>}
      {showDate && <span>{note.date ? format(note.date, 'PPP') : 'Unknown date'}</span>}
      <LoggedBy entry={{ loggedByUid: note.loggedByUid ?? undefined, loggedByName: note.loggedByName ?? undefined }} />
      {note.editedAt && <span>· edited{note.editedByName ? ` by ${note.editedByName}` : ''}</span>}
    </p>
  );

  const addForm = adding && (
    <form onSubmit={submitAdd} noValidate className="space-y-3 rounded-lg border p-3" aria-label={adding.pinned ? 'Pin a note' : 'Add a behaviour entry'}>
      <div className="grid gap-2">
        <Label htmlFor={`note-text-${petId}`}>{adding.pinned ? 'Fact to pin' : 'What happened'}</Label>
        <Textarea
          rows={2}
          maxLength={NOTE_TEXT_MAX + 20}
          value={adding.draft.text}
          placeholder={adding.pinned ? 'Allergic to chicken' : 'Barked at the mail carrier, calmer after a walk'}
          onChange={(event) => changeDraft({ text: event.target.value })}
          {...fieldErrorProps(`note-text-${petId}`, adding.errors.text)}
        />
        <FieldError id={`note-text-${petId}`}>{adding.errors.text}</FieldError>
      </div>
      <div className="flex flex-wrap gap-4">
        <div className="grid gap-2">
          <Label htmlFor={`note-tag-${petId}`}>Tag</Label>
          <TagPicker id={`note-tag-${petId}`} value={adding.draft.tag} onChange={(tag) => changeDraft({ tag })} />
        </div>
        {!adding.pinned && (
          <div className="grid gap-2">
            <Label htmlFor={`note-day-${petId}`}>Date</Label>
            <Input
              type="date"
              className="w-44"
              max={today}
              value={adding.draft.day || today}
              onChange={(event) => changeDraft({ day: event.target.value })}
              {...fieldErrorProps(`note-day-${petId}`, adding.errors.day)}
            />
            <FieldError id={`note-day-${petId}`}>{adding.errors.day}</FieldError>
          </div>
        )}
      </div>
      <FieldError id={`note-pinned-${petId}`}>{adding.errors.pinned}</FieldError>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={saving} onClick={() => setAdding(null)}>Cancel</Button>
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
          {adding.pinned ? 'Pin note' : 'Add entry'}
        </Button>
      </div>
    </form>
  );

  return (
    <>
      <PetLogDeleteAlert
        open={!!toDelete}
        logType="note"
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) void remove(toDelete);
          setToDelete(null);
        }}
        onCloseAutoFocus={focusBack}
      />
      <EditNoteDialog
        note={editing}
        petId={petId}
        onClose={() => setEditing(null)}
        onCloseAutoFocus={focusBack}
        onSave={async (text, tag) => {
          if (!householdId || !author || !editing) return 'failed';
          try {
            await editNote({ householdId, petId, noteId: editing.id, expected: { text: editing.text, tag: editing.tag }, text, tag, editor: author, onLateError: lateError });
            toast({ title: 'Note saved' });
            return 'saved';
          } catch (error) {
            if (error instanceof NoteChangedError) return error.gone ? 'gone' : 'changed';
            toastError(error, "Couldn't save the note");
            return 'failed';
          }
        }}
      />
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="font-headline">Notes</CardTitle>
            <CardDescription>Pinned facts about {petName}, and a log of behaviour, health and training.</CardDescription>
          </div>
          {canAdd && !adding && (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => openAdd(true)}>
                <Pin className="mr-2 h-4 w-4" /> Pin a note
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => openAdd(false)}>
                <PlusCircle className="mr-2 h-4 w-4" /> Add entry
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-6">
          {addForm}

          <section className="space-y-3" aria-labelledby={`pinned-notes-${petId}`}>
            <h3 id={`pinned-notes-${petId}`} className="font-semibold">Pinned</h3>
            {pinned.loading && <Skeleton className="h-12 w-full" />}
            {!pinned.loading && pinned.error ? (
              <p className="py-2 text-sm text-muted-foreground">{unavailableText('Pinned notes', pinned.failure ?? 'retrying')}</p>
            ) : null}
            {!pinned.loading && !pinned.error && pinned.items.length === 0 && (
              <p className="py-2 text-sm text-muted-foreground">Nothing pinned yet. Pin facts everyone should know, like allergies or a microchip number.</p>
            )}
            {!pinned.loading && !pinned.error && pinned.items.length > 0 && (
              <ul className="space-y-2" data-testid="pinned-notes">
                {pinned.items.map((note, index) => (
                  <li key={note.id} className="flex items-start justify-between gap-3 rounded-md border border-border bg-secondary/40 p-3 text-sm">
                    <div className="min-w-0 space-y-1">
                      <p className="flex items-start gap-2 break-words font-medium text-foreground [overflow-wrap:anywhere]">
                        <Pin aria-hidden className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                        <span>{note.text}</span>
                      </p>
                      {meta(note, false)}
                    </div>
                    {noteActions(note, index === 0)}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-3" aria-labelledby={`behaviour-log-${petId}`}>
            <h3 id={`behaviour-log-${petId}`} className="font-semibold">Behaviour log</h3>
            {entries.loading && (
              <div className="space-y-2">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
            )}
            {!entries.loading && entries.error ? (
              <p className="py-4 text-center text-sm text-muted-foreground">{unavailableText('Behaviour log', entries.failure ?? 'retrying')}</p>
            ) : null}
            {!entries.loading && !entries.error && entries.items.length === 0 && !entries.hasMore && (
              <p className="py-4 text-center text-sm text-muted-foreground">No entries yet.</p>
            )}
            {!entries.loading && !entries.error && entries.items.map((note) => (
              <div key={note.id} className="flex items-start justify-between gap-3 rounded-md bg-secondary/50 p-3 text-sm">
                <div className="min-w-0 space-y-1">
                  <p className="break-words text-foreground [overflow-wrap:anywhere]">{note.text}</p>
                  {meta(note, true)}
                </div>
                {noteActions(note, false)}
              </div>
            ))}
            {!entries.loading && !entries.error && (
              <LoadMoreHistory hasMore={entries.hasMore} loadingMore={entries.loadingMore} onLoadMore={history.loadMore} what="behaviour entries" />
            )}
          </section>
        </CardContent>
      </Card>
    </>
  );
}

type SaveOutcome = 'saved' | 'changed' | 'gone' | 'failed';

/** Edits a note's text and tag, bound to the version it opened with (a newer edit is never overwritten). */
function EditNoteDialog({ note, petId, onClose, onCloseAutoFocus, onSave }: {
  note: PetNote | null;
  petId: string;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
  onSave: (text: string, tag: NoteTag | null) => Promise<SaveOutcome>;
}) {
  const [shown, setShown] = useState<PetNote | null>(null);
  const [text, setText] = useState('');
  const [tag, setTag] = useState<NoteTag | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (note && note !== shown) {
    setShown(note);
    setText(note.text);
    setTag(note.tag ?? '');
    setError(null);
  }
  if (!note && shown) setShown(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const trimmed = text.trim();
    if (!trimmed) return setError('Write the note, or delete it instead.');
    if (trimmed.length > NOTE_TEXT_MAX) return setError(`Keep it under ${NOTE_TEXT_MAX + 1} characters.`);
    setSaving(true);
    const outcome = await onSave(trimmed, tag || null);
    setSaving(false);
    if (outcome === 'saved') onClose();
    else if (outcome === 'changed') setError('Someone changed this note meanwhile. Close and open it again to see their version.');
    else if (outcome === 'gone') setError('This note was removed meanwhile.');
  };

  return (
    <Dialog open={!!note} onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="sm:max-w-[460px]" onCloseAutoFocus={onCloseAutoFocus}>
        <form onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle className="font-headline">Edit note</DialogTitle>
            <DialogDescription>Change the text or the tag.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-3">
            <div className="grid gap-2">
              <Label htmlFor={`edit-note-text-${petId}`}>Note</Label>
              <Textarea rows={3} maxLength={NOTE_TEXT_MAX + 20} value={text} onChange={(event) => setText(event.target.value)} {...fieldErrorProps(`edit-note-text-${petId}`, error)} />
              <FieldError id={`edit-note-text-${petId}`}>{error}</FieldError>
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`edit-note-tag-${petId}`}>Tag</Label>
              <TagPicker id={`edit-note-tag-${petId}`} value={tag} onChange={setTag} />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
