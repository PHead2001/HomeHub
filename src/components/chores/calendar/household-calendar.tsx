'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { LayoutGroup, motion } from 'motion/react';
import { format } from 'date-fns';
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, ListChecks, Pill, Wrench } from 'lucide-react';
import { collection, doc, getDoc, getDocs, updateDoc } from 'firebase/firestore';
import type { HomeAsset, HouseholdMember, MedicationLog, Pet, User as HomeHubUser, Vehicle } from '@/lib/types';
import { buildMaintenanceReminders } from '@functions/shared/maintenance-reminders';
import { localDay, safeTimeZone, toDay } from '@functions/shared/calendar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { ToastAction } from '@/components/ui/toast';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { EmptyState } from '@/components/empty-state';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { MemberAvatar } from '@/components/member-avatar';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { syncHouseholdUpkeep } from '@/app/chores/actions';
import { auth, db } from '@/lib/firebase';
import { playFeedback } from '@/lib/feedback';
import { memberColorMap, type MemberColor } from '@/lib/member-colors';
import { SPRING_SNAPPY } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { addDaysToKey, dayFromKey, dayKey, isDayKey, type ChoreRecord } from '@/lib/chores/dates';
import {
  choreEvents, groupByDay, isSameMonth, maintenanceEvents, medicationEvents, monthGrid, overdueRail, rescheduleFields, shiftMonth, weekDays,
  type CalendarEvent, type CalendarMember, type MaintenanceDue, type MedicationEntry,
} from '@/lib/chores/calendar';

type View = 'week' | 'month';
type Member = CalendarMember & { avatarUrl?: string | null };
type SourceErrors = Partial<Record<'chores' | 'maintenance' | 'pets', string>>;

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const UNDO_MS = 5000;

async function loadMembers(householdId: string): Promise<Member[]> {
  const snap = await getDocs(collection(db, 'households', householdId, 'members'));
  const approved = snap.docs
    .map(d => d.data() as HouseholdMember)
    .filter(m => m.email && m.role !== 'newuser' && (m.status || 'active') === 'active');
  const profiles = await Promise.allSettled(approved.map(m => getDoc(doc(db, 'users', m.email))));
  return approved.map((member, i) => {
    const result = profiles[i];
    const profile = result.status === 'fulfilled' && result.value.exists() ? result.value.data() as HomeHubUser : null;
    return {
      uid: member.uid,
      email: member.email,
      name: profile?.displayName || member.displayName || member.email,
      avatarUrl: profile?.avatarUrl || member.avatarUrl || null,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Event chip                                                                  */
/* -------------------------------------------------------------------------- */

const KIND_ICON = { chore: ListChecks, maintenance: Wrench, medication: Pill } as const;
const KIND_LABEL = { chore: 'Chore', maintenance: 'Maintenance due', medication: 'Medication given' } as const;

function chipClasses(event: CalendarEvent, color?: MemberColor) {
  if (event.completed && event.kind === 'chore') return 'bg-muted text-muted-foreground line-through border-l-border';
  if (event.kind === 'maintenance') return cn('bg-info/10 text-info', event.overdue ? 'border-l-destructive' : 'border-l-info');
  if (event.kind === 'medication') return 'bg-success/10 text-success border-l-success';
  return cn(color?.classes.softChip ?? 'bg-primary/10 text-primary', event.overdue ? 'border-l-destructive' : (color?.classes.border ?? 'border-l-primary'));
}

function EventChip({
  event,
  color,
  canMove,
  onMove,
  onDragStart,
  animateMove = false,
}: {
  event: CalendarEvent;
  color?: MemberColor;
  canMove: boolean;
  /** Spring the chip into its new day when moved (one copy per event only). */
  animateMove?: boolean;
  onMove: (event: CalendarEvent, day: string) => void;
  onDragStart: (event: CalendarEvent) => void;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(event.day);
  const [error, setError] = useState('');
  const Icon = KIND_ICON[event.kind];
  const movable = canMove && event.kind === 'chore' && !event.completed && Boolean(event.choreId);
  const fieldId = `move-${event.id.replace(/[^a-zA-Z0-9-]/g, '-')}`;

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!isDayKey(target)) {
      setError('Pick a date.');
      return;
    }
    if (target === event.day) {
      setError('That is already its date.');
      return;
    }
    setOpen(false);
    onMove(event, target);
  };

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) { setTarget(event.day); setError(''); } }}>
      <motion.div layout={animateMove ? 'position' : false} layoutId={animateMove ? event.id : undefined} transition={SPRING_SNAPPY}>
        <PopoverTrigger asChild>
          <button
            type="button"
            draggable={movable}
            onDragStart={movable ? (e) => {
              e.dataTransfer.setData('text/plain', event.id);
              e.dataTransfer.effectAllowed = 'move';
              onDragStart(event);
            } : undefined}
            className={cn(
              'flex w-full min-w-0 items-center gap-1 rounded-md border-l-[3px] px-1.5 py-1 text-left text-xs font-medium',
              chipClasses(event, color),
              movable && 'cursor-grab active:cursor-grabbing',
            )}
            aria-label={`${KIND_LABEL[event.kind]}: ${event.title}, ${event.subtitle}${event.overdue ? ', overdue' : ''}${event.completed && event.kind === 'chore' ? ', done' : ''}`}
          >
            <Icon aria-hidden className="h-3 w-3 shrink-0" />
            <span className="truncate">{event.title}</span>
          </button>
        </PopoverTrigger>
      </motion.div>
      <PopoverContent className="w-72" align="start">
        <div className="space-y-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{KIND_LABEL[event.kind]}</p>
            <p className="font-semibold text-foreground">{event.title}</p>
            <p className="text-sm text-muted-foreground">{event.subtitle} · {format(dayFromKey(event.day), 'EEE, MMM d')}</p>
            {event.overdue && <p className="mt-1 text-sm font-medium text-destructive">Overdue</p>}
          </div>
          {movable && (
            <form onSubmit={submit} className="space-y-2" noValidate>
              <Label htmlFor={fieldId}>Move to date</Label>
              <div className="flex gap-2">
                <Input type="date" {...fieldErrorProps(fieldId, error)} value={target} onChange={(e) => { setTarget(e.target.value); setError(''); }} />
                <Button type="submit" size="sm" className="h-10">Move</Button>
              </div>
              <FieldError id={fieldId}>{error}</FieldError>
            </form>
          )}
          <Button variant="link" className="h-auto p-0" asChild>
            <Link href={event.href}>{event.kind === 'chore' ? 'Open Chores' : event.kind === 'maintenance' ? 'Open Maintenance' : 'Open pet'}</Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* -------------------------------------------------------------------------- */
/* Calendar                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Full-page household calendar (H19): Week and Month views of chores, maintenance
 * due dates and logged pet medication. Chores are colored by member, today glows
 * and overdue items stack in a red rail. Members who may edit chores can drag a
 * chore to another day or use "Move to date" from its details (keyboard friendly);
 * every move can be undone for 5 s. Maintenance and pet data are read-only here.
 */
export function HouseholdCalendar() {
  const { currentUser, household, permissions } = useAuth();
  const { toast, toastError } = useToast();
  const householdId = currentUser?.householdId;
  const canViewChores = Boolean(permissions['chores.view']);
  const canViewMaintenance = Boolean(permissions['maintenance.view']);
  const canViewPets = Boolean(permissions['pets.view']);
  const canMove = Boolean(permissions['chores.edit']);
  const timeZone = safeTimeZone(household?.timeZone);

  const [loading, setLoading] = useState(true);
  const [members, setMembers] = useState<Member[]>([]);
  const [chores, setChores] = useState<ChoreRecord[]>([]);
  const [maintenance, setMaintenance] = useState<MaintenanceDue[]>([]);
  const [medication, setMedication] = useState<MedicationEntry[]>([]);
  const [sourceErrors, setSourceErrors] = useState<SourceErrors>({});
  const [view, setView] = useState<View>('week');
  const [today] = useState(() => dayKey(new Date()));
  const [anchor, setAnchor] = useState(today);
  const [selectedDay, setSelectedDay] = useState(today);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragging = useRef<CalendarEvent | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!householdId) return;
    let active = true;
    (async () => {
      const errors: SourceErrors = {};
      const memberList = await loadMembers(householdId).catch(() => [] as Member[]);
      const tasks: Promise<void>[] = [];
      if (canViewChores) {
        tasks.push((async () => {
          const firebaseUser = auth.currentUser;
          if (firebaseUser) {
            await syncHouseholdUpkeep({ idToken: await firebaseUser.getIdToken(), householdId }).catch(() => undefined);
          }
          const snap = await getDocs(collection(db, 'households', householdId, 'chores'));
          if (active) setChores(snap.docs.map(d => ({ id: d.id, ...d.data() } as ChoreRecord)));
        })().catch(() => { errors.chores = 'Chores could not be loaded.'; }));
      }
      if (canViewMaintenance) {
        tasks.push((async () => {
          const [assets, vehicles] = await Promise.all([
            getDocs(collection(db, 'households', householdId, 'home-assets')),
            getDocs(collection(db, 'households', householdId, 'vehicles')),
          ]);
          const reminders = buildMaintenanceReminders(
            assets.docs.map(d => ({ ...(d.data() as HomeAsset), id: d.id })),
            vehicles.docs.map(d => ({ ...(d.data() as Vehicle), id: d.id })),
            localDay(new Date(), timeZone),
            timeZone,
          );
          if (active) {
            setMaintenance(reminders.map(r => ({
              id: r.id, title: r.title, relatedName: r.relatedName, day: toDay(r.dueDate, timeZone), status: r.status, deepLink: r.deepLink,
            })));
          }
        })().catch(() => { errors.maintenance = 'Maintenance dates could not be loaded.'; }));
      }
      if (canViewPets) {
        tasks.push((async () => {
          const pets = await getDocs(collection(db, 'households', householdId, 'pets'));
          const logs = await Promise.all(pets.docs.map(async petDoc => {
            const pet = petDoc.data() as Pet;
            const meds = await getDocs(collection(db, 'households', householdId, 'pets', petDoc.id, 'medication-logs'));
            return meds.docs.map(m => {
              const log = m.data() as MedicationLog;
              return { id: m.id, petId: petDoc.id, petName: pet.name || 'Pet', medication: log.medication || 'Medication', dosage: log.dosage, date: log.date };
            });
          }));
          if (active) setMedication(logs.flat());
        })().catch(() => { errors.pets = 'Pet medication could not be loaded.'; }));
      }
      await Promise.all(tasks);
      if (!active) return;
      setMembers(memberList);
      setSourceErrors(errors);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [householdId, canViewChores, canViewMaintenance, canViewPets, timeZone]);

  const colors = useMemo(() => memberColorMap(members.map(m => m.uid)), [members]);
  const events = useMemo(() => [
    ...choreEvents(chores, members, today),
    ...maintenanceEvents(maintenance),
    ...medicationEvents(medication),
  ], [chores, members, maintenance, medication, today]);
  const byDay = useMemo(() => groupByDay(events), [events]);
  const rail = useMemo(() => overdueRail(events), [events]);

  const moveChore = useCallback(async (event: CalendarEvent, day: string) => {
    if (!householdId || !event.choreId || !canMove) return;
    const chore = chores.find(c => c.id === event.choreId);
    if (!chore) return;
    const previous = { dueDate: chore.dueDate, originalDueDate: chore.originalDueDate };
    const next = rescheduleFields(day);
    const ref = doc(db, 'households', householdId, 'chores', chore.id);
    const apply = (fields: { dueDate: string; originalDueDate: string }) =>
      setChores(list => list.map(c => (c.id === chore.id ? { ...c, ...fields } : c)));
    apply(next);
    try {
      await updateDoc(ref, next);
    } catch (error) {
      apply(previous);
      toastError(error, "Couldn't move the chore");
      return;
    }
    playFeedback('add');
    const handle = toast({
      title: 'Chore moved',
      description: `${chore.task} is now on ${format(dayFromKey(day), 'EEE, MMM d')}.`,
      duration: UNDO_MS,
      action: (
        <ToastAction altText={`Undo moving ${chore.task}`} onClick={async () => {
          handle.dismiss();
          apply(previous);
          try {
            await updateDoc(ref, previous);
          } catch (error) {
            apply(next);
            toastError(error, "Couldn't undo the move");
          }
        }}>
          Undo
        </ToastAction>
      ),
    });
  }, [householdId, canMove, chores, toast, toastError]);

  const go = (direction: -1 | 0 | 1) => {
    if (direction === 0) {
      setAnchor(today);
      setSelectedDay(today);
      return;
    }
    const next = view === 'week' ? addDaysToKey(anchor, direction * 7) : shiftMonth(anchor, direction);
    setAnchor(next);
    setSelectedDay(view === 'week' ? addDaysToKey(selectedDay, direction * 7) : next);
  };

  const dropProps = (day: string) => canMove ? {
    onDragOver: (e: React.DragEvent) => {
      if (!dragging.current) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dropTarget !== day) setDropTarget(day);
    },
    onDragLeave: () => setDropTarget(current => (current === day ? null : current)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const event = dragging.current;
      dragging.current = null;
      setDropTarget(null);
      if (event && event.day !== day) void moveChore(event, day);
    },
  } : {};

  const chip = (event: CalendarEvent, animateMove = false) => (
    <EventChip
      key={event.id}
      animateMove={animateMove}
      event={event}
      color={event.memberUid ? colors.get(event.memberUid) : undefined}
      canMove={canMove}
      onMove={(e, day) => void moveChore(e, day)}
      onDragStart={(e) => { dragging.current = e; }}
    />
  );

  const dayCellClass = (day: string) => cn(
    'rounded-lg border bg-card transition-ui',
    day === today && 'border-primary ring-2 ring-primary/60 shadow-[0_0_24px_-6px_hsl(var(--primary)/0.55)]',
    dropTarget === day && 'border-primary bg-primary/10',
  );

  // Phones: swipe left/right on the grid to change week or month.
  const swipeHandlers = {
    onTouchStart: (e: React.TouchEvent) => { touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; },
    onTouchEnd: (e: React.TouchEvent) => {
      const start = touchStart.current;
      touchStart.current = null;
      if (!start) return;
      const dx = e.changedTouches[0].clientX - start.x;
      const dy = e.changedTouches[0].clientY - start.y;
      if (Math.abs(dx) > 60 && Math.abs(dy) < 40) go(dx < 0 ? 1 : -1);
    },
  };

  const title = view === 'week'
    ? (() => { const days = weekDays(anchor); return `${format(dayFromKey(days[0]), 'MMM d')} - ${format(dayFromKey(days[6]), 'MMM d, yyyy')}`; })()
    : format(dayFromKey(anchor), 'MMMM yyyy');

  if (loading) {
    return (
      <div className="space-y-4" role="status" aria-label="Loading calendar">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-[28rem] w-full rounded-xl" />
      </div>
    );
  }

  const nothingVisible = !canViewChores && !canViewMaintenance && !canViewPets;
  const errorList = Object.values(sourceErrors);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-headline text-3xl font-bold tracking-tight">Calendar</h1>
          <p className="text-muted-foreground">Chores, maintenance and pet medication in one place.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup type="single" value={view} onValueChange={(v) => v && setView(v as View)} aria-label="Calendar view" className="rounded-md border p-0.5">
            <ToggleGroupItem value="week" size="sm" className="data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">Week</ToggleGroupItem>
            <ToggleGroupItem value="month" size="sm" className="data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">Month</ToggleGroupItem>
          </ToggleGroup>
          <Button variant="outline" asChild>
            <Link href="/chores"><ListChecks className="mr-2 h-4 w-4" /> Chores</Link>
          </Button>
        </div>
      </div>

      {errorList.length > 0 && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/50 bg-card p-3 text-sm text-foreground">
          <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <span>{errorList.join(' ')} Check your connection and reload the page.</span>
        </div>
      )}

      {nothingVisible ? (
        <div className="rounded-xl border bg-card shadow-raised">
          <EmptyState title="Nothing to show" description="Your role cannot see chores, maintenance or pets. Ask a household admin if that seems wrong." />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <aside aria-labelledby="overdue-rail-title" className="space-y-4">
            <section className="rounded-xl border border-l-4 border-l-destructive bg-card p-3 shadow-raised">
              <h2 id="overdue-rail-title" className="mb-2 flex items-center gap-2 font-headline text-base font-semibold text-foreground">
                <AlertTriangle aria-hidden className="h-4 w-4 text-destructive" /> Overdue ({rail.length})
              </h2>
              {rail.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing is overdue.</p>
              ) : (
                <ul className="flex gap-2 overflow-x-auto pb-1 lg:max-h-[24rem] lg:flex-col lg:overflow-y-auto lg:overflow-x-visible">
                  {rail.map(event => (
                    <li key={event.id} className="min-w-[12rem] lg:min-w-0">
                      {chip(event)}
                      <p className="mt-0.5 truncate px-1 text-xs text-muted-foreground">{event.subtitle} · due {format(dayFromKey(event.day), 'MMM d')}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {members.length > 0 && canViewChores && (
              <section aria-label="Who is who" className="rounded-xl border bg-card p-3 shadow-raised">
                <ul className="flex flex-wrap gap-x-3 gap-y-2 lg:flex-col">
                  {members.map(member => (
                    <li key={member.uid} className="flex items-center gap-2 text-sm text-foreground">
                      <MemberAvatar uid={member.uid} name={member.name} photoUrl={member.avatarUrl} color={colors.get(member.uid)} size="sm" decorative />
                      {member.name}
                    </li>
                  ))}
                  {canViewMaintenance && <li className="flex items-center gap-2 text-sm text-foreground"><Wrench aria-hidden className="h-4 w-4 text-info" /> Maintenance due</li>}
                  {canViewPets && <li className="flex items-center gap-2 text-sm text-foreground"><Pill aria-hidden className="h-4 w-4 text-success" /> Medication given</li>}
                </ul>
              </section>
            )}
          </aside>

          <section aria-label={`${view === 'week' ? 'Week' : 'Month'} of ${title}`} className="min-w-0 rounded-xl border bg-card p-3 shadow-raised md:p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" aria-label={view === 'week' ? 'Previous week' : 'Previous month'} onClick={() => go(-1)}><ChevronLeft className="h-4 w-4" /></Button>
                <Button variant="ghost" size="icon" aria-label={view === 'week' ? 'Next week' : 'Next month'} onClick={() => go(1)}><ChevronRight className="h-4 w-4" /></Button>
                <Button variant="outline" size="sm" onClick={() => go(0)}>Today</Button>
              </div>
              <p className="font-headline text-sm font-semibold text-foreground md:text-lg" aria-live="polite">{title}</p>
            </div>
            {canMove && canViewChores && (
              <p className="mb-3 text-xs text-muted-foreground">Drag a chore to another day, or open it and choose Move to date.</p>
            )}

            <LayoutGroup>
              <div {...swipeHandlers}>
                {view === 'week' ? (
                  <ol className="grid gap-2 md:grid-cols-7">
                    {weekDays(anchor).map((day, i) => {
                      const dayEvents = byDay.get(day) || [];
                      return (
                        <li key={day} className={cn(dayCellClass(day), 'flex min-h-[4.5rem] flex-col gap-1 p-2 md:min-h-[14rem]')} {...dropProps(day)}>
                          <p className={cn('flex items-baseline gap-1 text-xs font-semibold', day === today ? 'text-primary' : 'text-muted-foreground')}>
                            <span className="sr-only">{format(dayFromKey(day), 'EEEE, MMMM d')}</span>
                            <span aria-hidden>{WEEKDAY_LABELS[i]}</span>
                            <span aria-hidden className="text-base text-foreground">{format(dayFromKey(day), 'd')}</span>
                            {day === today && <span className="ml-auto rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">Today</span>}
                          </p>
                          <div className="flex flex-col gap-1">
                            {dayEvents.map(e => chip(e, true))}
                            {dayEvents.length === 0 && <span className="text-xs text-muted-foreground md:hidden">Nothing planned</span>}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                ) : (
                  <div>
                    <div className="grid grid-cols-7 gap-1 pb-1" aria-hidden>
                      {WEEKDAY_LABELS.map(label => <span key={label} className="text-center text-xs font-semibold text-muted-foreground">{label}</span>)}
                    </div>
                    <div className="grid grid-cols-7 gap-1">
                      {monthGrid(anchor).flat().map(day => {
                        const dayEvents = byDay.get(day) || [];
                        const inMonth = isSameMonth(day, anchor);
                        const hidden = dayEvents.length - 3;
                        return (
                          <div key={day} className={cn(dayCellClass(day), 'flex min-h-[3.5rem] flex-col gap-1 p-1 md:min-h-[7rem]', !inMonth && 'bg-background', selectedDay === day && 'border-primary')} {...dropProps(day)}>
                            <button
                              type="button"
                              onClick={() => setSelectedDay(day)}
                              aria-pressed={selectedDay === day}
                              aria-label={`${format(dayFromKey(day), 'EEEE, MMMM d')}${day === today ? ', today' : ''}, ${dayEvents.length} item${dayEvents.length === 1 ? '' : 's'}`}
                              className={cn('flex items-center justify-between rounded px-1 text-xs font-semibold', day === today ? 'text-primary' : inMonth ? 'text-foreground' : 'text-muted-foreground')}
                            >
                              {format(dayFromKey(day), 'd')}
                              {dayEvents.length > 0 && (
                                <span aria-hidden className="flex gap-0.5 md:hidden">
                                  {dayEvents.slice(0, 3).map(e => (
                                    <span key={e.id} className={cn('h-1.5 w-1.5 rounded-full', e.overdue ? 'bg-destructive' : e.kind === 'maintenance' ? 'bg-info' : e.kind === 'medication' ? 'bg-success' : (e.memberUid ? colors.get(e.memberUid)?.classes.bg : 'bg-primary'))} />
                                  ))}
                                </span>
                              )}
                            </button>
                            <div className="hidden flex-col gap-1 md:flex">
                              {dayEvents.slice(0, 3).map(e => chip(e, true))}
                              {hidden > 0 && (
                                <button type="button" className="rounded px-1 text-left text-xs font-medium text-primary hover:underline" onClick={() => setSelectedDay(day)}>
                                  +{hidden} more
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-4 border-t pt-3">
                      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
                        <CalendarDays aria-hidden className="h-4 w-4" /> {format(dayFromKey(selectedDay), 'EEEE, MMMM d')}
                      </h2>
                      {(byDay.get(selectedDay) || []).length > 0 ? (
                        <div className="grid gap-1 sm:grid-cols-2">{(byDay.get(selectedDay) || []).map(e => chip(e))}</div>
                      ) : (
                        <p className="text-sm text-muted-foreground">Nothing planned.</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </LayoutGroup>
            {events.length === 0 && (
              <EmptyState
                compact
                kind="chores"
                headingLevel={2}
                title="Your calendar is empty"
                description="Chores, maintenance due dates and medication show up here as they are added."
                action={canViewChores ? { label: 'Go to Chores', href: '/chores' } : undefined}
              />
            )}
          </section>
        </div>
      )}
    </div>
  );
}
