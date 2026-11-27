'use client';

import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react';
import { onDataChanged } from '@/lib/data-changed';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { AlarmClock, CalendarDays, CheckSquare, ChevronDown, Filter, Home, ListChecks, MoreVertical, Plus, Repeat, RotateCw, Trophy, User as UserIcon } from 'lucide-react';
import { type DocumentData, type DocumentReference, type Transaction, arrayRemove, arrayUnion, collection, deleteField, doc, getDoc, getDocs, query, runTransaction, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore';
import { assigneeFields, resolveAssigneeUid } from '@functions/shared/assignee';
import { localDay, safeTimeZone } from '@functions/shared/calendar';
import { withSkippedOccurrences } from '@functions/shared/skips';
import { isGeneratedInstance, isUpcomingInstance, roomDeletionPlan, skipsForDeletion } from '@/lib/chores/recurrence-edits';
import { approvedPeople, type HouseholdPerson } from '@/lib/member-directory';
import { format } from 'date-fns';
import type { ChoreTemplate, Recurrence, Room } from '@/lib/types';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToastAction } from '@/components/ui/toast';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/empty-state';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { UNDO_WINDOW_MS } from '@/lib/undo-window';
import { syncHouseholdUpkeep } from '@/app/chores/actions';
import { auth, db } from '@/lib/firebase';
import { buildNotificationDocument, getDeterministicNotificationId } from '@/lib/notifications';
import { playFeedback } from '@/lib/feedback';
import { memberColorMap } from '@/lib/member-colors';
import { addDaysToKey, choreDueKey, completionInstant, dayFromKey, dayKey, type ChoreRecord } from '@/lib/chores/dates';
import { choreCapabilities, collapseMissedRecurring, confettiCount, isToDoClear, matchesWhoFilter, newChoreDocId, openSubTasks, type ToDoEntry } from '@/lib/chores/list';
import { completerLabel } from '@/lib/chores/completion';
import { mayReopen } from '@/lib/chores/completion';
import { CHORE_UNDO_MS, completeChoresOnServer, completedChoreFields, completionFailureMessage, reopenChoreOnServer, reopenedChoreFields, undoCompletionOnServer, undoTicket, type UndoTicket } from '@/lib/chores/complete-client';
import { closedWeekSummary, computeChoreStats, podiumWeekStart, statsMemberFrom } from '@/lib/chores/stats';
import { AddChoreDialog, AssignChoresDialog, ChoreLibraryDialog, ManageRoomsDialog, RecurringChoresDialog, type AddChoreInput, type AssignSchedule } from '@/components/chores/chore-dialogs';
import { normalizeRecurrence } from '@/components/chores/recurrence-fields';
import { ChoreList } from '@/components/chores/chore-list';
import { ChoreLeaderboard } from '@/components/chores/chore-leaderboard';
import { HouseCleanMoment } from '@/components/chores/house-clean-moment';
import { PersonDoneMoment } from '@/components/chores/person-done-moment';
import { householdDayZone } from '@/lib/household-day';
import { useConfetti } from '@/components/chores/confetti';
import { RoomIcon } from '@/components/chores/room-icons';
import { useChoreSettings } from '@/components/chores/use-chore-settings';
import { useChoreLiveData } from '@/components/chores/use-chore-live-data';
import { mergeLiveRows } from '@/lib/chores/live';
import { MissedRecently } from '@/components/chores/missed-recently';
import { useMissedEntries } from '@/components/chores/use-missed-entries';
import { useHouseholdToday } from '@/components/chores/use-today';
import { applyRefreshedChores, applyUndoSettlement, completionFields, restoreChoreFields, settleUndo } from '@/lib/chores/patch';
import { memberName } from '@/components/chores/assignee-select';
import { SignInPrompt } from '@/components/profile/sign-in-prompt';
import { morphStyle } from '@/lib/motion';
import { NumberTicker } from '@/components/motion/number-ticker';
import { pluralize } from '@/lib/shopping/items';
import { ShortcutHint } from '@/components/ui/shortcut-hint';
import { ALL_ROOMS, choresFiltersHref, choresFiltersKey, effectiveChoresRoom, parseChoresFilters, roomSharedId, type ChoresFilters } from '@/lib/chores/url-state';
import { cleanHouseRooms, houseCleanShown, houseCleanStorageKey, markHouseCleanShown, ownListCleared, personDoneStorageKey, personDoneTitle, type CleanRoom } from '@/lib/chores/house-clean';


/** End of `today` (local), so every completion made today counts and the week is today's week. */
const statsNow = (today: string) => { const d = dayFromKey(today); d.setHours(23, 59, 59, 999); return d; };

/**
 * Reads candidate chores inside the transaction and keeps those still open, so a
 * completion committed after the candidates were listed is never deleted (all
 * reads happen before the transaction's writes).
 */
async function stillOpen(transaction: Transaction, refs: DocumentReference[]) {
  const snaps = await Promise.all(refs.map(ref => transaction.get(ref)));
  return snaps.filter(snap => snap.exists() && snap.get('isCompleted') !== true);
}

/** How long after a change to repeats upkeep waits, so several edits share one run. */
const UPKEEP_DEBOUNCE_MS = 1500;

/** One name for chores without a room, everywhere (CH-23), and one for a room that was removed. */
export const AROUND_THE_HOUSE = 'Around the house';
export const REMOVED_ROOM = 'Removed room';

/** At most this long after a write settles, the page's version of its row gives way to the listener's. */
const SETTLE_WAIT_MS = 5000;

const REOPEN_REFUSED = 'Only the person who did it, the person it is assigned to, or someone who can edit chores can reopen it.';

export function ChoreChartClient() {
  const { currentUser, currentMember, household, permissions } = useAuth();
  // Completion eligibility follows the household's day, as on the server (CH-2); so do
  // skips and repeat edits (CH-3, CH-4).
  const householdDay = useHouseholdToday(household?.timeZone);
  /** The household day a completion instant falls on (CH-10: never the device's day). */
  const householdDayOf = (instant: Date) => localDay(instant, safeTimeZone(household?.timeZone));
  const { toast, toastError } = useToast();
  const capabilities = useMemo(() => choreCapabilities(permissions), [permissions]);
  const isManager = currentMember?.role === 'owner' || currentMember?.role === 'admin';
  const { settings, setLeaderboardEnabled } = useChoreSettings(currentUser?.householdId);
  const { burst, layer: confettiLayer } = useConfetti();

  const [assignedChores, setAssignedChores] = useState<ChoreRecord[]>([]);
  const [choreTemplates, setChoreTemplates] = useState<ChoreTemplate[]>([]);
  const [householdUsers, setHouseholdUsers] = useState<HouseholdPerson[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [isMounted, setIsMounted] = useState(false);

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [roomsDialog, setRoomsDialog] = useState<{ open: boolean; startNew: boolean }>({ open: false, startNew: false });
  const [isRecurringOpen, setIsRecurringOpen] = useState(false);
  const [isAssignOpen, setIsAssignOpen] = useState(false);
  const [templatesToAssign, setTemplatesToAssign] = useState<ChoreTemplate[]>([]);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedChoreIds, setSelectedChoreIds] = useState<string[]>([]);
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [choresPendingCompletion, setChoresPendingCompletion] = useState<ChoreRecord[] | null>(null);
  const [choreToDelete, setChoreToDelete] = useState<ChoreRecord | null>(null);
  // CH-6: reopening asks first; it takes the completer's points away.
  const [choreToReopen, setChoreToReopen] = useState<ChoreRecord | null>(null);
  const [houseClean, setHouseClean] = useState<CleanRoom[] | null>(null);
  const [personDone, setPersonDone] = useState<string | null>(null);

  const [showFullHistory, setShowFullHistory] = useState(false);
  const [showFullFuture, setShowFullFuture] = useState(false);
  // The filters live in the URL (`/chores?room=kitchen&due=overdue&who=me`), read on
  // every render so dashboard links, Back/Forward, reload and client navigation stay in sync.
  const searchParams = useSearchParams();
  const pathname = usePathname() || '/chores';
  const filters = parseChoresFilters(searchParams);
  const requestedRoomId = filters.room;
  const setFilters = useCallback((change: Partial<ChoresFilters>) => {
    const href = choresFiltersHref(pathname, new URLSearchParams(window.location.search), change);
    if (href === `${window.location.pathname}${window.location.search}`) return;
    // Shallow update: Next.js syncs useSearchParams with history.replaceState.
    window.history.replaceState(null, '', href);
  }, [pathname]);
  const setFilterRoomId = useCallback((roomId: string) => setFilters({ room: roomId }), [setFilters]);

  // Chores that already celebrated in this visit: confetti never fires twice for one chore.
  const celebrated = useRef(new Set<string>());
  const choresRef = useRef<ChoreRecord[]>([]);
  useEffect(() => { choresRef.current = assignedChores; }, [assignedChores]);

  useEffect(() => { setIsMounted(true); }, []);

  const roomsById = useMemo(() => new Map(rooms.map(room => [room.id, room])), [rooms]);
  const usersByUid = useMemo(() => new Map(householdUsers.map(user => [user.uid, user])), [householdUsers]);
  const memberColors = useMemo(() => memberColorMap(householdUsers.map(user => ({ uid: user.uid, joinedAt: user.joinedAt }))), [householdUsers]);

  const getCollectionRef = useCallback((collectionName: string) => {
    if (!currentUser?.householdId) return null;
    return collection(db, 'households', currentUser.householdId, collectionName);
  }, [currentUser]);

  // Live data (CH-1): every collection the page shows is a listener, so completions,
  // new chores and reassignments from other devices, quick add and upkeep appear on
  // their own. Upkeep runs on the server in the background, never before the first
  // render (CH-17).
  const liveKey = currentUser?.householdId && currentUser.uid ? `${currentUser.householdId}|${currentUser.uid}` : null;
  const live = useChoreLiveData(currentUser?.householdId, liveKey);
  // Chores with a write in flight keep this page's optimistic version until it settles
  // (`mergeLiveRows`), so an unrelated snapshot never flips a just-ticked row back.
  // After the write settles, the row keeps the page's version (the handler applied the
  // server's answer) until the listener delivers a newer snapshot, which reflects the write.
  const held = useRef(new Map<string, number>());
  const settledAt = useRef(new Map<string, { snapshot: unknown; until: number }>());
  // Re-merges when a settled row's wait runs out (no newer snapshot came).
  const [settleTick, setSettleTick] = useState(0);
  const liveChoreDocs = useRef<unknown>(null);
  useEffect(() => { liveChoreDocs.current = live.state.docs.chores; }, [live.state.docs.chores]);
  const hold = useCallback((ids: readonly string[]) => {
    ids.forEach(id => {
      held.current.set(id, (held.current.get(id) ?? 0) + 1);
      settledAt.current.delete(id);
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      ids.forEach(id => {
        const left = (held.current.get(id) ?? 1) - 1;
        if (left > 0) {
          held.current.set(id, left);
          return;
        }
        held.current.delete(id);
        settledAt.current.set(id, { snapshot: liveChoreDocs.current, until: Date.now() + SETTLE_WAIT_MS });
      });
      window.setTimeout(() => setSettleTick(tick => tick + 1), SETTLE_WAIT_MS + 50);
    };
  }, []);

  useEffect(() => {
    const docs = live.state.docs;
    if (!currentUser || !docs.members || !docs.chores || !docs['chore-templates'] || !docs.rooms) return;
    // Assignees are the approved membership records: their public fields (name, photo,
    // role) are all this page shows. Housemates' profiles are never read.
    const usersData = approvedPeople(docs.members)
      // The viewer always knows their own email, which matches their older chores.
      .map(person => person.uid === currentUser.uid ? { ...person, email: person.email || currentUser.email || '' } : person);
    setHouseholdUsers(usersData);
    // Assignees are resolved here (uid, or the email of older records) and kept in memory
    // as `assignedToUid`; see functions/src/shared/assignee.ts.
    setChoreTemplates(docs['chore-templates'].map(d => {
      const template = { id: d.id, ...d.data } as ChoreTemplate;
      return { ...template, assignedToUid: resolveAssigneeUid(template, usersData) };
    }).sort((a, b) => a.task.localeCompare(b.task)));
    setRooms(docs.rooms.map(d => ({ id: d.id, ...d.data } as Room)).sort((a, b) => a.name.localeCompare(b.name)));
    const serverChores = docs.chores.map(d => {
      const chore = { id: d.id, ...d.data } as ChoreRecord;
      const assignedToUid = resolveAssigneeUid(chore, usersData) || '';
      const user = usersData.find(u => u.uid === assignedToUid);
      return { ...chore, assignedToUid, assignedToDisplayName: user?.displayName || chore.assignedToDisplayName || 'Unassigned' };
    });
    // Settled writes stop being kept once a newer snapshot than the one at release arrived.
    // (or after SETTLE_WAIT_MS at most, so a snapshot that already held the write and
    // another device's change can never stay hidden in a quiet household).
    const now = Date.now();
    for (const [id, settled] of settledAt.current) {
      if (settled.snapshot !== docs.chores || now >= settled.until) settledAt.current.delete(id);
    }
    setAssignedChores(previous => mergeLiveRows(serverChores, previous, new Set([...held.current.keys(), ...settledAt.current.keys()])));
  }, [live.state, currentUser, settleTick]);

  const loading = Boolean(liveKey) && live.status === 'loading';

  // Recurring chores, retention and reminders run on the server (hourly, and here on
  // demand) so every household member sees the same schedule. On demand means once on
  // opening and shortly after a change to repeats (debounced), in the background: the
  // generated chores arrive through the listener.
  const upkeepTimer = useRef<number | undefined>(undefined);
  const runUpkeep = useCallback(async () => {
    const householdId = currentUser?.householdId;
    const firebaseUser = auth.currentUser;
    if (!householdId || !firebaseUser) return;
    await syncHouseholdUpkeep({ idToken: await firebaseUser.getIdToken(), householdId })
      .catch(syncError => console.warn('Household upkeep could not run.', syncError));
  }, [currentUser?.householdId]);
  const requestUpkeep = useCallback(() => {
    window.clearTimeout(upkeepTimer.current);
    upkeepTimer.current = window.setTimeout(() => void runUpkeep(), UPKEEP_DEBOUNCE_MS);
  }, [runUpkeep]);
  useEffect(() => {
    void runUpkeep();
    return () => window.clearTimeout(upkeepTimer.current);
  }, [runUpkeep]);

  // Chores created elsewhere (the command palette's quick add) arrive through the
  // listener; a new repeating chore also needs upkeep to generate its days.
  useEffect(() => {
    const householdId = currentUser?.householdId;
    if (!householdId) return;
    return onDataChanged('chores', householdId, requestUpkeep);
  }, [currentUser?.householdId, requestUpkeep]);

  // Chore reminders are sent by the server (functions/src/reminders.ts), not
  // by whichever browser happens to have this page open.

  const patchChores = useCallback((ids: readonly string[], patch: (chore: ChoreRecord) => ChoreRecord) => {
    const idSet = new Set(ids);
    setAssignedChores(previous => previous.map(chore => (idSet.has(chore.id) ? patch(chore) : chore)));
  }, []);

  /** Assignment notifications go to other people only, never to yourself. */
  const shouldNotify = useCallback((uid: string) => uid !== currentUser?.uid, [currentUser?.uid]);

  /* ---------------------------------------------------------------------- */
  /* Creating                                                                */
  /* ---------------------------------------------------------------------- */

  const handleCreateChore = useCallback(async (input: AddChoreInput) => {
    if (!currentUser?.householdId) return false;
    const choresCollection = getCollectionRef('chores');
    const templatesCollection = getCollectionRef('chore-templates');
    const notificationsCollection = getCollectionRef('notifications');
    if (!choresCollection || !templatesCollection || !notificationsCollection) return false;
    const assignee = householdUsers.find(user => user.uid === input.assigneeUid);
    if (!assignee) {
      toastError({ code: 'not-found' }, "Couldn't add the chore");
      return false;
    }
    const assigneeName = memberName(assignee);
    const roomIds = input.roomId === 'general' ? [] : [input.roomId];

    try {
      if (!input.repeat) {
        // One-time: a direct chore plus (for someone else) its assignment notification, atomically.
        const choreRef = doc(choresCollection);
        // Keyed by uid: notification state keys are readable by every member.
        const stateKey = `assigned|${input.dueDate}|${assignee.uid}`;
        const batch = writeBatch(db);
        batch.set(choreRef, {
          task: input.task,
          notes: input.notes,
          ...assigneeFields(assignee),
          assignedToDisplayName: assigneeName,
          dueDate: new Date(`${input.dueDate}T12:00:00`).toISOString(),
          originalDueDate: input.dueDate,
          roomIds,
          isCompleted: false,
          completedSubTasks: [],
          sourceType: 'temporary',
          // CH-20: a one-time chore you add for yourself earns no points.
          createdByUid: currentUser.uid,
        });
        if (shouldNotify(assignee.uid)) {
          const notificationId = getDeterministicNotificationId({ sourceType: 'chore-assignment', sourceId: choreRef.id, stateKey });
          batch.set(doc(notificationsCollection, notificationId), buildNotificationDocument({
            householdId: currentUser.householdId,
            category: 'chores',
            title: 'New chore assigned',
            message: `You have a new chore: ${input.task}. Due ${format(new Date(`${input.dueDate}T12:00:00`), 'MMM d, yyyy')}.`,
            deepLink: '/chores',
            sourceType: 'chore-assignment',
            sourceId: choreRef.id,
            stateKey,
            targetUser: assignee,
          }));
        }
        await batch.commit();
      } else {
        // Readable slug + auto-id: never collides with a template this page has not seen.
        const templateId = newChoreDocId(input.task, doc(templatesCollection).id);
        const recurrence: Recurrence = { ...input.recurrence };
        await setDoc(doc(templatesCollection, templateId), {
          task: input.task,
          notes: input.notes,
          roomIds,
          subTasks: [],
          recurrence,
          ...assigneeFields(assignee),
        });
        if (shouldNotify(assignee.uid)) {
          await setDoc(doc(notificationsCollection), buildNotificationDocument({
            householdId: currentUser.householdId,
            category: 'chores',
            title: 'New chore assigned',
            message: `You have a new repeating chore: ${input.task}.`,
            deepLink: '/chores',
            sourceType: 'chore-assignment',
            sourceId: templateId,
            targetUser: assignee,
          })).catch(error => console.warn('Chore saved, but the notification failed:', error instanceof Error ? error.message : String(error)));
        }
      }
      playFeedback('add');
      toast({ title: 'Chore added', description: `${input.task} is on ${assignee.uid === currentUser.uid ? 'your' : `${assigneeName}'s`} list.` });
      requestUpkeep();
      return true;
    } catch (error) {
      toastError(error, "Couldn't add the chore");
      return false;
    }
  }, [currentUser, getCollectionRef, householdUsers, shouldNotify, toast, toastError, requestUpkeep]);

  const handleSaveChoreTemplate = async (choreData: Partial<ChoreTemplate>, id?: string) => {
    const templatesCollection = getCollectionRef('chore-templates');
    const choresCollection = getCollectionRef('chores');
    if (!templatesCollection || !choresCollection) return false;
    const templateId = id || newChoreDocId(choreData.task || '', doc(templatesCollection).id);
    const templateRef = doc(templatesCollection, templateId);
    try {
      const listed = id ? await getDocs(query(choresCollection, where('templateId', '==', id), where('isCompleted', '==', false))) : null;
      await runTransaction(db, async (transaction) => {
        const oldTemplateSnap = await transaction.get(templateRef);
        if (!id) {
          // A create never merges into (or overwrites) an existing template.
          if (oldTemplateSnap.exists()) throw new Error('A chore with this ID already exists. Try again.');
          transaction.set(templateRef, choreData);
          return;
        }
        const oldTemplate = oldTemplateSnap.exists() ? oldTemplateSnap.data() as ChoreTemplate : null;
        const openChores = await stillOpen(transaction, listed?.docs.map(choreDoc => choreDoc.ref) ?? []);
        transaction.set(templateRef, choreData, { merge: true });
        const removedRoomIds = oldTemplate?.roomIds && choreData.roomIds ? oldTemplate.roomIds.filter(roomId => !choreData.roomIds!.includes(roomId)) : [];
        openChores.forEach(choreDoc => {
          const chore = choreDoc.data() as ChoreRecord;
          if (removedRoomIds.length > 0 && isGeneratedInstance({ ...chore, id: choreDoc.id }) && chore.roomIds?.some(roomId => removedRoomIds.includes(roomId))) {
            transaction.delete(choreDoc.ref);
          } else {
            // Ticks of steps the template no longer has go too (CH-10).
            const steps = choreData.subTasks ?? [];
            const ticked = (choreDoc.get('completedSubTasks') as unknown[] | undefined ?? []).filter((step): step is string => typeof step === 'string' && steps.includes(step));
            transaction.update(choreDoc.ref, { task: choreData.task, notes: choreData.notes, subTasks: choreData.subTasks, completedSubTasks: ticked });
          }
        });
      });
      toast({ title: id ? 'Chore updated' : 'Saved to library' });
      requestUpkeep();
      return true;
    } catch (error) {
      toastError(error, "Couldn't save the chore");
      return false;
    }
  };

  const handleDeleteChoreTemplate = async (id: string) => {
    const templatesCollection = getCollectionRef('chore-templates');
    const choresCollection = getCollectionRef('chores');
    if (!templatesCollection || !choresCollection) return;
    try {
      const listed = await getDocs(query(choresCollection, where('templateId', '==', id), where('isCompleted', '==', false)));
      await runTransaction(db, async (transaction) => {
        const openChores = await stillOpen(transaction, listed.docs.map(choreDoc => choreDoc.ref));
        transaction.delete(doc(templatesCollection, id));
        openChores.forEach(choreDoc => transaction.delete(choreDoc.ref));
      });
      toast({ title: 'Chore deleted' });
      requestUpkeep();
    } catch (error) {
      toastError(error, "Couldn't delete the chore");
    }
  };

  const handleOpenAssignDialog = (templates: ChoreTemplate[]) => {
    setTemplatesToAssign(templates);
    setIsAssignOpen(true);
    setIsLibraryOpen(false);
  };

  const handleAssignChores = useCallback(async (assignment: { assigneeUid: string; roomIds: string[] }, schedule: AssignSchedule) => {
    if (!currentUser?.householdId || templatesToAssign.length === 0) return false;
    const templatesCollection = getCollectionRef('chore-templates');
    const choresCollection = getCollectionRef('chores');
    if (!choresCollection || !templatesCollection) return false;
    const user = householdUsers.find(u => u.uid === assignment.assigneeUid);
    if (!user) {
      toastError({ code: 'not-found' }, "Couldn't assign");
      return false;
    }
    const assignedToDisplayName = memberName(user);
    const fields = assigneeFields(user);
    const batch = writeBatch(db);
    let commit = () => batch.commit();
    if (schedule.type === 'recurring') {
      commit = async () => {
        // Open days from today on generated under the old schedule, assignee or rooms
        // are replaced: upkeep regenerates them from the new settings. Completed days stay,
        // and their occurrence keys keep upkeep from generating them again (CH-4).
        const listed = await Promise.all(templatesToAssign.map(template =>
          getDocs(query(choresCollection, where('templateId', '==', template.id), where('isCompleted', '==', false)))));
        // Overdue days stay: upkeep never regenerates a day before today.
        const generated = listed.flatMap(snap => snap.docs.filter(choreDoc => isUpcomingInstance({ id: choreDoc.id, ...choreDoc.data() }, householdDay)).map(choreDoc => choreDoc.ref));
        await runTransaction(db, async (transaction) => {
          // Re-read inside the transaction: a day completed meanwhile is kept.
          const openChores = await stillOpen(transaction, generated);
          openChores.forEach(choreDoc => transaction.delete(choreDoc.ref));
          for (const template of templatesToAssign) {
            // A merge keeps fields it does not name, so an older assignee's email (top level
            // and inside `recurrence`) is removed explicitly: it would otherwise win over the uid.
            transaction.set(doc(templatesCollection, template.id), {
              // A merge keeps keys it does not name: every optional key the new schedule
              // leaves out is deleted, so an older end date, start or option never survives.
              recurrence: {
                startDate: deleteField(), endDate: deleteField(), dailyOptions: deleteField(), weeklyOptions: deleteField(), monthlyOptions: deleteField(),
                ...schedule.recurrence,
                assignedToEmail: deleteField(),
              },
              ...fields,
              assignedToEmail: deleteField(),
              // The rooms chosen in the dialog; none chosen keeps the chore's own rooms.
              ...(assignment.roomIds.length > 0 ? { roomIds: assignment.roomIds.filter(roomId => roomId !== 'general') } : {}),
            }, { merge: true });
          }
        });
      };
    } else {
      const originalDueDate = format(schedule.dueDate, 'yyyy-MM-dd');
      for (const template of templatesToAssign) {
        const roomsToAssign = assignment.roomIds.length > 0 ? assignment.roomIds : (template.roomIds && template.roomIds.length > 0 ? template.roomIds : ['general']);
        roomsToAssign.forEach(roomId => {
          // Auto ID: a one-time assignment is its own chore. It must never share the
          // deterministic ID of a generated occurrence (or an earlier assignment), which
          // would overwrite that chore, including a moved or completed one.
          batch.set(doc(choresCollection), {
            task: template.task,
            ...fields,
            assignedToDisplayName,
            dueDate: schedule.dueDate.toISOString(),
            isCompleted: false,
            notes: template.notes || '',
            subTasks: template.subTasks || [],
            completedSubTasks: [],
            templateId: template.id,
            // One-time library assignment: never folded as a missed repeating instance.
            sourceType: 'template',
            createdByUid: currentUser.uid,
            originalDueDate,
            roomIds: roomId === 'general' ? [] : [roomId],
          });
        });
      }
    }
    try {
      await commit();
      if (shouldNotify(user.uid)) {
        try {
          await setDoc(doc(collection(db, 'households', currentUser.householdId, 'notifications')), buildNotificationDocument({
            householdId: currentUser.householdId,
            category: 'chores',
            title: templatesToAssign.length > 1 ? 'New chores assigned' : 'New chore assigned',
            message: templatesToAssign.length > 1 ? `You have been assigned ${templatesToAssign.length} new chores.` : `You have a new chore: ${templatesToAssign[0].task}.`,
            deepLink: '/chores',
            sourceType: 'chore-assignment',
            sourceId: templatesToAssign.map(template => template.id).join(','),
            targetUser: user,
          }));
        } catch (notificationError) {
          console.warn('Chore assignment saved, but notification creation failed:', notificationError instanceof Error ? notificationError.message : String(notificationError));
        }
      }
      toast(schedule.type === 'recurring'
        ? { title: 'Repeating chores set', description: 'They will show up on schedule by themselves.' }
        : { title: 'Chores assigned', description: `${templatesToAssign.length === 1 ? templatesToAssign[0].task : `${templatesToAssign.length} chores`} added to the chart.` });
      requestUpkeep();
      return true;
    } catch (error) {
      toastError(error, "Couldn't assign");
      return false;
    }
  }, [currentUser, getCollectionRef, householdUsers, templatesToAssign, shouldNotify, toast, toastError, requestUpkeep, householdDay]);

  /* ---------------------------------------------------------------------- */
  /* Rooms and repeating chores                                              */
  /* ---------------------------------------------------------------------- */

  const handleSaveRoom = async (roomData: { name: string; icon: string }, id?: string) => {
    const roomsCollection = getCollectionRef('rooms');
    if (!roomsCollection) return false;
    // New rooms: readable slug + auto-id, so a create never overwrites a room this page has not seen.
    const roomId = id || newChoreDocId(roomData.name, doc(roomsCollection).id, 'room');
    try {
      await setDoc(doc(roomsCollection, roomId), roomData);
      toast({ title: id ? 'Room updated' : 'Room added' });
      requestUpkeep();
      return true;
    } catch (error) {
      toastError(error, "Couldn't save the room");
      return false;
    }
  };

  const handleDeleteRoom = async (id: string) => {
    const roomsCollection = getCollectionRef('rooms');
    const templatesCollection = getCollectionRef('chore-templates');
    const choresCollection = getCollectionRef('chores');
    if (!roomsCollection || !templatesCollection || !choresCollection) return;
    try {
      // What happens to each chore in the room: `roomDeletionPlan` (CH-4).
      const listed = await getDocs(query(choresCollection, where('roomIds', 'array-contains', id)));
      const templateIds = [...new Set([
        ...choreTemplates.filter(t => t.roomIds?.includes(id)).map(t => t.id),
        ...listed.docs.map(choreDoc => choreDoc.get('templateId')).filter((templateId): templateId is string => typeof templateId === 'string' && templateId !== ''),
      ])];
      await runTransaction(db, async (transaction) => {
        // Read inside the transaction: a chore completed meanwhile is kept as history,
        // and templates are judged by their stored rooms.
        const fresh = await Promise.all(listed.docs.map(choreDoc => transaction.get(choreDoc.ref)));
        const templateSnaps = await Promise.all(templateIds.map(templateId => transaction.get(doc(templatesCollection, templateId))));
        const templateRooms = new Map(templateSnaps.filter(snap => snap.exists()).map(snap => {
          const rooms = snap.get('roomIds');
          return [snap.id, Array.isArray(rooms) ? rooms.filter((room): room is string => typeof room === 'string') : []] as const;
        }));
        const plan = roomDeletionPlan(fresh.filter(snap => snap.exists()).map(snap => ({ id: snap.id, ...snap.data() })), id, householdDay, templateRooms);
        transaction.delete(doc(roomsCollection, id));
        templateSnaps.forEach(snap => {
          if (!snap.exists()) return;
          const rooms = templateRooms.get(snap.id) ?? [];
          const skips = plan.skips.get(snap.id);
          if (!rooms.includes(id) && !skips) return;
          transaction.update(snap.ref, {
            roomIds: rooms.filter(roomId => roomId !== id),
            ...(skips ? { skippedOccurrences: withSkippedOccurrences(snap.get('skippedOccurrences'), skips, householdDay) } : {}),
          });
        });
        plan.remove.forEach(choreId => transaction.delete(doc(choresCollection, choreId)));
        plan.detach.forEach(({ id: choreId, roomIds }) => transaction.update(doc(choresCollection, choreId), { roomIds }));
      });
      toast({ title: 'Room deleted' });
      requestUpkeep();
    } catch (error) {
      toastError(error, "Couldn't delete the room");
    }
  };

  const replaceRecurrence = async (choreId: string, update: DocumentData, title: string, failure: string) => {
    const templatesCollection = getCollectionRef('chore-templates');
    const choresCollection = getCollectionRef('chores');
    if (!templatesCollection || !choresCollection) return false;
    try {
      // Only the series' own generated days: a one-time assignment of the same
      // library chore is its own chore and stays (CH-4).
      const listed = await getDocs(query(choresCollection, where('templateId', '==', choreId), where('isCompleted', '==', false)));
      const generated = listed.docs.filter(choreDoc => isGeneratedInstance({ id: choreDoc.id, ...choreDoc.data() }));
      await runTransaction(db, async (transaction) => {
        const openChores = await stillOpen(transaction, generated.map(choreDoc => choreDoc.ref));
        transaction.update(doc(templatesCollection, choreId), update);
        openChores.forEach(choreDoc => transaction.delete(choreDoc.ref));
      });
      toast({ title });
      requestUpkeep();
      return true;
    } catch (error) {
      toastError(error, failure);
      return false;
    }
  };

  const handleUpdateRecurringTask = async (choreId: string, assigneeUid: string, recurrence: Omit<Recurrence, 'assignedToEmail'>) => {
    const user = householdUsers.find(u => u.uid === assigneeUid);
    if (!user) {
      toastError({ code: 'not-found' }, "Couldn't update the schedule");
      return false;
    }
    // The recurrence map is replaced as a whole; the top-level legacy email is removed.
    return replaceRecurrence(choreId, { ...assigneeFields(user), assignedToEmail: deleteField(), recurrence: { ...recurrence } }, 'Repeating chore updated', "Couldn't update the schedule");
  };

  const handleDeleteRecurringTask = async (choreId: string) => {
    await replaceRecurrence(choreId, { recurrence: null, assignedToEmail: deleteField(), assignedToUid: null }, 'Stopped repeating', "Couldn't stop the schedule");
  };

  /* ---------------------------------------------------------------------- */
  /* Completing (H05)                                                        */
  /* ---------------------------------------------------------------------- */

  // The household's day everywhere on the page, as the server generates and judges (CH-10).
  const today = householdDay;

  const maybeCelebrateHouse = useCallback((before: readonly ChoreRecord[], after: readonly ChoreRecord[]) => {
    if (!currentUser?.householdId) return;
    const hadDue = !isToDoClear(before, today);
    if (!hadDue || !isToDoClear(after, today)) {
      // CH-22: your own list cleared while the house still has work.
      if (!ownListCleared(before, after, currentUser.uid, today)) return;
      const key = personDoneStorageKey(currentUser.householdId, currentUser.uid, today);
      if (houseCleanShown(key)) return;
      markHouseCleanShown(key);
      setPersonDone(personDoneTitle(currentUser.displayName));
      playFeedback('celebrate');
      return;
    }
    const key = houseCleanStorageKey(currentUser.householdId, today);
    if (houseCleanShown(key)) return;
    markHouseCleanShown(key);
    const doneToday = after.filter(chore => {
      const instant = completionInstant(chore);
      return instant && householdDayOf(instant) === today;
    });
    // Every room of the household (the whole house is clean); rooms worked in today sparkle first.
    const workedIn = new Set(doneToday.flatMap(chore => chore.roomIds || []));
    setHouseClean(cleanHouseRooms(rooms, workedIn));
    playFeedback('celebrate');
  }, [currentUser, today, rooms]);

  // Completion, Undo and reopen go through the server (complete-client.ts): it
  // refuses chores due after today and records who completed each one (H3).
  const undoCompletion = useCallback(async (tickets: readonly UndoTicket[]) => {
    const householdId = currentUser?.householdId;
    if (!householdId || tickets.length === 0) return;
    const ids = tickets.map(ticket => ticket.choreId);
    const saved = new Map(choresRef.current.filter(c => ids.includes(c.id)).map(c => [c.id, completionFields(c)]));
    const release = hold(ids);
    patchChores(ids, chore => ({ ...chore, ...reopenedChoreFields() }));
    const results = await Promise.all(tickets.map(ticket => undoCompletionOnServer(householdId, ticket))).finally(release);
    // Undone, or already reopened by someone else ('open'): the chore stays open.
    // Only a request that never ran puts back the saved completion; a chore that
    // changed since ('stale': completed again, 'missing': deleted) is re-read, as
    // the saved snapshot is outdated.
    const settled = settleUndo(ids, results);
    setAssignedChores(current => applyUndoSettlement(current, settled, saved));
    const failure = results.find(result => !result.ok);
    if (failure && !failure.ok) toast({ variant: 'destructive', title: completionFailureMessage(failure, 'undo') });
    else if (results.some(result => result.ok && result.data.status === 'refused')) toast({ variant: 'destructive', title: "Couldn't undo", description: REOPEN_REFUSED });
    if (settled.refresh.length === 0) return;
    const choresCollection = getCollectionRef('chores');
    const fresh = new Map<string, Record<string, unknown> | null>();
    if (choresCollection) {
      await Promise.all(settled.refresh.map(async id => {
        try {
          const snap = await getDoc(doc(choresCollection, id));
          fresh.set(id, snap.exists() ? snap.data() : null);
        } catch {
          // Unreadable now: fall back to the saved snapshot below.
        }
      }));
    }
    const unread = new Map(settled.refresh.flatMap(id => (!fresh.has(id) && saved.has(id) ? [[id, saved.get(id)!] as const] : [])));
    setAssignedChores(current => restoreChoreFields(applyRefreshedChores(current, fresh), unread));
    if (!failure) toast({ title: 'Already changed', description: 'Someone changed this chore since, so it was left as it is.' });
  }, [currentUser?.householdId, getCollectionRef, patchChores, toast, hold]);

  const completeChores = useCallback(async (chores: readonly ChoreRecord[], origin: DOMRect | null) => {
    const householdId = currentUser?.householdId;
    if (!householdId || chores.length === 0) return;
    const ids = chores.map(chore => chore.id);
    // Optimistic: the rows leave To Do at once; only chores the server did not complete come back.
    const before = choresRef.current;
    const saved = new Map(before.filter(c => ids.includes(c.id)).map(c => [c.id, completionFields(c)]));
    const optimistic = new Map(chores.map(chore => [chore.id, {
      isCompleted: true,
      completedAt: new Date().toISOString(),
      ...(openSubTasks(chore).length > 0 ? { completedSubTasks: [...(chore.subTasks || [])] } : {}),
    } as Partial<ChoreRecord>]));
    const release = hold(ids);
    setAssignedChores(current => restoreChoreFields(current, optimistic));
    setSelectedChoreIds(previous => previous.filter(id => !optimistic.has(id)));

    // One tap completes, including any open steps; Undo restores them.
    const result = await completeChoresOnServer(householdId, ids, { completeSubTasks: true }).finally(release);
    if (!result.ok) {
      setAssignedChores(current => restoreChoreFields(current, saved));
      toast({ variant: 'destructive', title: completionFailureMessage(result, 'complete') });
      return;
    }
    const outcomes = new Map(result.data.map(outcome => [outcome.choreId, outcome]));
    const applied = new Map<string, Partial<ChoreRecord>>();
    for (const id of ids) {
      const outcome = outcomes.get(id);
      if (outcome && outcome.status !== 'refused') applied.set(id, completedChoreFields(outcome.completion));
      else applied.set(id, saved.get(id) ?? {});
    }
    setAssignedChores(current => restoreChoreFields(current, applied));

    const completed = chores.filter(chore => outcomes.get(chore.id)?.status === 'completed');
    const already = chores.filter(chore => outcomes.get(chore.id)?.status === 'already');
    const early = chores.filter(chore => {
      const outcome = outcomes.get(chore.id);
      return outcome?.status === 'refused' && outcome.refused === 'early';
    });
    const notDone = chores.filter(chore => !outcomes.has(chore.id) || outcomes.get(chore.id)?.status === 'refused');
    if (early.length > 0) {
      const first = early[0];
      toast({
        title: early.length === 1 ? 'Not due yet' : `${pluralize(early.length, 'chore')} not due yet`,
        description: early.length === 1
          ? `${first.task} is due ${format(dayFromKey(choreDueKey(first)), 'EEE, MMM d')}. It can be completed from that day.`
          : 'Chores can be completed from the day they are due.',
      });
    } else if (notDone.length > 0) {
      toast({ variant: 'destructive', title: notDone.length === 1 ? `${notDone[0].task} was not completed.` : `${pluralize(notDone.length, 'chore')} were not completed.` });
    }
    if (already.length > 0 && completed.length === 0) {
      const outcome = outcomes.get(already[0].id);
      const by = outcome && outcome.status === 'already' ? completerLabel(outcome.completion, uid => {
        const user = usersByUid.get(uid);
        return user ? memberName(user) : undefined;
      }) : null;
      toast({ title: 'Already done', description: by ? `${already[0].task} was already done by ${by}.` : `${already[0].task} was already done.` });
    }
    if (completed.length === 0) return;

    playFeedback('complete');
    const fresh = completed.filter(chore => !celebrated.current.has(chore.id));
    fresh.forEach(chore => celebrated.current.add(chore.id));
    if (fresh.length > 0 && origin) {
      burst(origin, Math.min(40, fresh.reduce((sum, chore) => sum + confettiCount(chore), 0)));
    }

    const tickets = completed.flatMap(chore => {
      const outcome = outcomes.get(chore.id);
      const ticket = outcome && outcome.status === 'completed' ? undoTicket(outcome) : null;
      return ticket ? [ticket] : [];
    });
    const label = completed.length === 1 ? completed[0].task : `${completed.length} chores`;
    const handle = toast({
      title: completed.length === 1 ? 'Done' : 'Chores done',
      description: `${label} marked complete.`,
      duration: CHORE_UNDO_MS,
      action: (
        <ToastAction altText={`Undo completing ${label}`} onClick={() => { handle.dismiss(); void undoCompletion(tickets); }}>
          Undo
        </ToastAction>
      ),
    });
    const after = before.map(chore => (applied.has(chore.id) ? { ...chore, ...applied.get(chore.id) } as ChoreRecord : chore));
    maybeCelebrateHouse(before, after);
  }, [currentUser?.householdId, toast, burst, undoCompletion, maybeCelebrateHouse, usersByUid, hold]);

  const reopenChore = useCallback(async (chore: ChoreRecord) => {
    const householdId = currentUser?.householdId;
    if (!householdId) return;
    const saved = new Map([[chore.id, completionFields(chore)]]);
    const release = hold([chore.id]);
    patchChores([chore.id], c => ({ ...c, ...reopenedChoreFields() }));
    const result = await reopenChoreOnServer(householdId, chore.id).finally(release);
    if (!result.ok) {
      setAssignedChores(current => restoreChoreFields(current, saved));
      toast({ variant: 'destructive', title: completionFailureMessage(result, 'reopen') });
    } else if (result.data.status === 'missing') {
      setAssignedChores(current => restoreChoreFields(current, saved));
      toast({ variant: 'destructive', title: "Couldn't reopen the chore", description: 'It was deleted.' });
    } else if (result.data.status === 'refused') {
      setAssignedChores(current => restoreChoreFields(current, saved));
      toast({ variant: 'destructive', title: "Couldn't reopen the chore", description: REOPEN_REFUSED });
    }
  }, [currentUser?.householdId, patchChores, toast, hold]);

  const handleToggleDone = useCallback((chore: ChoreRecord, origin: HTMLElement | null) => {
    if (!capabilities.canComplete) return;
    if (chore.isCompleted) {
      // CH-6: only the completer, the assignee or someone who may edit chores, and only
      // after a confirmation (the server checks the same rule).
      if (!currentUser || !mayReopen(chore, { uid: currentUser.uid, email: currentUser.email }, permissions ?? {})) {
        toast({ title: "Can't reopen this chore", description: REOPEN_REFUSED });
        return;
      }
      setChoreToReopen(chore);
    }
    // Measure now: the row leaves the To Do list before the write finishes.
    else void completeChores([chore], origin?.getBoundingClientRect() ?? null);
  }, [capabilities.canComplete, completeChores, currentUser, permissions, toast]);

  const selectedChores = assignedChores.filter(chore => selectedChoreIds.includes(chore.id) && !chore.isCompleted);

  const handleCompleteSelected = () => {
    if (selectedChores.length === 0) {
      setSelectedChoreIds([]);
      return;
    }
    const withOpenSteps = selectedChores.filter(chore => openSubTasks(chore).length > 0);
    if (withOpenSteps.length > 0) {
      setChoresPendingCompletion(withOpenSteps);
      return;
    }
    void completeChores(selectedChores, null);
  };

  const handleSubTaskToggle = useCallback(async (chore: ChoreRecord, subTask: string) => {
    const choresCollection = getCollectionRef('chores');
    if (!choresCollection || !capabilities.canComplete) return;
    const current = chore.completedSubTasks || [];
    const next = current.includes(subTask) ? current.filter(st => st !== subTask) : [...current, subTask];
    const release = hold([chore.id]);
    patchChores([chore.id], c => ({ ...c, completedSubTasks: next }));
    try {
      // One step at a time, so two devices ticking different steps both count (CH-10).
      await updateDoc(doc(choresCollection, chore.id), { completedSubTasks: current.includes(subTask) ? arrayRemove(subTask) : arrayUnion(subTask) });
    } catch (error) {
      patchChores([chore.id], c => ({ ...c, completedSubTasks: current }));
      toastError(error, "Couldn't update the step");
    } finally {
      release();
    }
  }, [getCollectionRef, capabilities.canComplete, patchChores, toastError, hold]);

  const deleteChores = async (ids: string[], title: string) => {
    const choresCollection = getCollectionRef('chores');
    const templatesCollection = getCollectionRef('chore-templates');
    if (!choresCollection || !templatesCollection || ids.length === 0) return;
    const release = hold(ids);
    try {
      // Deleting a day of a repeating chore skips that day: the template records it,
      // so upkeep and the calendar never bring it back (CH-3). Other days are unchanged.
      const idSet = new Set(ids);
      const skips = skipsForDeletion(choresRef.current.filter(chore => idSet.has(chore.id)), householdDay);
      await runTransaction(db, async (transaction) => {
        const templateRefs = [...skips.keys()].map(templateId => doc(templatesCollection, templateId));
        const templateSnaps = await Promise.all(templateRefs.map(ref => transaction.get(ref)));
        templateSnaps.forEach((snap, index) => {
          if (!snap.exists()) return;
          const keys = skips.get(snap.id) ?? [];
          transaction.update(templateRefs[index], { skippedOccurrences: withSkippedOccurrences(snap.get('skippedOccurrences'), keys, householdDay) });
        });
        ids.forEach(id => transaction.delete(doc(choresCollection, id)));
      });
      toast({ title });
      setAssignedChores(previous => previous.filter(chore => !ids.includes(chore.id)));
    } catch (error) {
      toastError(error, "Couldn't delete");
    } finally {
      release();
    }
  };

  const handleReassign = useCallback(async (chore: ChoreRecord, uid: string) => {
    const choresCollection = getCollectionRef('chores');
    const user = householdUsers.find(u => u.uid === uid);
    if (!choresCollection || !user || uid === chore.assignedToUid) return;
    const updates = { ...assigneeFields(user), assignedToDisplayName: memberName(user) };
    const previous = { assignedToUid: chore.assignedToUid ?? '', assignedToEmail: chore.assignedToEmail, assignedToDisplayName: chore.assignedToDisplayName };
    const release = hold([chore.id]);
    patchChores([chore.id], c => ({ ...c, ...updates, assignedToEmail: undefined }));
    try {
      // An older assignee's email is removed: it would otherwise win over the new uid.
      await updateDoc(doc(choresCollection, chore.id), { ...updates, assignedToEmail: deleteField() });
      toast({ title: 'Chore reassigned', description: `${chore.task} is now ${memberName(user)}'s.` });
    } catch (error) {
      patchChores([chore.id], c => ({ ...c, ...previous }));
      toastError(error, "Couldn't reassign");
    } finally {
      release();
    }
  }, [getCollectionRef, householdUsers, patchChores, toast, toastError, hold]);

  const closeHouseClean = useCallback(() => setHouseClean(null), []);
  const closePersonDone = useCallback(() => setPersonDone(null), []);

  const toggleOpen = useCallback((id: string) => {
    setOpenIds(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelect = useCallback((chore: ChoreRecord) => {
    if (chore.isCompleted) return;
    setSelectedChoreIds(previous => previous.includes(chore.id) ? previous.filter(id => id !== chore.id) : [...previous, chore.id]);
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Derived data                                                            */
  /* ---------------------------------------------------------------------- */

  // Same members as the dashboard streaks tile (`statsMemberFrom`): the email is a
  // matching key for older `completedByEmail` / `assignedToEmail` chores, never shown.
  const statsMembers = useMemo(() => householdUsers.map(statsMemberFrom), [householdUsers]);
  // Follows `today`, so the week, streaks and podium roll over at midnight.
  // On household days (D-6), like upkeep's weekly snapshot.
  const statsZone = householdDayZone(household?.timeZone);
  // CH-7 expired missed days still break fair streaks (CH-19); one listener with "N missed".
  const missedEntries = useMissedEntries(currentUser?.householdId);
  const stats = useMemo(() => computeChoreStats(assignedChores, statsMembers, statsNow(householdDay), { today: householdDay, timeZone: statsZone, missed: missedEntries }), [assignedChores, statsMembers, householdDay, statsZone, missedEntries]);
  // CH-21: the closed week's podium on the first days of a new week, never before it ends.
  const podiumWeek = podiumWeekStart(householdDay);
  const podium = useMemo(() => (podiumWeek ? closedWeekSummary(assignedChores, statsMembers, podiumWeek, statsZone) : null), [assignedChores, statsMembers, podiumWeek, statsZone]);
  const photos = useMemo(() => new Map(householdUsers.map(user => [user.uid, user.avatarUrl])), [householdUsers]);

  // Before rooms load the requested room is kept; afterwards an unknown id means All Rooms.
  const filterRoomId = effectiveChoresRoom(requestedRoomId, loading ? null : new Set(rooms.map(room => room.id)));
  // Shared-element target for the living house's room → Chores morph (H01): the
  // page container carries `view-transition-name: room-<roomId>` from the first
  // render (the skeleton too), so the View Transition lands on it.
  const frame = (children: ReactNode) => (
    <div data-testid="chores-page" data-room-filter={filterRoomId} style={morphStyle(filterRoomId !== ALL_ROOMS ? roomSharedId(filterRoomId) : null)}>
      {children}
    </div>
  );

  if (loading || !isMounted) {
    return frame(
      <div className="space-y-8">
        <Card>
          <CardHeader>
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-4 w-3/4" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!currentUser) {
    return frame(<SignInPrompt what="manage chores" />);
  }

  const reader = { uid: currentUser.uid, email: currentUser.email };
  const filteredChores = assignedChores.filter(chore => {
    // `?who=me`: the reader's chores (assignee by uid or email, as everywhere).
    if (!matchesWhoFilter(chore, filters.who, reader)) return false;
    if (filterRoomId === 'all') return true;
    if (filterRoomId === 'general') return !chore.roomIds || chore.roomIds.length === 0;
    return chore.roomIds?.includes(filterRoomId);
  });

  const byDue = (a: ChoreRecord, b: ChoreRecord) => choreDueKey(a).localeCompare(choreDueKey(b)) || a.task.localeCompare(b.task);
  const recurringTemplateIds = new Set(choreTemplates.filter(t => !!normalizeRecurrence(t.recurrence)).map(t => t.id));
  // `?due=overdue`: To Do keeps only chores due before today (folded missed instances stay with their row).
  const todoEntries = collapseMissedRecurring(filteredChores.filter(c => !c.isCompleted && choreDueKey(c) <= today).sort(byDue), recurringTemplateIds, householdUsers)
    .filter(entry => filters.due !== 'overdue' || choreDueKey(entry.chore) < today || entry.missed.length > 0);
  const futureChores = filteredChores.filter(c => !c.isCompleted && choreDueKey(c) > today).sort(byDue);
  const weekAhead = addDaysToKey(today, 7);
  const visibleFutureChores = showFullFuture ? futureChores : futureChores.filter(c => choreDueKey(c) <= weekAhead);
  const recentFrom = addDaysToKey(today, -3);
  const completedChores = filteredChores
    .filter(c => c.isCompleted && completionInstant(c))
    .sort((a, b) => completionInstant(b)!.getTime() - completionInstant(a)!.getTime());
  const visibleCompletedChores = showFullHistory ? completedChores : completedChores.filter(c => householdDayOf(completionInstant(c)!) >= recentFrom);
  const completedToday = completedChores.filter(c => householdDayOf(completionInstant(c)!) === today).length;
  const recurringChores = choreTemplates.filter(t => !!normalizeRecurrence(t.recurrence));
  const isEmptyHousehold = assignedChores.length === 0 && choreTemplates.length === 0;

  const groupByRoom = (entries: ToDoEntry[]) => {
    // Keyed by room id, never by name: a room someone named "General" or "Around the house"
    // stays its own group (CH-10). Chores of removed rooms share one group.
    const grouped = new Map<string, { id: string; name: string; icon: string; entries: ToDoEntry[] }>();
    for (const entry of entries) {
      const roomIds = entry.chore.roomIds && entry.chore.roomIds.length > 0 ? entry.chore.roomIds : ['general'];
      for (const roomId of roomIds) {
        const known = roomsById.get(roomId);
        const key = roomId === 'general' ? 'general' : known ? roomId : 'removed';
        const room = roomId === 'general' ? { name: AROUND_THE_HOUSE, icon: 'Home' } : (known || { name: REMOVED_ROOM, icon: 'Home' });
        const group = grouped.get(key) || { id: key, name: room.name, icon: room.icon, entries: [] };
        group.entries.push(entry);
        grouped.set(key, group);
      }
    }
    return [...grouped.values()].sort((a, b) => (a.id === 'general' ? 1 : b.id === 'general' ? -1 : a.name.localeCompare(b.name)));
  };
  const asEntries = (chores: ChoreRecord[]): ToDoEntry[] => chores.map(chore => ({ chore, missed: [] }));

  const listProps = {
    today,
    householdToday: householdDay,
    timeZone: household?.timeZone,
    usersByUid,
    users: householdUsers,
    colors: memberColors,
    capabilities,
    selectMode,
    selectedIds: new Set(selectedChoreIds),
    openIds,
    onToggleOpen: toggleOpen,
    onToggleDone: handleToggleDone,
    onToggleSelect: toggleSelect,
    onSubTaskToggle: (chore: ChoreRecord, subTask: string) => void handleSubTaskToggle(chore, subTask),
    onReassign: (chore: ChoreRecord, uid: string) => void handleReassign(chore, uid),
    onDelete: (chore: ChoreRecord) => setChoreToDelete(chore),
    onClearMissed: (entry: ToDoEntry) => void deleteChores(entry.missed.map(c => c.id), `Cleared ${entry.missed.length} missed`),
  };

  const roomGroups = (prefix: string, entries: ToDoEntry[], openByDefault: boolean) => {
    const groups = groupByRoom(entries);
    // Keyed on every filter: defaultValue only applies on mount, so a new room, due or
    // who filter remounts the groups with each newly listed room open (clearing Mine
    // brings in housemates' rooms, which would otherwise stay collapsed).
    return (
      <Accordion key={`${prefix}-${choresFiltersKey({ ...filters, room: filterRoomId })}`} type="multiple" className="w-full space-y-2" defaultValue={openByDefault ? groups.map(g => `${prefix}-${g.id}`) : []}>
        {groups.map(group => (
          <AccordionItem value={`${prefix}-${group.id}`} key={`${prefix}-${group.id}`} className="rounded-lg border bg-background px-2 md:px-3">
            <AccordionTrigger className="py-2 text-sm font-semibold hover:no-underline md:text-base">
              <span className="flex items-center gap-2"><RoomIcon name={group.icon} className="h-4 w-4" /><span>{group.name} (<NumberTicker value={group.entries.length} animateOnMount={false} />)</span></span>
            </AccordionTrigger>
            <AccordionContent>
              <ChoreList entries={group.entries} {...listProps} />
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    );
  };

  const nextUp = futureChores[0];
  const openAdd = () => setIsAddOpen(true);
  const openCreateRoom = () => setRoomsDialog({ open: true, startNew: true });
  const showLeaderboard = settings.leaderboardEnabled && householdUsers.length > 0 && !isEmptyHousehold;

  return frame(
    <>
      {confettiLayer}
      <HouseCleanMoment open={!!houseClean} rooms={houseClean || []} onDone={closeHouseClean} />
      <PersonDoneMoment title={personDone} onDone={closePersonDone} />

      <AlertDialog open={!!choreToDelete} onOpenChange={(open) => !open && setChoreToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {choreToDelete?.task}?</AlertDialogTitle>
            <AlertDialogDescription>
              {choreToDelete && !choreToDelete.isCompleted && isGeneratedInstance(choreToDelete)
                ? 'This removes this day only. The chore still repeats on its other days. This action cannot be undone.'
                : `This permanently removes this ${choreToDelete?.isCompleted ? 'completed' : 'active'} chore. This action cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
              onClick={() => {
                if (!choreToDelete) return;
                void deleteChores([choreToDelete.id], 'Chore removed');
                setChoreToDelete(null);
              }}
            >
              Delete Chore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!choreToReopen} onOpenChange={(open) => !open && setChoreToReopen(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reopen {choreToReopen?.task}?</AlertDialogTitle>
            <AlertDialogDescription>
              {choreToReopen
                ? `It goes back to To Do, and the points ${choreToReopen.completedByName ? `${choreToReopen.completedByName} got` : 'given'} for it are removed. Its ticked steps stay ticked.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it done</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!choreToReopen) return;
                void reopenChore(choreToReopen);
                setChoreToReopen(null);
              }}
            >
              Reopen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!choresPendingCompletion} onOpenChange={(open) => !open && setChoresPendingCompletion(null)}>
        <AlertDialogContent className="max-h-[90vh] max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Complete chores with unfinished steps?</AlertDialogTitle>
            <AlertDialogDescription>
              {pluralize(choresPendingCompletion?.length || 0, 'selected chore')} still {(choresPendingCompletion?.length || 0) === 1 ? 'has' : 'have'} open steps. Completing them marks those steps done too.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ScrollArea className="max-h-[42vh] rounded-md border">
            <div className="space-y-2 p-3">
              {choresPendingCompletion?.map(chore => (
                <div key={chore.id} className="rounded-md bg-muted/50 p-2">
                  <p className="text-sm font-medium leading-tight">{chore.task}</p>
                  <p className="text-xs text-muted-foreground">{pluralize(openSubTasks(chore).length, 'unfinished step')}</p>
                </div>
              ))}
            </div>
          </ScrollArea>
          <AlertDialogFooter>
            <AlertDialogCancel>Review Selection</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setChoresPendingCompletion(null); void completeChores(selectedChores, null); }}>
              Complete Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AddChoreDialog
        isOpen={isAddOpen}
        onOpenChange={setIsAddOpen}
        users={householdUsers}
        rooms={rooms}
        currentUserUid={currentUser.uid}
        capabilities={capabilities}
        onCreateRoom={openCreateRoom}
        onCreate={handleCreateChore}
      />
      <ChoreLibraryDialog
        isOpen={isLibraryOpen}
        onOpenChange={setIsLibraryOpen}
        choreTemplates={choreTemplates}
        rooms={rooms}
        capabilities={capabilities}
        onChoreTemplateSave={handleSaveChoreTemplate}
        onChoreTemplateDelete={handleDeleteChoreTemplate}
        onAssignChores={handleOpenAssignDialog}
        onCreateRoom={openCreateRoom}
      />
      <AssignChoresDialog
        isOpen={isAssignOpen}
        onOpenChange={setIsAssignOpen}
        users={householdUsers}
        rooms={rooms}
        templatesToAssign={templatesToAssign}
        currentUserUid={currentUser.uid}
        capabilities={capabilities}
        onAssign={handleAssignChores}
      />
      <ManageRoomsDialog
        isOpen={roomsDialog.open}
        onOpenChange={(open) => setRoomsDialog({ open, startNew: false })}
        startWithNewRoom={roomsDialog.startNew}
        rooms={rooms}
        capabilities={capabilities}
        onRoomSave={handleSaveRoom}
        onRoomDelete={handleDeleteRoom}
      />
      <RecurringChoresDialog
        isOpen={isRecurringOpen}
        onOpenChange={setIsRecurringOpen}
        recurringChores={recurringChores}
        users={householdUsers}
        currentUserUid={currentUser.uid}
        capabilities={capabilities}
        onUpdate={handleUpdateRecurringTask}
        onDelete={handleDeleteRecurringTask}
      />

      {/* Header: left-aligned with actions in the header row, like the other modules. */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-headline text-3xl font-bold tracking-tight">Chore Chart</h1>
          <p className="text-muted-foreground">Who does what, and what&apos;s due today.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {capabilities.canCreate && (
            <ShortcutHint shortcut="new-chore" label="New chore from anywhere">
              <Button onClick={openAdd}><Plus className="mr-2 h-4 w-4" /> Add Chore</Button>
            </ShortcutHint>
          )}
          <Button variant="outline" asChild>
            <Link href="/calendar"><CalendarDays className="mr-2 h-4 w-4" /> Calendar</Link>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline"><MoreVertical className="mr-2 h-4 w-4" /> Chore Manager</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem onSelect={() => setIsLibraryOpen(true)}>
                <ListChecks className="mr-2 h-4 w-4" /> Chore library
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setIsRecurringOpen(true)}>
                <Repeat className="mr-2 h-4 w-4" /> Repeating chores
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setRoomsDialog({ open: true, startNew: false })}>
                <Home className="mr-2 h-4 w-4" /> Rooms
              </DropdownMenuItem>
              {isManager && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem
                    checked={settings.leaderboardEnabled}
                    onCheckedChange={(checked) => {
                      setLeaderboardEnabled(Boolean(checked)).catch(error => toastError(error, "Couldn't change the setting"));
                    }}
                  >
                    <Trophy className="mr-2 h-4 w-4" /> Show leaderboard
                  </DropdownMenuCheckboxItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {live.status === 'error' ? (
        // CH-8: a failed load is never shown as an empty household. The listeners keep
        // retrying with backoff, and at once when the connection or the page comes back.
        <div className="rounded-xl border bg-card shadow-raised" role="alert" data-testid="chores-load-error">
          <EmptyState
            kind="chores"
            title="Couldn't load chores"
            description="Check the connection. This page tries again on its own."
            action={{ label: 'Try again', icon: <RotateCw className="h-4 w-4" />, onClick: live.retry }}
          />
        </div>
      ) : isEmptyHousehold ? (
        <div className="rounded-xl border bg-card shadow-raised">
          <EmptyState
            kind="chores"
            title="No chores yet"
            description={capabilities.canCreate ? 'Add your first chore. Name it, pick who does it, done.' : 'Chores show up here once someone in your household adds them.'}
            action={capabilities.canCreate ? { label: 'Add your first chore', icon: <Plus className="h-4 w-4" />, onClick: openAdd } : undefined}
            secondaryAction={capabilities.canEdit && rooms.length === 0 ? { label: 'Set up rooms', onClick: openCreateRoom } : undefined}
          />
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 space-y-3 md:space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Filter className="mr-2 h-4 w-4" />
                    {filterRoomId === 'all' ? 'All Rooms' : (filterRoomId === 'general' ? AROUND_THE_HOUSE : roomsById.get(filterRoomId)?.name || 'Filter')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuLabel>Filter by room</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuRadioGroup value={filterRoomId} onValueChange={setFilterRoomId}>
                    <DropdownMenuRadioItem value="all">All Rooms</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="general">{AROUND_THE_HOUSE}</DropdownMenuRadioItem>
                    {rooms.map(room => (
                      <DropdownMenuRadioItem key={room.id} value={room.id}>
                        <span className="flex items-center gap-2"><RoomIcon name={room.icon} className="h-3 w-3" />{room.name}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              {/* GOAL-filters: static labels with aria-pressed (HP-28a); the state lives in the URL. */}
              <Button
                variant={filters.due === 'overdue' ? 'secondary' : 'outline'}
                size="sm"
                aria-pressed={filters.due === 'overdue'}
                data-testid="chores-filter-overdue"
                onClick={() => setFilters({ due: filters.due === 'overdue' ? 'all' : 'overdue' })}
              >
                <AlarmClock className="mr-2 h-4 w-4" /> Overdue
              </Button>
              <Button
                variant={filters.who === 'me' ? 'secondary' : 'outline'}
                size="sm"
                aria-pressed={filters.who === 'me'}
                data-testid="chores-filter-mine"
                onClick={() => setFilters({ who: filters.who === 'me' ? 'all' : 'me' })}
              >
                <UserIcon className="mr-2 h-4 w-4" /> Mine
              </Button>
              {capabilities.canComplete && (
                <Button
                  variant={selectMode ? 'secondary' : 'ghost'}
                  size="sm"
                  aria-pressed={selectMode}
                  onClick={() => { setSelectMode(mode => !mode); setSelectedChoreIds([]); }}
                >
                  <CheckSquare className="mr-2 h-4 w-4" /> {selectMode ? 'Done selecting' : 'Select'}
                </Button>
              )}
            </div>

            {selectMode && selectedChores.length > 0 && (
              <div className="sticky top-2 z-10 rounded-lg border bg-popover p-3 shadow-overlay">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm font-medium">{pluralize(selectedChores.length, 'chore')} selected</p>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setSelectedChoreIds([])}>Clear</Button>
                    <Button size="sm" onClick={handleCompleteSelected}>Complete selected</Button>
                  </div>
                </div>
              </div>
            )}

            <Accordion type="multiple" defaultValue={['todo']} className="w-full space-y-3 md:space-y-4">
              <AccordionItem value="todo" className="rounded-lg border bg-card px-3 shadow-raised md:px-4">
                <AccordionTrigger className="py-2 font-headline text-base hover:no-underline md:py-3 md:text-xl"><span>To Do (<NumberTicker value={todoEntries.length} animateOnMount={false} />)</span></AccordionTrigger>
                <AccordionContent className="pt-1">
                  {todoEntries.length > 0 ? roomGroups('todo', todoEntries, true) : (
                    <EmptyState
                      kind="chores"
                      compact
                      headingLevel={3}
                      title={filters.due === 'overdue' ? 'Nothing overdue' : completedToday > 0 ? 'All done for today' : 'Nothing due today'}
                      description={nextUp ? `Next up: ${nextUp.task}, ${format(new Date(`${choreDueKey(nextUp)}T12:00:00`), 'EEE, MMM d')}.` : completedToday > 0 ? 'Nothing else is scheduled.' : 'Nothing is scheduled. Add a chore when something comes up.'}
                      action={capabilities.canCreate ? { label: 'Add Chore', icon: <Plus className="h-4 w-4" />, onClick: openAdd } : undefined}
                    />
                  )}
                  <MissedRecently entries={missedEntries} today={householdDay} nameOf={entry => {
                    const user = entry.assignedToUid ? usersByUid.get(entry.assignedToUid) : undefined;
                    return user ? memberName(user) : entry.assignedToDisplayName || 'Unassigned';
                  }} />
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="future" className="rounded-lg border bg-card px-3 shadow-raised md:px-4">
                <div className="flex items-center justify-between">
                  <AccordionPrimitive.Header className="flex flex-1">
                    <AccordionPrimitive.Trigger asChild>
                      <button className="flex min-h-[var(--target-min)] flex-1 items-center justify-between py-2 text-left font-headline text-base md:py-3 md:text-xl [&[data-state=open]>svg]:rotate-180">
                        <span>Future (<NumberTicker value={visibleFutureChores.length} animateOnMount={false} />)</span>
                        <ChevronDown aria-hidden className="h-4 w-4 shrink-0 transition-transform duration-200 md:h-5 md:w-5" />
                      </button>
                    </AccordionPrimitive.Trigger>
                  </AccordionPrimitive.Header>
                  <div className="ml-4 mr-1 flex shrink-0 items-center gap-2">
                    <Switch id="show-full-future" checked={showFullFuture} onCheckedChange={setShowFullFuture} />
                    <Label htmlFor="show-full-future" className="cursor-pointer text-xs md:text-sm">Show All</Label>
                  </div>
                </div>
                <AccordionContent className="pt-1">
                  {visibleFutureChores.length > 0 ? roomGroups('future', asEntries(visibleFutureChores), true) : (
                    <p className="py-6 text-center text-sm text-muted-foreground">Nothing scheduled in the next 7 days.</p>
                  )}
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="completed" className="rounded-lg border bg-card px-3 shadow-raised md:px-4">
                <div className="flex items-center justify-between">
                  <AccordionPrimitive.Header className="flex flex-1">
                    <AccordionPrimitive.Trigger asChild>
                      <button className="flex min-h-[var(--target-min)] flex-1 items-center justify-between py-2 text-left font-headline text-base md:py-3 md:text-xl [&[data-state=open]>svg]:rotate-180">
                        <span>Completed (<NumberTicker value={visibleCompletedChores.length} animateOnMount={false} />)</span>
                        <ChevronDown aria-hidden className="h-4 w-4 shrink-0 transition-transform duration-200 md:h-5 md:w-5" />
                      </button>
                    </AccordionPrimitive.Trigger>
                  </AccordionPrimitive.Header>
                  <div className="ml-4 mr-1 flex shrink-0 items-center gap-2">
                    <Switch id="show-full-history" checked={showFullHistory} onCheckedChange={setShowFullHistory} />
                    <Label htmlFor="show-full-history" className="cursor-pointer text-xs md:text-sm">History</Label>
                  </div>
                </div>
                <AccordionContent className="pt-1">
                  {visibleCompletedChores.length > 0 ? roomGroups('completed', asEntries(visibleCompletedChores), false) : (
                    <p className="py-6 text-center text-sm text-muted-foreground">No chores completed in the last 3 days.</p>
                  )}
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>

          {showLeaderboard && (
            <aside className="min-w-0 lg:sticky lg:top-20 lg:self-start">
              <ChoreLeaderboard stats={stats} colors={memberColors} photos={photos} podium={podium} />
            </aside>
          )}
        </div>
      )}
    </>
  );
}
