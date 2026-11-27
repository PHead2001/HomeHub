'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import { Pencil, Repeat } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { MemberAvatar } from '@/components/member-avatar';
import { choreDueKey, dayFromKey, type ChoreRecord } from '@/lib/chores/dates';
import { choreHistory, editableFields, validateDetailEdit, type DetailEdit, type DetailEditErrors } from '@/lib/chores/detail';
import type { ChoreCapabilities } from '@/lib/chores/list';
import type { HouseholdPerson } from '@/lib/member-directory';
import type { MemberColor } from '@/lib/member-colors';
import type { ChoreTemplate } from '@/lib/types';
import { memberName } from './assignee-select';
import { StepRow } from './chore-list';

type DetailSheetProps = {
  /** The chore as the page holds it now (live), or null when closed. */
  chore: ChoreRecord | null;
  onClose: () => void;
  chores: readonly ChoreRecord[];
  template: ChoreTemplate | null;
  roomNames: string[];
  usersByUid: Map<string, HouseholdPerson>;
  colors: Map<string, MemberColor>;
  capabilities: ChoreCapabilities;
  onSubTaskToggle: (chore: ChoreRecord, subTask: string) => void;
  onSave: (chore: ChoreRecord, edit: DetailEdit) => Promise<boolean>;
  /** Opens the library chore's editor (every day of the series). */
  onEditSeries: (template: ChoreTemplate) => void;
};

const dayLabel = (day: string) => (day ? format(dayFromKey(day), 'EEE, MMM d') : 'No date');

/**
 * Tapping a chore's name opens this sheet (CH-15): who and when, notes, steps (tickable
 * by members who may complete chores), the history of this chore and the other days of
 * its series, and for members who may edit chores an Edit form (name and notes; the day
 * too for a chore that is not a generated day of a repeat) plus "Edit every day" for a
 * library chore.
 */
export function ChoreDetailSheet(props: DetailSheetProps) {
  const { chore } = props;
  return (
    <Sheet open={chore !== null} onOpenChange={open => { if (!open) props.onClose(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-4 overflow-y-auto overscroll-contain pb-[calc(1.5rem+var(--keyboard-inset,0px))] sm:max-w-md" data-testid="chore-detail-sheet">
        {chore && <DetailBody key={chore.id} {...props} chore={chore} />}
      </SheetContent>
    </Sheet>
  );
}

function DetailBody(props: DetailSheetProps & { chore: ChoreRecord }) {
  const { chore, capabilities } = props;
  const [editing, setEditing] = useState(false);
  const user = chore.assignedToUid ? props.usersByUid.get(chore.assignedToUid) : undefined;
  const assignee = user ? memberName(user) : chore.assignedToDisplayName || 'Unassigned';
  const nameOf = (uid: string) => {
    const person = props.usersByUid.get(uid);
    return person ? memberName(person) : undefined;
  };
  const history = choreHistory(chore, props.chores, nameOf);
  const steps = chore.subTasks ?? [];
  const due = choreDueKey(chore);
  return (
    <>
      <SheetHeader className="text-left">
        <SheetTitle className="break-words pr-8 font-headline text-2xl">{chore.task}</SheetTitle>
        <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          {user && <MemberAvatar uid={user.uid} name={assignee} photoUrl={user.avatarUrl} color={props.colors.get(user.uid)} size="sm" decorative />}
          <span>{assignee}</span>
          <span aria-hidden>·</span>
          <span>{chore.isCompleted ? 'Done' : `Due ${dayLabel(due)}`}</span>
          {props.roomNames.length > 0 && <><span aria-hidden>·</span><span>{props.roomNames.join(', ')}</span></>}
          {props.template?.recurrence && <span className="inline-flex items-center gap-1"><Repeat aria-hidden className="h-3.5 w-3.5" /> Repeats</span>}
        </SheetDescription>
      </SheetHeader>

      {editing ? (
        <DetailEditForm chore={chore} onCancel={() => setEditing(false)} onSave={async edit => {
          const ok = await props.onSave(chore, edit);
          if (ok) setEditing(false);
          return ok;
        }} />
      ) : (
        <>
          <section aria-labelledby="chore-detail-notes">
            <h3 id="chore-detail-notes" className="text-sm font-semibold text-foreground">Notes</h3>
            <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{chore.notes?.trim() ? chore.notes : 'No notes.'}</p>
          </section>

          {steps.length > 0 && (
            <section aria-labelledby="chore-detail-steps">
              <h3 id="chore-detail-steps" className="text-sm font-semibold text-foreground">Steps</h3>
              <div className="mt-1 space-y-0.5">
                {steps.map(step => (
                  <StepRow key={step} chore={chore} subTask={step} disabled={chore.isCompleted || !capabilities.canComplete} onToggle={props.onSubTaskToggle} />
                ))}
              </div>
            </section>
          )}

          <section aria-labelledby="chore-detail-history">
            <h3 id="chore-detail-history" className="text-sm font-semibold text-foreground">History</h3>
            {history.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">Not done yet{chore.templateId ? ' on any day in the last 90 days' : ''}.</p>
            ) : (
              <ul className="mt-1 space-y-1" data-testid="chore-detail-history">
                {history.map(entry => (
                  <li key={entry.id} className="flex min-h-[var(--target-min)] items-center justify-between gap-2 rounded-md bg-muted/40 px-3 text-sm">
                    <span>{entry.by ? `Done by ${entry.by}` : 'Done'}{entry.current ? ' (this one)' : ''}</span>
                    <span className="text-muted-foreground">{format(entry.at, 'EEE, MMM d')}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {capabilities.canEdit && (
            <div className="mt-auto flex flex-wrap gap-2 pt-2">
              <Button variant="outline" onClick={() => setEditing(true)}><Pencil className="mr-2 h-4 w-4" /> Edit</Button>
              {props.template && (
                <Button variant="ghost" onClick={() => props.onEditSeries(props.template!)}><Repeat className="mr-2 h-4 w-4" /> Edit every day</Button>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}

function DetailEditForm({ chore, onCancel, onSave }: { chore: ChoreRecord; onCancel: () => void; onSave: (edit: DetailEdit) => Promise<boolean> }) {
  const editable = editableFields(chore);
  const [task, setTask] = useState(chore.task);
  const [notes, setNotes] = useState(chore.notes ?? '');
  const [dueDay, setDueDay] = useState(choreDueKey(chore));
  const [errors, setErrors] = useState<DetailEditErrors>({});
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    const edit: DetailEdit = { task: task.trim(), notes: notes.trim(), ...(editable.day ? { dueDay } : {}) };
    const found = validateDetailEdit(edit);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    try { await onSave(edit); } finally { setSaving(false); }
  };
  return (
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit(); }} aria-label={`Edit ${chore.task}`}>
      <div className="space-y-1.5">
        <Label htmlFor="chore-detail-task">Name</Label>
        <Input {...fieldErrorProps('chore-detail-task', errors.task)} maxLength={500} value={task} onChange={event => { setTask(event.target.value); setErrors(p => ({ ...p, task: undefined })); }} />
        <FieldError id="chore-detail-task">{errors.task}</FieldError>
      </div>
      {editable.day && (
        <div className="space-y-1.5">
          <Label htmlFor="chore-detail-day">Due</Label>
          <Input {...fieldErrorProps('chore-detail-day', errors.dueDay)} type="date" value={dueDay} onChange={event => { setDueDay(event.target.value); setErrors(p => ({ ...p, dueDay: undefined })); }} />
          <FieldError id="chore-detail-day">{errors.dueDay}</FieldError>
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="chore-detail-notes-input">Notes</Label>
        <Textarea id="chore-detail-notes-input" maxLength={5000} value={notes} onChange={event => setNotes(event.target.value)} />
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>Save</Button>
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
