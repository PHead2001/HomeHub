'use client';

// A pet's details on a registered wall tablet (docs/modules/devices/README.md, "Device
// actions: pets (F4b-2)"; docs/modules/pets/README.md, "On a registered wall tablet").
// Opened from a pet's row on the tablet's Pets board (its medication chips, **More**, or a
// reminder's `/pets/<id>?tab=medication&dose=<courseId>` link). Every write here is a device
// action through the shell's `runAction` (never a client SDK write): Give dose (the shared
// Give dose dialog, which sends `pets.dose.give` on a tablet), a behaviour note and a weighing
// (face level with Undo), and the PIN-level actions (JC-14: course finish, resume, create and
// edit; note pin, unpin, edit and delete; deleting older entries; a feeding's time; the
// profile and meal times; deleting the pet). The shell asks "Who's here?" and, for PIN-level
// actions only, the PIN pad. Reads go through `tabletListener` (the device read rules).

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DocumentSnapshot, QuerySnapshot } from 'firebase/firestore';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { GiveDoseDialog } from '@/components/pets/give-dose-dialog';
import { MedicationChips } from '@/components/pets/medication-chip';
import { useUnsavedInput } from '@/hooks/use-shell-busy';
import { tabletListener } from '@/lib/devices/tablet-listener';
import {
  courseFormValues,
  medicationDues,
  newCourseId,
  readCourse,
  validateCourseForm,
  type CourseFormValues,
  type CourseView,
} from '@/lib/pets/medication-course';
import { behaviourEntries, pinnedNotes, readNote, NOTE_TAGS, NOTE_TAG_LABELS, type NoteTag, type PetNote } from '@/lib/pets/notes';
import { formatWeight, petWeightUnit, readWeight, weightHistory, WEIGHT_UNITS, type WeightUnit } from '@/lib/pets/weights';
import { draftFromPlan, newMealSlotId, readMealPlan, validateMealDraft, type MealSlotDraft } from '@/lib/pets/meal-plan';
import { householdToday } from '@/lib/household-zone';
import { PORTION_UNITS } from '@/lib/pets/types';
import { cn } from '@/lib/utils';
import { useTablet } from './tablet-context';

type Tab = 'medication' | 'notes' | 'weight' | 'history' | 'profile';
const TABS: { key: Tab; label: string }[] = [
  { key: 'medication', label: 'Medication' },
  { key: 'notes', label: 'Notes' },
  { key: 'weight', label: 'Weight' },
  { key: 'history', label: 'History' },
  { key: 'profile', label: 'Profile' },
];

export const button = 'inline-flex min-h-12 min-w-12 items-center justify-center gap-2 rounded-lg border border-border px-4 text-base font-medium disabled:opacity-60';
const primary = 'inline-flex min-h-12 items-center justify-center rounded-lg bg-primary px-4 text-base font-medium text-primary-foreground disabled:opacity-60';
const field = 'min-h-12 text-base';

/** One live collection or document under the pet, through the tablet's listener (null: loading; 'failed': unreadable). */
function usePetLive<T>(householdId: string, path: string[], build: 'collection' | 'doc', read: (snapshot: QuerySnapshot | DocumentSnapshot) => T, order?: { field: string; max: number }) {
  const key = path.join('/');
  const [state, setState] = useState<{ key: string; value: T | null; failed: boolean } | null>(null);
  useEffect(() => {
    let stop: (() => void) | null = null;
    let stopped = false;
    void Promise.all([import('@/lib/firebase'), import('firebase/firestore')]).then(([{ db }, fs]) => {
      if (stopped) return;
      const segments = ['households', householdId, ...path] as [string, ...string[]];
      const { onSnapshot } = fs;
      const docRef = build === 'doc' ? fs.doc(db, ...segments) : null;
      const listRef = build === 'doc' ? null : fs.collection(db, ...segments);
      const queryRef = listRef && order ? fs.query(listRef, fs.orderBy(order.field, 'desc'), fs.limit(order.max)) : listRef;
      const subscribe: Parameters<typeof tabletListener<QuerySnapshot | DocumentSnapshot>>[0] = docRef
        ? (next, error) => onSnapshot(docRef, { includeMetadataChanges: true }, next, error)
        : (next, error) => onSnapshot(queryRef!, { includeMetadataChanges: true }, next, error);
      stop = tabletListener<QuerySnapshot | DocumentSnapshot>(subscribe, {
        confirmed: (snapshot) => !snapshot.metadata.fromCache,
        next: (snapshot) => setState({ key, value: read(snapshot), failed: false }),
        onDenied: () => setState((previous) => ({ key, value: previous?.key === key ? previous.value : null, failed: true })),
      }).stop;
    });
    return () => {
      stopped = true;
      stop?.();
    };
    // `read`, `build` and `order` are fixed per call site; the key identifies the query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [householdId, key]);
  return state && state.key === key ? state : null;
}

const docsOf = (snapshot: QuerySnapshot | DocumentSnapshot) => ('docs' in snapshot ? snapshot.docs.map((entry) => ({ id: entry.id, data: entry.data({ serverTimestamps: 'estimate' }) as Record<string, unknown> })) : []);
const toDate = (value: unknown): Date | null => {
  if (value && typeof value === 'object' && typeof (value as { toDate?: unknown }).toDate === 'function') return (value as { toDate: () => Date }).toDate();
  if (typeof value === 'string') {
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  return null;
};
const when = (value: unknown, timeZone: string) => {
  const at = toDate(value);
  return at ? at.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone }) : 'Unknown time';
};

/** The pet's details sheet on the tablet. `doseCourseId`: a reminder's link opens Give dose for that course once it has loaded. */
export function TabletPetSheet({ petId, petName, initialTab = 'medication', doseCourseId, onClose }: {
  petId: string;
  petName: string;
  initialTab?: Tab;
  doseCourseId?: string | null;
  onClose: () => void;
}) {
  const { householdId, household } = useTablet();
  const timeZone = household?.timeZone ?? 'America/Chicago';
  const [tab, setTab] = useState<Tab>(initialTab);
  const courses = usePetLive(householdId, ['pets', petId, 'medication-courses'], 'collection', (snapshot) => docsOf(snapshot).map((entry) => readCourse(entry.id, entry.data)).filter((course): course is CourseView => Boolean(course)));
  const [giving, setGiving] = useState<CourseView | null>(null);
  const [linkHandled, setLinkHandled] = useState(false);
  // A reminder's link: Give dose opens once the courses have loaded (an inactive course just shows the list).
  if (!linkHandled && doseCourseId && courses?.value) {
    setLinkHandled(true);
    const course = courses.value.find((entry) => entry.id === doseCourseId && entry.status === 'active');
    if (course) setGiving(course);
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[calc(var(--dialog-max-h)_-_var(--keyboard-inset,0px))] max-w-3xl flex-col gap-3 overflow-hidden" data-testid="tablet-pet-sheet">
        <DialogHeader>
          <DialogTitle className="font-headline text-2xl">{petName}</DialogTitle>
          <DialogDescription>Saved for the person you choose next. Some changes ask for their PIN.</DialogDescription>
        </DialogHeader>
        <div role="tablist" aria-label={`${petName} details`} className="flex flex-wrap gap-2">
          {TABS.map((entry) => (
            <button key={entry.key} type="button" role="tab" aria-selected={tab === entry.key} className={cn(button, tab === entry.key && 'border-primary bg-primary/10 text-primary')} onClick={() => setTab(entry.key)} data-testid={`tablet-pet-tab-${entry.key}`}>
              {entry.label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1" role="tabpanel">
          {tab === 'medication' && <MedicationPanel petId={petId} courses={courses} timeZone={timeZone} onGive={setGiving} />}
          {tab === 'notes' && <NotesPanel petId={petId} petName={petName} timeZone={timeZone} />}
          {tab === 'weight' && <WeightPanel petId={petId} petName={petName} timeZone={timeZone} />}
          {tab === 'history' && <HistoryPanel petId={petId} petName={petName} timeZone={timeZone} />}
          {tab === 'profile' && <ProfilePanel petId={petId} petName={petName} onDeleted={onClose} />}
        </div>
        <GiveDoseDialog petId={petId} petName={petName} course={giving} onOpenChange={(open) => { if (!open) setGiving(null); }} />
      </DialogContent>
    </Dialog>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-2 text-base text-muted-foreground">{children}</p>;
}

/* --- Medication --------------------------------------------------------------------- */

function MedicationPanel({ petId, courses, timeZone, onGive }: {
  petId: string;
  courses: { value: CourseView[] | null; failed: boolean } | null;
  timeZone: string;
  onGive: (course: CourseView) => void;
}) {
  const { runAction } = useTablet();
  const [editing, setEditing] = useState<{ course: CourseView | null } | null>(null);
  const list = courses?.value ?? null;
  const dues = useMemo(() => (list ? medicationDues(list.filter((course) => course.status === 'active'), [], new Date(), timeZone) : []), [list, timeZone]);
  if (!list) return <Empty>{courses?.failed ? "Medication couldn't be loaded right now. It tries again on its own." : 'Loading…'}</Empty>;
  const active = list.filter((course) => course.status === 'active');
  const finished = list.filter((course) => course.status !== 'active');
  const set = (course: CourseView, finish: boolean) => runAction({
    capability: finish ? 'pets.course.finish' : 'pets.course.resume',
    label: finish ? `Finished ${course.name}` : `${course.name} is active again`,
    intent: { petId, courseId: course.id },
  });
  if (editing) return <CourseForm petId={petId} course={editing.course} activeNames={active.filter((course) => course.id !== editing.course?.id).map((course) => course.name.trim().toLowerCase())} onDone={() => setEditing(null)} />;
  return (
    <div className="space-y-3">
      <MedicationChips dues={dues} max={4} onSelect={(due) => { const course = active.find((entry) => entry.id === due.courseId); if (course) onGive(course); }} />
      {active.length === 0 && <Empty>No active medication courses.</Empty>}
      <ul className="space-y-2">
        {active.map((course) => (
          <li key={course.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3" data-testid={`tablet-course-${course.id}`}>
            <span className="min-w-0"><span className="block text-lg font-medium">{course.name}</span><span className="block text-sm text-muted-foreground">{course.dosage}</span></span>
            <span className="flex flex-wrap gap-2">
              <button type="button" className={cn(button, 'border-primary/40 text-primary')} onClick={() => onGive(course)} data-testid={`tablet-give-${course.id}`}>Give dose</button>
              <button type="button" className={button} onClick={() => setEditing({ course })}>Edit</button>
              <button type="button" className={button} onClick={() => void set(course, true)}>Finish</button>
            </span>
          </li>
        ))}
      </ul>
      <button type="button" className={button} onClick={() => setEditing({ course: null })} data-testid="tablet-course-add">Add a course</button>
      {finished.length > 0 && (
        <ul className="space-y-2" aria-label="Finished courses">
          {finished.map((course) => (
            <li key={course.id} className="flex items-center justify-between gap-2 rounded-xl border border-dashed border-border p-3">
              <span className="text-base text-muted-foreground">{course.name} · finished</span>
              {course.schedule && <button type="button" className={button} onClick={() => void set(course, false)}>Resume</button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CourseForm({ petId, course, activeNames, onDone }: { petId: string; course: CourseView | null; activeNames: string[]; onDone: () => void }) {
  const { runAction, household } = useTablet();
  const [courseId] = useState(() => course?.id ?? newCourseId());
  const [values, setValues] = useState<CourseFormValues>(() => courseFormValues(course ?? {}, householdToday(household?.timeZone)));
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  useUnsavedInput(true);
  const { errors } = validateCourseForm(values, activeNames);
  const change = (patch: Partial<CourseFormValues>) => setValues((previous) => ({ ...previous, ...patch }));
  const save = async () => {
    setSubmitted(true);
    if (Object.keys(errors).length > 0 || saving) return;
    setSaving(true);
    try {
      const outcome = await runAction({ capability: 'pets.course.edit', label: course ? `Saved ${values.name.trim()}` : `Added ${values.name.trim()}`, intent: { petId, courseId, create: !course, values } });
      const status = (outcome.data as { status?: string } | undefined)?.status;
      if (outcome.ok && (status === 'saved' || status === 'already')) onDone();
    } finally {
      setSaving(false);
    }
  };
  const err = (key: keyof typeof errors) => (submitted && errors[key] ? <span className="text-sm text-destructive">{errors[key]}</span> : null);
  return (
    <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }} data-testid="tablet-course-form">
      <label className="grid gap-1 text-base">Medication<Input className={field} value={values.name} onChange={(event) => change({ name: event.target.value })} maxLength={80} />{err('name')}</label>
      <label className="grid gap-1 text-base">Dosage from the plan<Input className={field} value={values.dosage} onChange={(event) => change({ dosage: event.target.value })} maxLength={80} />{err('dosage')}</label>
      <div className="flex gap-2" role="radiogroup" aria-label="Schedule">
        {(['days', 'hours'] as const).map((kind) => (
          <button key={kind} type="button" role="radio" aria-checked={values.kind === kind} className={cn(button, values.kind === kind && 'border-primary text-primary')} onClick={() => change({ kind })}>{kind === 'days' ? 'Times of day' : 'Every few hours'}</button>
        ))}
      </div>
      {values.kind === 'days' ? (
        <>
          <label className="grid gap-1 text-base">Every how many days<Input className={field} inputMode="numeric" value={values.everyDays} onChange={(event) => change({ everyDays: event.target.value })} />{err('everyDays')}</label>
          <label className="grid gap-1 text-base">Times (comma separated, 24 h)<Input className={field} value={values.times.join(', ')} onChange={(event) => change({ times: event.target.value.split(',').map((time) => time.trim()) })} placeholder="08:00, 20:00" />{err('times')}</label>
        </>
      ) : (
        <>
          <label className="grid gap-1 text-base">Every how many hours<Input className={field} inputMode="numeric" value={values.everyHours} onChange={(event) => change({ everyHours: event.target.value })} />{err('everyHours')}</label>
          <label className="grid gap-1 text-base">First dose at<Input className={field} type="time" value={values.firstTime} onChange={(event) => change({ firstTime: event.target.value })} />{err('firstTime')}</label>
        </>
      )}
      <label className="grid gap-1 text-base">First day<Input className={field} type="date" value={values.startDay} onChange={(event) => change({ startDay: event.target.value })} />{err('startDay')}</label>
      <label className="grid gap-1 text-base">Last day (optional)<Input className={field} type="date" value={values.endDay} onChange={(event) => change({ endDay: event.target.value })} />{err('endDay')}</label>
      <div className="flex justify-end gap-2">
        <button type="button" className={button} onClick={onDone}>Cancel</button>
        <button type="submit" className={primary} disabled={saving} data-testid="tablet-course-save">Save</button>
      </div>
    </form>
  );
}

/* --- Notes -------------------------------------------------------------------------- */

function NotesPanel({ petId, petName, timeZone }: { petId: string; petName: string; timeZone: string }) {
  const { householdId, runAction } = useTablet();
  const live = usePetLive(householdId, ['pets', petId, 'notes'], 'collection', (snapshot) => docsOf(snapshot).map((entry) => readNote(entry.id, entry.data)), { field: 'date', max: 40 });
  const [text, setText] = useState('');
  const [tag, setTag] = useState<NoteTag | ''>('');
  const [editing, setEditing] = useState<{ note: PetNote; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  useUnsavedInput(text.trim().length > 0 || Boolean(editing));
  const notes = live?.value ?? null;
  const add = async () => {
    if (!text.trim() || text.trim().length > 500 || saving) return;
    setSaving(true);
    try {
      const outcome = await runAction({ capability: 'pets.note.add', label: `Note for ${petName}`, subject: petName, intent: { petId, text: text.trim(), ...(tag ? { tag } : {}) } });
      if (outcome.ok) { setText(''); setTag(''); }
    } finally {
      setSaving(false);
    }
  };
  const pin = (note: PetNote) => runAction({ capability: note.pinned ? 'pets.note.unpin' : 'pets.note.pin', label: note.pinned ? 'Note unpinned' : 'Note pinned', intent: { petId, noteId: note.id } });
  const remove = (note: PetNote) => runAction({ capability: 'pets.note.delete', label: 'Note removed', intent: { petId, noteId: note.id } });
  const saveEdit = async () => {
    if (!editing || !editing.text.trim()) return;
    const outcome = await runAction({ capability: 'pets.note.editPinned', label: 'Note saved', intent: { petId, noteId: editing.note.id, expected: { text: editing.note.text, tag: editing.note.tag }, text: editing.text.trim(), tag: editing.note.tag } });
    if (outcome.ok) setEditing(null);
  };
  const row = (note: PetNote) => (
    <li key={note.id} className="space-y-2 rounded-xl border border-border p-3" data-testid={`tablet-note-${note.id}`}>
      {editing?.note.id === note.id ? (
        <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); void saveEdit(); }}>
          <Textarea className="min-h-20 text-base" value={editing.text} maxLength={500} aria-label="Note" onChange={(event) => setEditing({ ...editing, text: event.target.value })} />
          <span className="flex justify-end gap-2"><button type="button" className={button} onClick={() => setEditing(null)}>Cancel</button><button type="submit" className={primary}>Save</button></span>
        </form>
      ) : (
        <>
          <p className="text-base">{note.text}</p>
          <p className="text-sm text-muted-foreground">{[note.tag ? NOTE_TAG_LABELS[note.tag] : null, when(note.date, timeZone), note.loggedByName ? `by ${note.loggedByName}` : null].filter(Boolean).join(' · ')}</p>
          <span className="flex flex-wrap gap-2">
            <button type="button" className={button} onClick={() => void pin(note)}>{note.pinned ? 'Unpin' : 'Pin'}</button>
            <button type="button" className={button} onClick={() => setEditing({ note, text: note.text })}>Edit</button>
            <button type="button" className={button} onClick={() => void remove(note)}>Delete</button>
          </span>
        </>
      )}
    </li>
  );
  return (
    <div className="space-y-3">
      <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); void add(); }}>
        <Textarea className="min-h-20 text-base" value={text} onChange={(event) => setText(event.target.value)} maxLength={500} placeholder="What happened?" aria-label="New note" data-testid="tablet-note-text" />
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Tag">
          {NOTE_TAGS.map((entry) => (
            <button key={entry} type="button" role="radio" aria-checked={tag === entry} className={cn(button, tag === entry && 'border-primary text-primary')} onClick={() => setTag(tag === entry ? '' : entry)}>{NOTE_TAG_LABELS[entry]}</button>
          ))}
          <button type="submit" className={primary} disabled={!text.trim() || saving} data-testid="tablet-note-save">Add note</button>
        </div>
      </form>
      {!notes ? <Empty>{live?.failed ? "Notes couldn't be loaded right now." : 'Loading…'}</Empty> : (
        <>
          {pinnedNotes(notes).length > 0 && <ul className="space-y-2" aria-label="Pinned notes">{pinnedNotes(notes).map(row)}</ul>}
          {behaviourEntries(notes).length === 0 ? <Empty>No notes yet.</Empty> : <ul className="space-y-2" aria-label="Notes">{behaviourEntries(notes).map(row)}</ul>}
        </>
      )}
    </div>
  );
}

/* --- Weight ------------------------------------------------------------------------- */

function WeightPanel({ petId, petName, timeZone }: { petId: string; petName: string; timeZone: string }) {
  const { householdId, runAction } = useTablet();
  const live = usePetLive(householdId, ['pets', petId, 'weights'], 'collection', (snapshot) => docsOf(snapshot).map((entry) => readWeight(entry.id, entry.data)), { field: 'date', max: 20 });
  const profile = usePetLive(householdId, ['pets', petId], 'doc', (snapshot) => ('data' in snapshot && typeof snapshot.data === 'function' ? (snapshot as DocumentSnapshot).data() ?? null : null));
  const unit: WeightUnit = petWeightUnit(profile?.value);
  const [value, setValue] = useState('');
  const [chosen, setChosen] = useState<WeightUnit | null>(null);
  useUnsavedInput(value.trim().length > 0);
  const entries = live?.value ? weightHistory(live.value) : null;
  const add = async () => {
    const number = Number(value);
    if (!value.trim() || !Number.isFinite(number) || number <= 0) return;
    const outcome = await runAction({ capability: 'pets.weight.add', label: `Weight for ${petName}`, subject: petName, intent: { petId, value: number, unit: chosen ?? unit } });
    if (outcome.ok) setValue('');
  };
  return (
    <div className="space-y-3">
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void add(); }}>
        <label className="grid gap-1 text-base">Weight<Input className={cn(field, 'w-32')} inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} data-testid="tablet-weight-value" /></label>
        {WEIGHT_UNITS.map((entry) => (
          <button key={entry} type="button" aria-pressed={(chosen ?? unit) === entry} className={cn(button, (chosen ?? unit) === entry && 'border-primary text-primary')} onClick={() => setChosen(entry)}>{entry}</button>
        ))}
        <button type="submit" className={primary} disabled={!value.trim()} data-testid="tablet-weight-save">Log weight</button>
      </form>
      {!entries ? <Empty>{live?.failed ? "Weights couldn't be loaded right now." : 'Loading…'}</Empty> : entries.length === 0 ? <Empty>No weighings yet.</Empty> : (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-center justify-between gap-2 rounded-xl border border-border p-3">
              <span className="text-base">{formatWeight(entry.value, entry.unit)} <span className="text-sm text-muted-foreground">· {when(entry.date, timeZone)}{entry.loggedByName ? ` · by ${entry.loggedByName}` : ''}</span></span>
              <button type="button" className={button} onClick={() => void runAction({ capability: 'pets.log.delete', label: 'Weighing removed', intent: { petId, kind: 'weights', logId: entry.id } })}>Delete</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* --- History (older entries, PIN level) ---------------------------------------------- */

const LOG_KINDS = [
  { kind: 'feeding-logs', label: 'Feedings' },
  { kind: 'medication-logs', label: 'Doses' },
  { kind: 'care-logs', label: 'Care' },
] as const;

function HistoryPanel({ petId, petName, timeZone }: { petId: string; petName: string; timeZone: string }) {
  const { householdId, runAction } = useTablet();
  const feedings = usePetLive(householdId, ['pets', petId, 'feeding-logs'], 'collection', docsOf, { field: 'date', max: 12 });
  const medication = usePetLive(householdId, ['pets', petId, 'medication-logs'], 'collection', docsOf, { field: 'date', max: 12 });
  const care = usePetLive(householdId, ['pets', petId, 'care-logs'], 'collection', docsOf, { field: 'date', max: 12 });
  const [fixing, setFixing] = useState<{ logId: string; value: string } | null>(null);
  useUnsavedInput(Boolean(fixing));
  const sources = { 'feeding-logs': feedings, 'medication-logs': medication, 'care-logs': care };
  const fix = async () => {
    if (!fixing) return;
    const at = new Date(fixing.value);
    if (Number.isNaN(at.getTime())) return;
    const outcome = await runAction({ capability: 'pets.log.correctTime', label: `${petName}'s feeding time corrected`, intent: { petId, logId: fixing.logId, date: at.toISOString() } });
    if (outcome.ok) setFixing(null);
  };
  return (
    <div className="space-y-4">
      {LOG_KINDS.map(({ kind, label }) => {
        const source = sources[kind];
        const entries = source?.value ?? null;
        return (
          <section key={kind} aria-label={label} className="space-y-2">
            <h3 className="text-lg font-medium">{label}</h3>
            {!entries ? <Empty>{source?.failed ? "This history couldn't be loaded right now." : 'Loading…'}</Empty> : entries.length === 0 ? <Empty>Nothing yet.</Empty> : (
              <ul className="space-y-2">
                {entries.map((entry) => (
                  <li key={entry.id} className="space-y-2 rounded-xl border border-border p-3" data-testid={`tablet-log-${entry.id}`}>
                    <p className="text-base">
                      {kind === 'care-logs' ? String(entry.data.activity ?? 'Care') : kind === 'medication-logs' ? String(entry.data.medication ?? 'Dose') : 'Fed'}
                      <span className="text-sm text-muted-foreground"> · {when(entry.data.date, timeZone)}{typeof entry.data.loggedByName === 'string' ? ` · by ${entry.data.loggedByName}` : ''}</span>
                    </p>
                    {fixing?.logId === entry.id ? (
                      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void fix(); }}>
                        <label className="grid gap-1 text-base">Fed at<Input className={field} type="datetime-local" value={fixing.value} onChange={(event) => setFixing({ ...fixing, value: event.target.value })} /></label>
                        <button type="button" className={button} onClick={() => setFixing(null)}>Cancel</button>
                        <button type="submit" className={primary}>Save time</button>
                      </form>
                    ) : (
                      <span className="flex flex-wrap gap-2">
                        {kind === 'feeding-logs' && <button type="button" className={button} onClick={() => setFixing({ logId: entry.id, value: '' })}>Fix time</button>}
                        <button type="button" className={button} onClick={() => void runAction({ capability: 'pets.log.delete', label: `${label === 'Feedings' ? 'Feeding' : label === 'Doses' ? 'Dose record' : 'Care entry'} removed`, intent: { petId, kind, logId: entry.id } })}>Delete</button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

/* --- Profile (PIN level) ------------------------------------------------------------- */

function ProfilePanel({ petId, petName, onDeleted }: { petId: string; petName: string; onDeleted: () => void }) {
  const { householdId, runAction } = useTablet();
  const live = usePetLive(householdId, ['pets', petId], 'doc', (snapshot) => ((snapshot as DocumentSnapshot).data?.() ?? null) as Record<string, unknown> | null);
  const stored = live?.value ?? null;
  const [form, setForm] = useState<{ name: string; vetName: string; vetClinic: string; vetPhone: string; weightUnit: WeightUnit } | null>(null);
  const [rows, setRows] = useState<MealSlotDraft[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useUnsavedInput(Boolean(form) || Boolean(rows));
  if (!stored) return <Empty>{live?.failed ? "This pet couldn't be loaded right now." : 'Loading…'}</Empty>;
  const text = (key: string) => (typeof stored[key] === 'string' ? (stored[key] as string) : '');
  const current = form ?? { name: text('name') || petName, vetName: text('vetName'), vetClinic: text('vetClinic'), vetPhone: text('vetPhone'), weightUnit: petWeightUnit(stored) };
  const saveProfile = async () => {
    const changed: Record<string, unknown> = {};
    if (current.name.trim() !== text('name')) changed.name = current.name.trim();
    for (const key of ['vetName', 'vetClinic', 'vetPhone'] as const) if (current[key].trim() !== text(key)) changed[key] = current[key].trim() || null;
    if (current.weightUnit !== petWeightUnit(stored)) changed.weightUnit = current.weightUnit;
    if (Object.keys(changed).length === 0) { setForm(null); return; }
    const outcome = await runAction({ capability: 'pets.profile.edit', label: `${current.name.trim() || petName} saved`, intent: { petId, ...changed } });
    if (outcome.ok && (outcome.data as { status?: string } | undefined)?.status === 'saved') setForm(null);
  };
  const plan = rows ?? draftFromPlan(readMealPlan(stored as never));
  const planErrors = validateMealDraft(plan);
  const savePlan = async () => {
    if (plan.length === 0 || planErrors.plan || planErrors.rows.some((errors) => Object.keys(errors).length > 0)) return;
    const outcome = await runAction({ capability: 'pets.slots.edit', label: `${petName}'s meal times saved`, intent: { petId, rows: plan } });
    if (outcome.ok) setRows(null);
  };
  const editRow = (index: number, patch: Partial<MealSlotDraft>) => setRows(plan.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  const remove = async () => {
    const outcome = await runAction({ capability: 'pets.pet.delete', label: `${petName} deleted`, intent: { petId } });
    if (outcome.ok) onDeleted();
  };
  return (
    <div className="space-y-5">
      <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); void saveProfile(); }} data-testid="tablet-profile-form">
        <label className="grid gap-1 text-base">Name<Input className={field} value={current.name} maxLength={40} onChange={(event) => setForm({ ...current, name: event.target.value })} /></label>
        <label className="grid gap-1 text-base">Vet<Input className={field} value={current.vetName} maxLength={80} onChange={(event) => setForm({ ...current, vetName: event.target.value })} /></label>
        <label className="grid gap-1 text-base">Clinic<Input className={field} value={current.vetClinic} maxLength={80} onChange={(event) => setForm({ ...current, vetClinic: event.target.value })} /></label>
        <label className="grid gap-1 text-base">Vet phone<Input className={field} type="tel" value={current.vetPhone} maxLength={30} onChange={(event) => setForm({ ...current, vetPhone: event.target.value })} /></label>
        <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Weight unit">
          {WEIGHT_UNITS.map((entry) => <button key={entry} type="button" role="radio" aria-checked={current.weightUnit === entry} className={cn(button, current.weightUnit === entry && 'border-primary text-primary')} onClick={() => setForm({ ...current, weightUnit: entry })}>{entry}</button>)}
          <button type="submit" className={primary} disabled={!form}>Save profile</button>
        </div>
        <p className="text-sm text-muted-foreground">Photos are changed from a phone.</p>
      </form>
      <section className="space-y-2" aria-label="Meal times">
        <h3 className="text-lg font-medium">Meal times</h3>
        {plan.map((row, index) => (
          <div key={row.id} className="flex flex-wrap items-end gap-2">
            <Input className={cn(field, 'w-40')} aria-label="Meal name" value={row.name} maxLength={30} onChange={(event) => editRow(index, { name: event.target.value })} />
            <Input className={cn(field, 'w-32')} aria-label="Time" type="time" value={row.time} onChange={(event) => editRow(index, { time: event.target.value })} />
            <Input className={cn(field, 'w-24')} aria-label="Amount" inputMode="decimal" value={row.amount} onChange={(event) => editRow(index, { amount: event.target.value })} />
            <select className="min-h-12 rounded-md border border-input bg-background px-3 text-base" aria-label="Unit" value={row.unit} onChange={(event) => editRow(index, { unit: event.target.value as MealSlotDraft['unit'] })}>
              {PORTION_UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
            </select>
            <button type="button" className={button} onClick={() => setRows(plan.filter((_, at) => at !== index))}>Remove</button>
          </div>
        ))}
        <span className="flex flex-wrap gap-2">
          <button type="button" className={button} onClick={() => setRows([...plan, { id: newMealSlotId(), name: '', time: '', amount: '1', unit: plan[0]?.unit ?? 'Cups', offDays: [] }])}>Add a meal</button>
          <button type="button" className={primary} disabled={!rows || plan.length === 0} onClick={() => void savePlan()}>Save meal times</button>
        </span>
      </section>
      <section className="space-y-2" aria-label="Delete pet">
        {confirmDelete ? (
          <div className="space-y-2 rounded-xl border border-destructive/50 p-3">
            <p className="text-base">Delete {petName} and everything recorded for them? This cannot be undone.</p>
            <span className="flex gap-2"><button type="button" className={button} onClick={() => setConfirmDelete(false)}>Keep</button><button type="button" className={cn(button, 'border-destructive text-destructive')} onClick={() => void remove()} data-testid="tablet-pet-delete-confirm">Delete {petName}</button></span>
          </div>
        ) : (
          <button type="button" className={cn(button, 'text-destructive')} onClick={() => setConfirmDelete(true)}>Delete pet</button>
        )}
      </section>
    </div>
  );
}

/** A pet's active courses on the tablet board (live), for its medication chips. */
export function TabletMedicationChips({ petId, onGive }: { petId: string; onGive: (courseId: string) => void }) {
  const { householdId, household } = useTablet();
  const courses = usePetLive(householdId, ['pets', petId, 'medication-courses'], 'collection', (snapshot) => docsOf(snapshot).map((entry) => readCourse(entry.id, entry.data)).filter((course): course is CourseView => Boolean(course) && course!.status === 'active'));
  const dues = courses?.value ? medicationDues(courses.value, [], new Date(), household?.timeZone) : [];
  if (dues.length === 0) return null;
  return <MedicationChips dues={dues} max={2} onSelect={(due) => { if (due.courseId) onGive(due.courseId); }} />;
}
