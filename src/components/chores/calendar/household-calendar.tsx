'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { LayoutGroup, motion } from 'motion/react';
import { format } from 'date-fns';
import { AlertTriangle, CalendarDays, Check, ChevronLeft, ChevronRight, ListChecks, Pill, RefreshCw, Users, Wrench } from 'lucide-react';
import { deleteField, doc, updateDoc } from 'firebase/firestore';
import { approvedPeople } from '@/lib/member-directory';
import type { ChoreTemplate, HomeAsset, MedicationLog, Pet, Vehicle } from '@/lib/types';
import { safeTimeZone } from '@functions/shared/calendar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ToastAction } from '@/components/ui/toast';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { EmptyState } from '@/components/empty-state';
import { MemberAvatar } from '@/components/member-avatar';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { UNDO_WINDOW_MS } from '@/lib/undo-window';
import { movePlannedChore, skipChoreDaysAction, syncHouseholdUpkeep, undoPlannedChoreMove, undoSkipChoreDaysAction } from '@/app/chores/actions';
import { useHouseholdToday } from '@/lib/household-day';
import { auth, db } from '@/lib/firebase';
import { playFeedback } from '@/lib/feedback';
import { memberColorMap } from '@/lib/member-colors';
import { DURATION, EASE } from '@/lib/motion';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { NumberTicker } from '@/components/motion/number-ticker';
import { Stagger, StaggerItem } from '@/components/motion/stagger';
import { toDate } from '@/lib/pets/care';
import { readCourse, withOfflineDoses } from '@/lib/pets/medication-course';
import { cn } from '@/lib/utils';
import { useChoreLiveData } from '@/components/chores/use-chore-live-data';
import { useConfetti } from '@/components/chores/confetti';
import { addDaysToKey, dayFromKey, type ChoreRecord } from '@/lib/chores/dates';
import { isDueAfterHouseholdDay } from '@/lib/chores/completion';
import {
  completedChoreFields, completeChoresOnServer, completionFailureMessage, reopenedChoreFields, undoCompletionOnServer, undoTicket,
} from '@/lib/chores/complete-client';
import { computeChoreStats } from '@/lib/chores/stats';
import { readWeekStartsOn, weekdayLabels } from '@/lib/chores/week-start';
import {
  ALL_KINDS, awayEvents, careEvents, choreEvents, courseDueEvents, filterEvents, foldedOverdueRail, groupByDay, isSameMonth, laneRows,
  maintenanceCalendarItems, maintenanceEvents, medicationDueEvents, medicationEvents, monthGrid, monthSelection, pantryExpiryEvents, pantryExpiryInputs,
  plannedRecurringEvents, projectedMaintenanceEvents, rescheduleFields, shiftMonth, skipPlan, weekDays, withUniqueIds,
  type CalendarEvent, type CalendarEventKind, type CalendarMember, type CareEntry, type CourseEntry, type MedicationEntry, type RecurringTemplate,
} from '@/lib/chores/calendar';
import { EventChip, type ChipMember } from './event-chip';
import { liveGroupStatus, useLiveDocs, type LiveSpec } from './use-live-docs';
import { useIdleReturn } from './use-idle-return';
import { FairShareStrip } from './fair-share-strip';
import { AwayDialog } from './away-dialog';

type View = 'day' | 'week' | 'month';

/** Phones open on the day agenda (H19); wider screens on the week. */
const PHONE_QUERY = '(max-width: 767px)';
function initialView(): View {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'week';
  return window.matchMedia(PHONE_QUERY).matches ? 'day' : 'week';
}

/** True on phones (below 768 px), kept current. */
function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(PHONE_QUERY);
    const update = () => setPhone(query.matches);
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return phone;
}

const VIEW_NOUN: Record<View, string> = { day: 'day', week: 'week', month: 'month' };
type Member = CalendarMember & { avatarUrl?: string | null; joinedAt?: string; role?: string };

const KIND_FILTERS: Record<CalendarEventKind, string> = { chore: 'Chores', maintenance: 'Maintenance', medication: 'Medication', care: 'Pet care', pantry: 'Pantry' };
/** Week cells show this many items before "+N more" opens the day (CA-14). */
const WEEK_CELL_MAX = 6;
/** How long a settled write keeps its local version while no newer snapshot has arrived. */
const SETTLE_WAIT_MS = 5000;

type Override = { chore: ChoreRecord; held: boolean; snapshot: unknown };

/**
 * Full-page household calendar (H19; audit section 6): Day (agenda), Week and Month views
 * of chores, maintenance (due dates, expirations and projected repeats), pet medication
 * (doses given and due), logged pet care and pantry expiry dates, all live (CA-1). Phones
 * open on the day agenda. Chores carry their member's avatar and colour (CA-10), can be
 * marked done (CA-8) through the Chores server actions, moved (drag on fine pointers,
 * quick picks and Move to date everywhere, CA-11; planned days through the server,
 * CA-15) and skipped (CA-27), each with Undo. Today is the household's day (D-6). See
 * docs/modules/chores/README.md, "Calendar".
 */
export function HouseholdCalendar() {
  const { currentUser, currentMember, household, permissions, householdLoading, householdLoadFailed, retryHouseholdLoad } = useAuth();
  const { toast } = useToast();
  const viewerUid = currentUser?.uid ?? '';
  const viewerEmail = currentUser?.email ?? '';
  const householdId = currentUser?.householdId ?? null;
  const canViewChores = Boolean(permissions['chores.view']);
  const canViewMaintenance = Boolean(permissions['maintenance.view']);
  const canViewPets = Boolean(permissions['pets.view']);
  const canViewPantry = Boolean(permissions['shopping.view']);
  const canMove = Boolean(permissions['chores.edit']);
  const canComplete = Boolean(permissions['chores.complete']);
  const canSkip = Boolean(permissions['chores.delete']);
  const timeZone = safeTimeZone(household?.timeZone);
  const weekStartsOn = readWeekStartsOn(household?.weekStartsOn);
  const weekdayNames = useMemo(() => weekdayLabels(weekStartsOn), [weekStartsOn]);
  const isPhone = useIsPhone();
  const reduced = useReducedMotion();
  const { burst, layer: confettiLayer } = useConfetti();

  /* ---------------------------------------------------------------------- */
  /* Live data (CA-1, CA-3, CA-6)                                            */
  /* ---------------------------------------------------------------------- */

  // Chores, templates, rooms and members: the Chores page's own listeners.
  const liveKey = canViewChores && householdId && viewerUid ? `${householdId}|${viewerUid}` : null;
  const live = useChoreLiveData(householdId, liveKey);
  const baseSpecs = useMemo<LiveSpec[]>(() => !householdId ? [] : [
    ...(!canViewChores ? [{ key: 'members', path: ['households', householdId, 'members'] }] : []),
    ...(canViewMaintenance ? [{ key: 'assets', path: ['households', householdId, 'home-assets'] }, { key: 'vehicles', path: ['households', householdId, 'vehicles'] }] : []),
    ...(canViewPets ? [{ key: 'pets', path: ['households', householdId, 'pets'] }] : []),
    ...(canViewPantry ? [{ key: 'pantry', path: ['households', householdId, 'pantry-inventory'] }] : []),
  ], [householdId, canViewChores, canViewMaintenance, canViewPets, canViewPantry]);
  const sources = useLiveDocs(baseSpecs);
  const petDocs = sources.docs.get('pets') ?? null;
  const petIdsKey = (petDocs ?? []).map(d => d.id).sort().join('/');
  const petSpecs = useMemo<LiveSpec[]>(() => (!householdId || !petIdsKey ? [] : petIdsKey.split('/').flatMap(petId => [
    { key: `meds:${petId}`, path: ['households', householdId, 'pets', petId, 'medication-logs'] },
    { key: `courses:${petId}`, path: ['households', householdId, 'pets', petId, 'medication-courses'] },
    { key: `care:${petId}`, path: ['households', householdId, 'pets', petId, 'care-logs'] },
  ])), [householdId, petIdsKey]);
  const petSources = useLiveDocs(petSpecs);

  // Upkeep (recurring chores) runs in the background, never before the first render (CA-6,
  // CH-17); the chores it generates arrive through the listener.
  const runUpkeep = useCallback(async () => {
    const user = auth.currentUser;
    if (!householdId || !user || !canViewChores) return;
    await syncHouseholdUpkeep({ idToken: await user.getIdToken(), householdId }).catch(() => undefined);
  }, [householdId, canViewChores]);
  useEffect(() => { void runUpkeep(); }, [runUpkeep]);

  const memberDocs = canViewChores ? live.state.docs.members : (sources.docs.get('members') ?? null);
  const members = useMemo<Member[]>(() => approvedPeople(memberDocs ?? []).map(person => ({
    uid: person.uid,
    // Matching key for older chores only; the viewer always knows their own.
    email: person.uid === viewerUid ? person.email || viewerEmail : person.email,
    name: person.displayName,
    avatarUrl: person.avatarUrl,
    joinedAt: person.joinedAt,
    role: person.role,
    // Kid profiles take no rotation turns yet (CH-28, HO-15d), as on the server.
    ...(person.kind === 'identity' ? { kind: 'identity' } : {}),
  })), [memberDocs, viewerUid, viewerEmail]);
  const membersFailed = canViewChores ? Boolean(live.state.failures.members) && !live.state.docs.members : sources.failed.has('members') && !sources.docs.get('members');

  const choreDocs = live.state.docs.chores;
  const serverChores = useMemo(() => (choreDocs ?? []).map(d => ({ id: d.id, ...d.data } as ChoreRecord)), [choreDocs]);
  const templates = useMemo<RecurringTemplate[]>(() => (live.state.docs['chore-templates'] ?? []).map(d => ({ ...(d.data as ChoreTemplate), id: d.id })), [live.state.docs]);

  // Writes in flight keep the page's version until a newer snapshot arrives (as on Chores).
  const [overrides, setOverrides] = useState<Map<string, Override>>(() => new Map());
  const choreDocsRef = useRef<unknown>(choreDocs);
  useEffect(() => { choreDocsRef.current = choreDocs; }, [choreDocs]);
  const chores = useMemo(() => {
    if (overrides.size === 0) return serverChores;
    const rows = serverChores.map(chore => {
      const entry = overrides.get(chore.id);
      return entry && (entry.held || entry.snapshot === choreDocs) ? entry.chore : chore;
    });
    return rows;
  }, [serverChores, overrides, choreDocs]);
  const choresById = useMemo(() => new Map(chores.map(chore => [chore.id, chore])), [chores]);
  const patchChore = useCallback((id: string, fields: Partial<ChoreRecord>) => {
    setOverrides(previous => {
      const base = previous.get(id)?.chore ?? serverChores.find(chore => chore.id === id);
      if (!base) return previous;
      return new Map(previous).set(id, { chore: { ...base, ...fields }, held: true, snapshot: null });
    });
  }, [serverChores]);
  const releaseChore = useCallback((id: string) => {
    setOverrides(previous => {
      const entry = previous.get(id);
      if (!entry) return previous;
      return new Map(previous).set(id, { ...entry, held: false, snapshot: choreDocsRef.current });
    });
    window.setTimeout(() => setOverrides(previous => {
      const entry = previous.get(id);
      if (!entry || entry.held) return previous;
      const next = new Map(previous);
      next.delete(id);
      return next;
    }), SETTLE_WAIT_MS);
  }, []);

  const assets = useMemo(() => (sources.docs.get('assets') ?? []).map(d => ({ ...(d.data as HomeAsset), id: d.id })), [sources.docs]);
  const vehicles = useMemo(() => (sources.docs.get('vehicles') ?? []).map(d => ({ ...(d.data as Vehicle), id: d.id })), [sources.docs]);
  // Through the pantry's own reader: legacy timestamp expiries land on their household day (review finding 4).
  const pantry = useMemo(() => pantryExpiryInputs(sources.docs.get('pantry') ?? [], timeZone), [sources.docs, timeZone]);
  // Medication: every dose of each pet (the countdown needs each pet's whole history, CA-20).
  const { medication, courses, care } = useMemo(() => {
    const medicationList: MedicationEntry[] = [];
    const courseList: CourseEntry[] = [];
    const careList: CareEntry[] = [];
    for (const petDoc of petDocs ?? []) {
      const pet = petDoc.data as Pet;
      const petName = pet.name || 'Pet';
      const meds = petSources.docs.get(`meds:${petDoc.id}`) ?? [];
      for (const m of meds) {
        const log = m.data as MedicationLog & { nextDueDate?: string; courseId?: string; oneOff?: boolean };
        medicationList.push({
          id: m.id, petId: petDoc.id, petName, medication: log.medication || 'Medication', dosage: log.dosage,
          date: toDate(log.date as unknown)?.toISOString() ?? '',
          ...(typeof log.nextDueDate === 'string' ? { nextDueDate: log.nextDueDate } : {}),
          ...(typeof log.courseId === 'string' ? { courseId: log.courseId } : {}),
          ...(log.oneOff === true ? { oneOff: true } : {}),
        });
      }
      for (const c of petSources.docs.get(`courses:${petDoc.id}`) ?? []) {
        const course = readCourse(c.id, c.data);
        // A dose recorded offline (not in the course's pointer) covers its occurrence too.
        if (course) courseList.push({ petId: petDoc.id, petName, course: withOfflineDoses(course, meds.map(m => ({ id: m.id, ...m.data }))) });
      }
      for (const entry of petSources.docs.get(`care:${petDoc.id}`) ?? []) {
        careList.push({ id: entry.id, petId: petDoc.id, petName, activity: typeof entry.data.activity === 'string' ? entry.data.activity : undefined, date: toDate(entry.data.date as unknown)?.toISOString() ?? '' });
      }
    }
    return { medication: medicationList, courses: courseList, care: careList };
  }, [petDocs, petSources.docs]);

  const choresStatus = !liveKey ? 'ready' : live.status;
  const maintenanceStatus = canViewMaintenance ? liveGroupStatus(sources, ['assets', 'vehicles']) : 'ready';
  const petsStatus = canViewPets ? (liveGroupStatus(sources, ['pets']) === 'ready' ? liveGroupStatus(petSources, petSpecs.map(s => s.key)) : liveGroupStatus(sources, ['pets'])) : 'ready';
  const pantryStatus = canViewPantry ? liveGroupStatus(sources, ['pantry']) : 'ready';
  const statuses = { chores: choresStatus, maintenance: maintenanceStatus, pets: petsStatus, pantry: pantryStatus };
  const errorList = [
    choresStatus === 'error' ? 'Chores could not be loaded.' : null,
    membersFailed ? 'Members could not be loaded, so planned repeats and colours are missing.' : null,
    maintenanceStatus === 'error' ? 'Maintenance dates could not be loaded.' : null,
    petsStatus === 'error' ? 'Pet medication could not be loaded.' : null,
    pantryStatus === 'error' ? 'Pantry dates could not be loaded.' : null,
  ].filter((line): line is string => Boolean(line));
  const stillLoading = Object.values(statuses).filter(s => s === 'loading').length;
  const retryAll = useCallback(() => { live.retry(); sources.retry(); petSources.retry(); }, [live, sources, petSources]);

  /* ---------------------------------------------------------------------- */
  /* Days and navigation                                                     */
  /* ---------------------------------------------------------------------- */

  const [view, setView] = useState<View>(initialView);
  const [weekLayout, setWeekLayout] = useState<'days' | 'people'>('days');
  // Direction of the last day change, so the agenda slides in from that side.
  const [dayShift, setDayShift] = useState<-1 | 0 | 1>(0);
  // Today is the household's day for everything (D-6, CA-7), as completion is on the server.
  const householdToday = useHouseholdToday(household?.timeZone ?? null);
  const today = householdToday;
  const [anchor, setAnchor] = useState(today);
  const [selectedDay, setSelectedDay] = useState(today);
  // At midnight, a view that was showing "today" moves with it; a view the member
  // navigated elsewhere stays put.
  const [shownToday, setShownToday] = useState(today);
  if (today !== shownToday) {
    setShownToday(today);
    if (anchor === shownToday) setAnchor(today);
    if (selectedDay === shownToday) setSelectedDay(today);
  }
  const [kinds, setKinds] = useState<ReadonlySet<CalendarEventKind>>(() => new Set(ALL_KINDS));
  const [onlyMember, setOnlyMember] = useState<string | null>(null);
  const dragging = useRef<CalendarEvent | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const openPanels = useRef(0);
  const undoUntil = useRef(0);
  const monthDetail = useRef<HTMLDivElement | null>(null);
  const [focusDay, setFocusDay] = useState(today);

  const go = useCallback((direction: -1 | 0 | 1) => {
    if (direction === 0) {
      setDayShift(selectedDay === today ? 0 : selectedDay < today ? 1 : -1);
      setAnchor(today);
      setSelectedDay(today);
      return;
    }
    if (view === 'day') {
      const next = addDaysToKey(selectedDay, direction);
      setDayShift(direction);
      setSelectedDay(next);
      setAnchor(next);
      return;
    }
    const next = view === 'week' ? addDaysToKey(anchor, direction * 7) : shiftMonth(anchor, direction);
    setAnchor(next);
    // Month: today when the new month holds it, else the 1st (CA-18).
    setSelectedDay(view === 'week' ? addDaysToKey(selectedDay, direction * 7) : monthSelection(next, today));
  }, [anchor, selectedDay, today, view]);

  // A shared screen returns to Today after 2 idle minutes (CA-12), never under an open
  // panel or while an Undo is showing.
  useIdleReturn(anchor !== today || selectedDay !== today, () => {
    if (openPanels.current > 0 || Date.now() < undoUntil.current) return;
    go(0);
  });

  /* ---------------------------------------------------------------------- */
  /* Events                                                                  */
  /* ---------------------------------------------------------------------- */

  const colors = useMemo(() => memberColorMap(members.map(m => ({ uid: m.uid, joinedAt: m.joinedAt }))), [members]);
  const chipMembers = useMemo(() => new Map<string, ChipMember>(members.map(m => [m.uid, { uid: m.uid, name: m.name, avatarUrl: m.avatarUrl }])), [members]);
  // The whole visible range, so repeating chores beyond the server's 30-occurrence
  // lookahead still show.
  const visibleDays = useMemo(() => (view === 'day' ? [selectedDay] : view === 'week' ? weekDays(anchor, weekStartsOn) : monthGrid(anchor, weekStartsOn).flat()), [view, anchor, selectedDay, weekStartsOn]);
  const rangeStart = visibleDays[0];
  const rangeEnd = visibleDays[visibleDays.length - 1];
  // Split memos (CA-20): navigating only recomputes what depends on the range.
  const choreItems = useMemo(() => choreEvents(chores, members, today), [chores, members, today]);
  const plannedItems = useMemo(() => plannedRecurringEvents(templates, chores, members, today, rangeStart, rangeEnd), [templates, chores, members, today, rangeStart, rangeEnd]);
  const maintenance = useMemo(() => maintenanceCalendarItems(assets, vehicles, today, timeZone), [assets, vehicles, today, timeZone]);
  const maintenanceItems = useMemo(() => maintenanceEvents(maintenance), [maintenance]);
  const projectedItems = useMemo(() => projectedMaintenanceEvents(assets, vehicles, timeZone, rangeStart > today ? rangeStart : today, rangeEnd), [assets, vehicles, timeZone, rangeStart, rangeEnd, today]);
  const givenItems = useMemo(() => medicationEvents(medication, timeZone), [medication, timeZone]);
  const dueItems = useMemo(() => medicationDueEvents(medication, householdToday, courses), [medication, householdToday, courses]);
  // Recomputed with the household day; a label such as "Due since 8:00 PM" uses the time of computing.
  const courseItems = useMemo(() => courseDueEvents(courses, new Date(), timeZone, rangeEnd > householdToday ? rangeEnd : householdToday, rangeStart), [courses, timeZone, rangeEnd, householdToday, rangeStart]);
  const careItems = useMemo(() => careEvents(care, timeZone), [care, timeZone]);
  const pantryItems = useMemo(() => pantryExpiryEvents(pantry, today), [pantry, today]);
  const filter = useMemo(() => ({ kinds, memberUid: onlyMember }), [kinds, onlyMember]);
  const allEvents = useMemo(() => withUniqueIds([
    ...choreItems, ...plannedItems, ...maintenanceItems, ...projectedItems, ...givenItems, ...dueItems, ...courseItems, ...careItems, ...pantryItems,
  ]), [choreItems, plannedItems, maintenanceItems, projectedItems, givenItems, dueItems, courseItems, careItems, pantryItems]);
  const events = useMemo(() => filterEvents(allEvents, filter), [allEvents, filter]);
  // Only the visible range is grouped and sorted (CA-20).
  const byDay = useMemo(() => groupByDay(events.filter(e => e.day >= rangeStart && e.day <= rangeEnd)), [events, rangeStart, rangeEnd]);
  const rail = useMemo(() => foldedOverdueRail(events.filter(e => e.overdue), chores, templates, members, today), [events, chores, templates, members, today]);
  const lanes = useMemo(() => (view === 'week' && weekLayout === 'people' ? laneRows(events, members, visibleDays) : []), [view, weekLayout, events, members, visibleDays]);
  const stats = useMemo(() => computeChoreStats(chores, members.map(m => ({ uid: m.uid, name: m.name, role: m.role, email: m.email })), dayFromKey(today), { today, timeZone, weekStartsOn }), [chores, members, today, timeZone, weekStartsOn]);
  const photos = useMemo(() => new Map(members.map(m => [m.uid, m.avatarUrl])), [members]);

  /* ---------------------------------------------------------------------- */
  /* Actions                                                                 */
  /* ---------------------------------------------------------------------- */

  const showUndo = useCallback((title: string, description: string, group: string, undo: () => void | Promise<void>) => {
    undoUntil.current = Date.now() + UNDO_WINDOW_MS;
    const handle = toast({
      group,
      title,
      description,
      duration: UNDO_WINDOW_MS,
      action: (
        <ToastAction altText={`Undo: ${description}`} onClick={() => { handle.dismiss(); undoUntil.current = 0; void undo(); }}>Undo</ToastAction>
      ),
    });
  }, [toast]);
  const fail = useCallback((title: string) => toast({ variant: 'destructive', title }), [toast]);

  // Mark done (CA-8): the Chores server action, CH-2's rule (nothing before its day) on the server.
  const completeChore = useCallback(async (event: CalendarEvent) => {
    if (!householdId || !event.choreId || !canComplete) return;
    const chore = choresById.get(event.choreId);
    if (!chore || chore.isCompleted) return;
    if (isDueAfterHouseholdDay(chore, today, timeZone)) {
      fail(`Not due yet: ${chore.task} can be completed from ${format(dayFromKey(event.day), 'EEE, MMM d')}.`);
      return;
    }
    const rect = typeof document !== 'undefined' ? document.activeElement?.getBoundingClientRect() : null;
    patchChore(chore.id, { isCompleted: true });
    const result = await completeChoresOnServer(householdId, [chore.id], { completeSubTasks: true });
    if (!result.ok) {
      patchChore(chore.id, { ...reopenedChoreFields(), completedSubTasks: chore.completedSubTasks });
      releaseChore(chore.id);
      fail(completionFailureMessage(result, 'complete'));
      return;
    }
    const outcome = result.data[0];
    if (!outcome || outcome.status !== 'completed') {
      patchChore(chore.id, { ...reopenedChoreFields(), completedSubTasks: chore.completedSubTasks });
      releaseChore(chore.id);
      if (outcome?.status === 'already') fail(`${chore.task} was already done${outcome.completion.completedByName ? ` by ${outcome.completion.completedByName}` : ''}.`);
      else if (outcome?.status === 'refused' && outcome.refused === 'early') fail(`Not due yet: ${chore.task} can be completed from ${format(dayFromKey(outcome.dueDay), 'EEE, MMM d')}.`);
      else fail("Couldn't complete. Try again.");
      return;
    }
    patchChore(chore.id, completedChoreFields(outcome.completion));
    releaseChore(chore.id);
    playFeedback('complete');
    burst(rect, 24);
    const ticket = undoTicket(outcome);
    if (!ticket) return;
    showUndo('Chore done', `${chore.task} is done.`, 'chore-complete', async () => {
      patchChore(chore.id, { ...reopenedChoreFields(), completedSubTasks: chore.completedSubTasks });
      const undone = await undoCompletionOnServer(householdId, ticket);
      releaseChore(chore.id);
      if (!undone.ok) fail(completionFailureMessage(undone, 'undo'));
      else if (undone.data.status === 'stale' || undone.data.status === 'missing') fail('Already changed on another device.');
    });
  }, [householdId, canComplete, choresById, today, timeZone, patchChore, releaseChore, fail, burst, showUndo]);

  // Move (generated chores: a write, as before; planned days: the server, CA-15).
  const moveChore = useCallback(async (event: CalendarEvent, day: string) => {
    if (!householdId || !canMove) return;
    if (event.planned && event.templateId && event.roomId && event.occurrenceDay) {
      const user = auth.currentUser;
      if (!user) return;
      const context = { idToken: await user.getIdToken(), householdId };
      const result = await movePlannedChore({ ...context, templateId: event.templateId, roomId: event.roomId, day: event.occurrenceDay, toDay: day });
      if (!result.ok) {
        fail(result.code === 'conflict' ? 'That day was just added to the chart. Try again.' : result.code === 'forbidden' ? "You don't have permission to move chores." : "Couldn't move the chore.");
        return;
      }
      playFeedback('add');
      showUndo('Chore moved', `${event.title} is now on ${format(dayFromKey(day), 'EEE, MMM d')}.`, `chore-move:${event.id}`, async () => {
        const again = auth.currentUser;
        if (!again) return;
        const undone = await undoPlannedChoreMove({ idToken: await again.getIdToken(), householdId, opId: result.data.opId });
        if (!undone.ok) fail("Couldn't undo the move.");
        else if (undone.data.status === 'stale') fail('Already changed, so it stays on its new day.');
        else void runUpkeep();
      });
      return;
    }
    if (!event.choreId) return;
    const chore = choresById.get(event.choreId);
    if (!chore) return;
    const previousFields = { dueDate: chore.dueDate, originalDueDate: chore.originalDueDate };
    const next = rescheduleFields(day);
    const ref = doc(db, 'households', householdId, 'chores', chore.id);
    patchChore(chore.id, next);
    try {
      await updateDoc(ref, next);
    } catch (error) {
      patchChore(chore.id, previousFields);
      releaseChore(chore.id);
      fail(error instanceof Error && /permission/i.test(error.message) ? "You don't have permission to move chores." : "Couldn't move the chore.");
      return;
    }
    releaseChore(chore.id);
    playFeedback('add');
    // Each chore's move has its own Undo, so a second quick move keeps the first one's (CA-7).
    showUndo('Chore moved', `${chore.task} is now on ${format(dayFromKey(day), 'EEE, MMM d')}.`, `chore-move:${chore.id}`, async () => {
      patchChore(chore.id, previousFields);
      try {
        // A legacy chore had no calendar day: Undo removes the field instead of writing undefined (CA-7).
        await updateDoc(ref, { dueDate: previousFields.dueDate, originalDueDate: previousFields.originalDueDate ?? deleteField() });
      } catch {
        patchChore(chore.id, next);
        fail("Couldn't undo the move.");
      } finally {
        releaseChore(chore.id);
      }
    });
  }, [householdId, canMove, choresById, patchChore, releaseChore, fail, showUndo, runUpkeep]);

  // Skip one day, or every repeating chore while away (CA-27, the CH-3 skip mechanism).
  const skip = useCallback(async (list: readonly CalendarEvent[], label: string): Promise<boolean> => {
    if (!householdId || !canSkip) return false;
    const plan = skipPlan(list, today);
    const user = auth.currentUser;
    if (plan.items.length === 0 || !user) return false;
    // On the server (review findings 2, 3): it re-reads each chore, never deletes a
    // completion, and keeps what it deleted so Undo can put it back.
    const result = await skipChoreDaysAction({ idToken: await user.getIdToken(), householdId, items: plan.items });
    if (!result.ok) {
      fail(result.code === 'forbidden' ? "You don't have permission to skip chores." : "Couldn't skip. Try again.");
      return false;
    }
    playFeedback('add');
    showUndo('Skipped', result.data.kept > 0 ? `${label} ${result.data.kept} changed meanwhile and stayed.` : label, 'chore-skip', async () => {
      const again = auth.currentUser;
      if (!again) return;
      const undone = await undoSkipChoreDaysAction({ idToken: await again.getIdToken(), householdId, opId: result.data.opId });
      if (!undone.ok) fail("Couldn't undo the skip.");
      // Days that could not be put back (taken meanwhile, or planned) come from upkeep.
      else if (undone.data.regenerate > 0 || plan.items.some(item => !item.choreId)) void runUpkeep();
    });
    return true;
  }, [householdId, canSkip, today, fail, showUndo, runUpkeep]);
  const skipOne = useCallback((event: CalendarEvent) => { void skip([event], `${event.title} on ${format(dayFromKey(event.day), 'EEE, MMM d')} is skipped.`); }, [skip]);
  const awayList = useCallback((from: string, to: string) => awayEvents([
    ...choreItems,
    ...plannedRecurringEvents(templates, chores, members, today, from, to),
  ], from, to), [choreItems, templates, chores, members, today]);

  const onDragStart = useCallback((event: CalendarEvent) => { dragging.current = event; }, []);
  // A cancelled drag never leaves a chore behind to be moved by a later drop (CA-4).
  const onDragEnd = useCallback(() => {
    dragging.current = null;
    document.querySelectorAll('[data-drop="true"]').forEach(node => node.removeAttribute('data-drop'));
  }, []);
  const onPanel = useCallback((open: boolean) => { openPanels.current = Math.max(0, openPanels.current + (open ? 1 : -1)); }, []);
  const onComplete = useCallback((event: CalendarEvent) => { void completeChore(event); }, [completeChore]);
  const onMove = useCallback((event: CalendarEvent, day: string) => { void moveChore(event, day); }, [moveChore]);

  // CSS-only drop highlight (CA-20): only the cell's attribute changes during a drag.
  const dropProps = (day: string) => canMove ? {
    onDragOver: (e: React.DragEvent<HTMLElement>) => {
      if (!dragging.current) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      e.currentTarget.setAttribute('data-drop', 'true');
    },
    onDragLeave: (e: React.DragEvent<HTMLElement>) => e.currentTarget.removeAttribute('data-drop'),
    onDrop: (e: React.DragEvent<HTMLElement>) => {
      e.preventDefault();
      e.currentTarget.removeAttribute('data-drop');
      const event = dragging.current;
      dragging.current = null;
      // Only the chore this drag started with (CA-4).
      if (event && e.dataTransfer.getData('text/plain') === event.id && event.day !== day) void moveChore(event, day);
    },
  } : {};

  const chip = (event: CalendarEvent, options: { animateMove?: boolean; withDate?: boolean; tabbable?: boolean } = {}) => {
    const chore = event.choreId ? choresById.get(event.choreId) : undefined;
    return (
      <EventChip
        key={event.id}
        event={event}
        color={event.memberUid ? colors.get(event.memberUid) : undefined}
        member={event.memberUid ? chipMembers.get(event.memberUid) : undefined}
        today={today}
        canMove={canMove}
        canComplete={canComplete}
        canSkip={canSkip}
        notDueYet={chore ? isDueAfterHouseholdDay(chore, today, timeZone) : false}
        withDate={options.withDate}
        tabbable={options.tabbable}
        animateMove={options.animateMove}
        draggable={!isPhone}
        onMove={onMove}
        onComplete={onComplete}
        onSkip={skipOne}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onOpenChange={onPanel}
      />
    );
  };

  /** A big Done beside a chore in the agenda and the rail (CA-8). */
  const doneButton = (event: CalendarEvent) => {
    if (!canComplete || event.kind !== 'chore' || event.completed || event.planned || !event.choreId) return null;
    const chore = choresById.get(event.choreId);
    if (!chore || isDueAfterHouseholdDay(chore, today, timeZone)) return null;
    return (
      <Button type="button" variant="outline" size="icon" className="h-[var(--target-min)] w-[var(--target-min)] shrink-0 text-primary" aria-label={`Mark ${event.title} done`} onClick={(e) => { e.currentTarget.blur(); void completeChore(event); }} data-testid="calendar-done">
        <Check aria-hidden className="h-5 w-5" />
      </Button>
    );
  };

  const dayCellClass = (day: string) => cn(
    'rounded-lg border bg-card transition-ui data-[drop=true]:border-primary data-[drop=true]:bg-primary/10',
    day === today && 'border-primary ring-2 ring-primary/60 shadow-[0_0_24px_-6px_hsl(var(--primary)/0.55)]',
  );

  const changeView = (next: View) => {
    setView(next);
    // Keep the day in view: the week or month around it, or the day itself.
    setAnchor(selectedDay);
    setDayShift(0);
  };
  const openDay = (day: string) => {
    setSelectedDay(day);
    setAnchor(day);
    setDayShift(0);
    setView('day');
  };
  const selectMonthDay = (day: string) => {
    setSelectedDay(day);
    setFocusDay(day);
    // The day's detail is below the grid: bring it into view (CA-13).
    window.requestAnimationFrame(() => monthDetail.current?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' }));
  };

  // Swipes change the day (phones) or the month; never in Week on wider screens, and never
  // when the finger starts on an item (CA-11, CA-12).
  const swipeHandlers = {
    onTouchStart: (e: React.TouchEvent) => {
      const target = e.target as HTMLElement | null;
      // A touch inside a details panel (a portal) bubbles here too: never a swipe.
      const outside = !target || !e.currentTarget.contains(target);
      touchStart.current = outside || target.closest('[data-calendar-chip]') || (view === 'week' && !isPhone) ? null : { x: e.touches[0].clientX, y: e.touches[0].clientY };
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const start = touchStart.current;
      touchStart.current = null;
      if (!start) return;
      const dx = e.changedTouches[0].clientX - start.x;
      const dy = e.changedTouches[0].clientY - start.y;
      if (Math.abs(dx) > 60 && Math.abs(dy) < 40) go(dx < 0 ? 1 : -1);
    },
  };

  // Month grid keys (CA-19): one tab stop; arrows move by a day or a week.
  const monthDays = useMemo(() => monthGrid(anchor, weekStartsOn), [anchor, weekStartsOn]);
  const monthKeyDown = (e: React.KeyboardEvent, day: string) => {
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? -7 : e.key === 'ArrowDown' ? 7 : 0;
    if (!step) return;
    e.preventDefault();
    const flat = monthDays.flat();
    const next = addDaysToKey(day, step);
    if (!flat.includes(next)) return;
    setFocusDay(next);
    window.requestAnimationFrame(() => (document.querySelector(`[data-day-button="${next}"]`) as HTMLElement | null)?.focus());
  };

  const title = view === 'day'
    ? format(dayFromKey(selectedDay), 'EEEE, MMMM d, yyyy')
    : view === 'week'
      ? `${format(dayFromKey(visibleDays[0]), 'MMM d')} - ${format(dayFromKey(visibleDays[6]), 'MMM d, yyyy')}`
      : format(dayFromKey(anchor), 'MMMM yyyy');
  const viewNoun = VIEW_NOUN[view];
  const agendaEvents = byDay.get(selectedDay) || [];
  const currentWeek = view === 'week' && visibleDays.includes(today);

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  // Signed in without a household: never an endless skeleton (CA-7).
  if (currentUser && !householdId && !householdLoading) {
    return (
      <div className="rounded-xl border bg-card shadow-raised">
        <EmptyState title="No household yet" description="Create or join a household to see its calendar." action={{ label: 'Go to Household', href: '/household' }} />
      </div>
    );
  }
  if (householdId && !currentMember && householdLoadFailed) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/50 bg-card p-3 text-sm text-foreground">
        <AlertTriangle aria-hidden className="h-4 w-4 shrink-0 text-destructive" />
        <span className="min-w-0 flex-1">Your household could not be loaded. Retrying automatically.</span>
        <Button type="button" variant="outline" size="sm" className="min-h-[var(--target-min)]" onClick={retryHouseholdLoad}><RefreshCw aria-hidden className="mr-2 h-4 w-4" /> Try again</Button>
      </div>
    );
  }
  // Permissions are known once the membership record is (CA-7: no "Nothing to show" flash).
  if (!householdId || !currentMember || (choresStatus === 'loading' && !choreDocs)) {
    return (
      <div className="space-y-4" role="status" aria-label="Loading calendar">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="mb-4 h-10 w-full max-w-md" />
        <Skeleton className="h-[28rem] w-full rounded-xl" />
      </div>
    );
  }

  const nothingVisible = !canViewChores && !canViewMaintenance && !canViewPets && !canViewPantry;
  const kindOptions = ALL_KINDS.filter(kind => (kind === 'chore' ? canViewChores : kind === 'maintenance' ? canViewMaintenance : kind === 'pantry' ? canViewPantry : canViewPets));

  const weekCell = (day: string, i: number, dayEvents: CalendarEvent[]) => {
    const shown = dayEvents.slice(0, WEEK_CELL_MAX);
    const hidden = dayEvents.length - shown.length;
    return (
      <li key={day} className={cn(dayCellClass(day), 'flex min-h-[4.5rem] min-w-0 flex-col gap-1 p-2 md:min-h-[14rem]')} {...dropProps(day)} data-day={day}>
        <h3 className={cn('flex items-baseline gap-1 text-sm font-semibold', day === today ? 'text-primary' : 'text-muted-foreground')}>
          <span className="sr-only">{format(dayFromKey(day), 'EEEE, MMMM d')}{day === today ? ', today' : ''}</span>
          <span aria-hidden>{weekdayNames[i]}</span>
          <span aria-hidden className="text-base text-foreground">{format(dayFromKey(day), 'd')}</span>
          {day === today && <span aria-hidden className="ml-auto rounded-full bg-primary px-2 text-sm text-primary-foreground">Today</span>}
        </h3>
        <div className="flex min-h-0 flex-col gap-1">
          {shown.map(e => chip(e, { animateMove: true }))}
          {hidden > 0 && (
            <button type="button" className="min-h-[var(--target-min)] rounded px-1 text-left text-sm font-medium text-primary hover:underline" onClick={() => openDay(day)}>
              +{hidden} more
            </button>
          )}
          {dayEvents.length === 0 && <span className="text-sm text-muted-foreground">Nothing planned</span>}
        </div>
      </li>
    );
  };

  return (
    <div className="space-y-4">
      {confettiLayer}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-headline text-3xl font-bold tracking-tight">Calendar</h1>
          <p className="text-muted-foreground [@media(pointer:coarse)_and_(orientation:landscape)]:hidden">Chores, maintenance, pets and the pantry in one place.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup type="single" value={view} onValueChange={(v) => v && changeView(v as View)} aria-label="Calendar view" className="rounded-md border p-0.5">
            <ToggleGroupItem value="day" size="sm" className="min-h-[var(--target-min)] px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">Day</ToggleGroupItem>
            <ToggleGroupItem value="week" size="sm" className="min-h-[var(--target-min)] px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">Week</ToggleGroupItem>
            <ToggleGroupItem value="month" size="sm" className="min-h-[var(--target-min)] px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">Month</ToggleGroupItem>
          </ToggleGroup>
          {/* "By date" / "By person": no other radio's name may contain "Day", "Week" or "Month" (e2e finds the view switch by those names). */}
          {view === 'week' && !isPhone && canViewChores && (
            <ToggleGroup type="single" value={weekLayout} onValueChange={(v) => v && setWeekLayout(v as 'days' | 'people')} aria-label="Week layout" className="rounded-md border p-0.5">
              <ToggleGroupItem value="days" size="sm" className="min-h-[var(--target-min)] px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">By date</ToggleGroupItem>
              <ToggleGroupItem value="people" size="sm" className="min-h-[var(--target-min)] px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"><Users aria-hidden className="mr-1 h-4 w-4" />By person</ToggleGroupItem>
            </ToggleGroup>
          )}
          {canSkip && canViewChores && (
            <AwayDialog today={today} count={(from, to) => awayList(from, to).length} onSkip={(from, to) => skip(awayList(from, to), `Repeating chores from ${format(dayFromKey(from), 'MMM d')} to ${format(dayFromKey(to), 'MMM d')} are skipped.`)} />
          )}
          <Button variant="outline" className="min-h-[var(--target-min)]" asChild>
            <Link href="/chores"><ListChecks className="mr-2 h-4 w-4" /> Chores</Link>
          </Button>
        </div>
      </div>

      {errorList.length > 0 && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/50 bg-card p-3 text-sm text-foreground">
          <AlertTriangle aria-hidden className="h-4 w-4 shrink-0 text-destructive" />
          {/* Kiosks may have no reload control (CA-18): listeners retry on their own, and on demand. */}
          <span className="min-w-0 flex-1">{errorList.join(' ')} Retrying automatically.</span>
          <Button type="button" variant="outline" size="sm" className="min-h-[var(--target-min)]" onClick={retryAll}><RefreshCw aria-hidden className="mr-2 h-4 w-4" /> Try again</Button>
        </div>
      )}
      {stillLoading > 0 && errorList.length === 0 && (
        <p className="text-sm text-muted-foreground" role="status">Loading {Object.entries(statuses).filter(([, s]) => s === 'loading').map(([name]) => name).join(', ')}…</p>
      )}

      {nothingVisible ? (
        <div className="rounded-xl border bg-card shadow-raised">
          <EmptyState title="Nothing to show" description="Your role cannot see chores, maintenance, pets or the pantry. Ask a household admin if that seems wrong." />
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[16rem_minmax(0,1fr)]">
          {/* Below 1280 px (tablets) the rail and key are a slim strip above the calendar (CA-9). */}
          <aside aria-labelledby="overdue-rail-title" className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] xl:block xl:space-y-4">
            <section className="min-w-0 rounded-xl border border-l-4 border-l-destructive bg-card p-3 shadow-raised">
              <h2 id="overdue-rail-title" className="mb-2 flex items-center gap-2 font-headline text-base font-semibold text-foreground">
                <AlertTriangle aria-hidden className="h-4 w-4 text-destructive" /> <span>Overdue (<NumberTicker value={rail.length} animateOnMount={false} />)</span>
              </h2>
              {rail.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing is overdue.</p>
              ) : (
                <ul className="flex gap-2 overflow-x-auto pb-1 xl:max-h-[24rem] xl:flex-col xl:overflow-y-auto xl:overflow-x-visible">
                  {rail.map(event => (
                    <li key={event.id} className="flex min-w-[14rem] items-start gap-1 xl:min-w-0">
                      <div className="min-w-0 flex-1">
                        {chip(event, { withDate: true })}
                        <p className="mt-0.5 truncate px-1 text-xs text-muted-foreground">{event.subtitle} · due {format(dayFromKey(event.day), 'MMM d')}{event.foldedCount ? ` · missed ${event.foldedCount}×` : ''}</p>
                      </div>
                      {doneButton(event)}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {(members.length > 0 || kindOptions.length > 1) && (
              <section aria-label="Key and filters" className="rounded-xl border bg-card p-3 shadow-raised">
                {canViewChores && members.length > 0 && (
                  <ul className="flex flex-wrap gap-x-2 gap-y-1 xl:flex-col" aria-label="Show one person's chores">
                    {members.map(member => (
                      <li key={member.uid}>
                        {/* Tap a person for only their chores (CA-24); tap again for everyone. */}
                        <button type="button" aria-pressed={onlyMember === member.uid} onClick={() => setOnlyMember(current => (current === member.uid ? null : member.uid))}
                          className={cn('flex min-h-[var(--target-min)] items-center gap-2 rounded-md px-1.5 text-sm text-foreground', onlyMember === member.uid && 'bg-primary/10 ring-1 ring-primary')}>
                          <MemberAvatar uid={member.uid} name={member.name} photoUrl={member.avatarUrl} color={colors.get(member.uid)} size="sm" decorative />
                          {member.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm text-foreground xl:flex-col" aria-label="Key">
                  {canViewMaintenance && <li className="flex items-center gap-2"><Wrench aria-hidden className="h-4 w-4 text-info" /> Maintenance due</li>}
                  {canViewPets && <li className="flex items-center gap-2"><Pill aria-hidden className="h-4 w-4 text-success" /> Medication given</li>}
                  {canViewPets && <li className="flex items-center gap-2"><Pill aria-hidden className="h-4 w-4 text-warning" /> Medication due</li>}
                  <li className="flex items-center gap-2"><span aria-hidden className="h-4 w-4 rounded-sm border-2 border-dashed border-muted-foreground" /> Dashed: planned</li>
                  <li className="flex items-center gap-2"><span aria-hidden className="h-4 w-1 rounded-sm bg-destructive" /> Red edge: overdue</li>
                </ul>
                {kindOptions.length > 1 && (
                  <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Show">
                    {kindOptions.map(kind => (
                      <button key={kind} type="button" aria-pressed={kinds.has(kind)} onClick={() => setKinds(current => { const next = new Set(current); if (next.has(kind)) next.delete(kind); else next.add(kind); return next; })}
                        className={cn('min-h-[var(--target-min)] rounded-full border px-3 text-sm', kinds.has(kind) ? 'border-primary bg-primary/10 text-foreground' : 'text-muted-foreground')}>
                        {KIND_FILTERS[kind]}
                      </button>
                    ))}
                  </div>
                )}
              </section>
            )}
          </aside>

          <div className="min-w-0 space-y-4">
            {currentWeek && canViewChores && <FairShareStrip stats={stats} colors={colors} photos={photos} />}
            <section aria-label={view === 'day' ? title : `${view === 'week' ? 'Week' : 'Month'} of ${title}`} className="min-w-0 rounded-xl border bg-card p-3 shadow-raised md:p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="h-[var(--target-min)] w-[var(--target-min)]" aria-label={`Previous ${viewNoun}`} onClick={() => go(-1)}><ChevronLeft className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" className="h-[var(--target-min)] w-[var(--target-min)]" aria-label={`Next ${viewNoun}`} onClick={() => go(1)}><ChevronRight className="h-4 w-4" /></Button>
                  <Button variant="outline" className="min-h-[var(--target-min)]" onClick={() => go(0)}>Today</Button>
                </div>
                <p className="font-headline text-sm font-semibold text-foreground md:text-lg" aria-live="polite">{title}</p>
              </div>
              {canMove && canViewChores && view !== 'day' && (
                // Dragging is a mouse thing: touch screens move from the item's details (CA-11).
                <p className="mb-3 hidden text-xs text-muted-foreground [@media(pointer:fine)]:block">Drag a chore to another day, or open it and choose a day.</p>
              )}

              <LayoutGroup>
                <div {...swipeHandlers}>
                  {view === 'day' ? (
                    <div
                      tabIndex={0}
                      data-testid="calendar-agenda"
                      data-day={selectedDay}
                      aria-label={`${format(dayFromKey(selectedDay), 'EEEE, MMMM d')}${selectedDay === today ? ', today' : ''}, ${agendaEvents.length} item${agendaEvents.length === 1 ? '' : 's'}. Left and right arrow keys change the day.`}
                      onKeyDown={(e) => {
                        // Only on the agenda itself, never while a chip or field inside has focus.
                        if (e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
                        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                          e.preventDefault();
                          go(e.key === 'ArrowLeft' ? -1 : 1);
                        }
                      }}
                      className={cn(dayCellClass(selectedDay), 'min-h-[16rem] overflow-hidden p-3')}
                    >
                      <motion.div
                        key={selectedDay}
                        initial={reduced || dayShift === 0 ? false : { opacity: 0, x: dayShift * 16 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: DURATION.ui, ease: EASE.standard }}
                      >
                        <p className={cn('mb-3 flex items-baseline gap-2 font-semibold', selectedDay === today ? 'text-primary' : 'text-muted-foreground')} aria-hidden>
                          <span className="text-sm">{format(dayFromKey(selectedDay), 'EEEE')}</span>
                          <span className="text-2xl text-foreground">{format(dayFromKey(selectedDay), 'd')}</span>
                          <span className="text-sm">{format(dayFromKey(selectedDay), 'MMMM')}</span>
                          {selectedDay === today && <span className="ml-auto rounded-full bg-primary px-2 text-sm text-primary-foreground">Today</span>}
                        </p>
                        {agendaEvents.length > 0 ? (
                          <Stagger as="ol" key={selectedDay} className="flex flex-col gap-1.5" aria-label="Agenda">
                            {agendaEvents.map(e => (
                              <StaggerItem as="li" key={e.id} className="flex items-start gap-2">
                                <div className="min-w-0 flex-1">
                                  {chip(e)}
                                  <p className="mt-0.5 truncate px-1 text-xs text-muted-foreground">{e.subtitle}{(() => { const s = e.medicationDue ? e.medicationDue.label : e.overdue ? 'Overdue' : e.completed && e.kind === 'chore' ? 'Done' : e.planned ? 'Planned' : null; return s ? ` · ${s}` : ''; })()}</p>
                                </div>
                                {doneButton(e)}
                              </StaggerItem>
                            ))}
                          </Stagger>
                        ) : (
                          <p className="text-sm text-muted-foreground">Nothing planned.</p>
                        )}
                      </motion.div>
                      <p className="mt-4 text-xs text-muted-foreground md:hidden" aria-hidden>Swipe left or right for another day.</p>
                    </div>
                  ) : view === 'week' && weekLayout === 'people' && !isPhone ? (
                    // Per-person lanes (CA-21, owns CH-14): a row per member and one for the house.
                    <div className="overflow-x-auto" data-testid="calendar-lanes">
                      <table className="w-full table-fixed border-separate border-spacing-1">
                        <caption className="sr-only">Who does what this week</caption>
                        <thead>
                          <tr>
                            <th scope="col" className="w-32 text-left text-sm font-semibold text-muted-foreground">Who</th>
                            {visibleDays.map((day, i) => (
                              <th key={day} scope="col" className={cn('text-left text-sm font-semibold', day === today ? 'text-primary' : 'text-muted-foreground')}>
                                <span className="sr-only">{format(dayFromKey(day), 'EEEE, MMMM d')}</span>
                                <span aria-hidden>{weekdayNames[i]} {format(dayFromKey(day), 'd')}</span>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {lanes.map(lane => (
                            <tr key={lane.key}>
                              <th scope="row" className="align-top text-left text-sm font-medium text-foreground">
                                <span className="flex items-center gap-2">
                                  {lane.memberUid ? <MemberAvatar uid={lane.memberUid} name={lane.label} photoUrl={photos.get(lane.memberUid)} color={colors.get(lane.memberUid)} size="sm" decorative /> : <Wrench aria-hidden className="h-4 w-4 text-info" />}
                                  <span className="min-w-0 break-words">{lane.label}</span>
                                </span>
                              </th>
                              {visibleDays.map(day => (
                                <td key={day} className={cn(dayCellClass(day), 'align-top p-1')} {...dropProps(day)}>
                                  <div className="flex flex-col gap-1">{(lane.byDay.get(day) ?? []).map(e => chip(e))}</div>
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : view === 'week' ? (
                    // The week fits the screen: busy days scroll inside their cell or open the day (CA-14).
                    <ol className="grid gap-2 md:grid-cols-7 md:[&>li]:max-h-[max(16rem,calc(100dvh-20rem))] md:[&>li]:overflow-y-auto">
                      {visibleDays.map((day, i) => weekCell(day, i, byDay.get(day) || []))}
                    </ol>
                  ) : (
                    <div>
                      <div role="grid" aria-label={`${format(dayFromKey(anchor), 'MMMM yyyy')}. Arrow keys move between days.`}>
                        <div role="row" className="grid grid-cols-7 gap-1 pb-1">
                          {weekdayNames.map(label => <span role="columnheader" key={label} className="text-center text-sm font-semibold text-muted-foreground">{label}</span>)}
                        </div>
                        {monthDays.map(week => (
                          <div role="row" key={week[0]} className="mb-1 grid grid-cols-7 gap-1">
                            {week.map(day => {
                              const dayEvents = byDay.get(day) || [];
                              const inMonth = isSameMonth(day, anchor);
                              const hidden = dayEvents.length - 3;
                              const tabStop = monthDays.flat().includes(focusDay) ? focusDay : selectedDay;
                              return (
                                // The whole cell selects its day (CA-9); its button is the one keyboard stop.
                                <div role="gridcell" key={day} aria-selected={selectedDay === day}
                                  onClick={(e) => {
                                    // Clicks inside a chip's details panel bubble here through the portal: ignore them.
                                    if (!e.currentTarget.contains(e.target as Node) || (e.target as HTMLElement).closest('[data-calendar-chip]')) return;
                                    selectMonthDay(day);
                                  }}
                                  className={cn(dayCellClass(day), 'flex min-h-[3.5rem] cursor-pointer flex-col gap-1 p-1 md:min-h-[7rem]', !inMonth && 'bg-background', selectedDay === day && 'border-primary')} {...dropProps(day)}>
                                  <button
                                    type="button"
                                    data-day-button={day}
                                    tabIndex={day === tabStop ? 0 : -1}
                                    onClick={(e) => { e.stopPropagation(); selectMonthDay(day); }}
                                    onKeyDown={(e) => monthKeyDown(e, day)}
                                    aria-label={`${format(dayFromKey(day), 'EEEE, MMMM d')}${day === today ? ', today' : ''}, ${dayEvents.length} item${dayEvents.length === 1 ? '' : 's'}`}
                                    className={cn('flex min-h-[var(--target-min)] items-center justify-between rounded px-1 text-sm font-semibold', day === today ? 'text-primary' : inMonth ? 'text-foreground' : 'text-muted-foreground')}
                                  >
                                    {format(dayFromKey(day), 'd')}
                                    {dayEvents.length > 0 && (
                                      <span aria-hidden className="flex gap-0.5 md:hidden">
                                        {dayEvents.slice(0, 3).map(e => (
                                          <span key={e.id} className={cn('h-1.5 w-1.5 rounded-full', e.overdue ? 'bg-destructive' : e.kind === 'maintenance' ? 'bg-info' : e.kind === 'medication' || e.kind === 'care' ? 'bg-success' : e.kind === 'pantry' ? 'bg-warning' : (e.memberUid ? colors.get(e.memberUid)?.classes.bg : 'bg-primary'))} />
                                        ))}
                                      </span>
                                    )}
                                  </button>
                                  <div className="hidden flex-col gap-1 md:flex">
                                    {/* Not tab stops (CA-19): the keyboard reaches a day's items in its list below the grid. */}
                                    {dayEvents.slice(0, 3).map(e => chip(e, { animateMove: true, tabbable: false }))}
                                    {hidden > 0 && (
                                      <span className="flex min-h-[var(--target-min)] items-center rounded px-1 text-left text-sm font-medium text-primary">+{hidden} more</span>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                      <div ref={monthDetail} className="mt-4 scroll-mt-24 border-t pt-3" data-testid="calendar-month-detail">
                        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
                          <CalendarDays aria-hidden className="h-4 w-4" /> {format(dayFromKey(selectedDay), 'EEEE, MMMM d')}
                        </h2>
                        {agendaEvents.length > 0 ? (
                          <Stagger key={selectedDay} className="grid gap-1 sm:grid-cols-2">
                            {agendaEvents.map(e => <StaggerItem key={e.id} className="flex min-w-0 items-start gap-2"><div className="min-w-0 flex-1">{chip(e)}</div>{doneButton(e)}</StaggerItem>)}
                          </Stagger>
                        ) : (
                          <p className="text-sm text-muted-foreground">Nothing planned.</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </LayoutGroup>
              {allEvents.length === 0 && stillLoading === 0 && (
                <EmptyState
                  compact
                  kind="chores"
                  headingLevel={2}
                  title="Your calendar is empty"
                  description="Chores, maintenance due dates, medication and pantry dates show up here as they are added."
                  action={canViewChores ? { label: 'Go to Chores', href: '/chores' } : undefined}
                />
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
