'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { onDataChanged } from '@/lib/data-changed';
import Link from 'next/link';
import { CalendarDays, CheckSquare, Filter, Home, ListChecks, MoreVertical, Plus, Repeat, Trophy } from 'lucide-react';
import { type DocumentData, collection, deleteField, doc, getDoc, getDocs, query, runTransaction, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore';
import { format } from 'date-fns';
import type { ChoreTemplate, HouseholdMember, Recurrence, Room, User as HomeHubUser } from '@/lib/types';
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
import { ChevronDown } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { syncHouseholdUpkeep } from '@/app/chores/actions';
import { auth, db } from '@/lib/firebase';
import { buildNotificationDocument, getDeterministicNotificationId } from '@/lib/notifications';
import { stableSlugify } from '@/lib/utils';
import { playFeedback } from '@/lib/feedback';
import { memberColorMap } from '@/lib/member-colors';
import { addDaysToKey, choreDueKey, completionInstant, dayFromKey, dayKey, type ChoreRecord } from '@/lib/chores/dates';
import { choreCapabilities, collapseMissedRecurring, confettiCount, isToDoClear, openSubTasks, uniqueTemplateId, type ToDoEntry } from '@/lib/chores/list';
import { completionSnapshot, completionUpdate, undoCompletionUpdate, type CompletionSnapshot } from '@/lib/chores/completion';
import { computeChoreStats, isPodiumDay } from '@/lib/chores/stats';
import { AddChoreDialog, AssignChoresDialog, ChoreLibraryDialog, ManageRoomsDialog, RecurringChoresDialog, type AddChoreInput, type AssignSchedule } from '@/components/chores/chore-dialogs';
import { normalizeRecurrence } from '@/components/chores/recurrence-fields';
import { ChoreList } from '@/components/chores/chore-list';
import { ChoreLeaderboard } from '@/components/chores/chore-leaderboard';
import { HouseCleanMoment, type CleanRoom } from '@/components/chores/house-clean-moment';
import { useConfetti } from '@/components/chores/confetti';
import { RoomIcon } from '@/components/chores/room-icons';
import { useChoreSettings } from '@/components/chores/use-chore-settings';
import { useToday } from '@/components/chores/use-today';
import { completionFields, restoreChoreFields } from '@/lib/chores/patch';
import { memberName } from '@/components/chores/assignee-select';
import { SignInPrompt } from '@/components/profile/sign-in-prompt';

type ChoreUser = HomeHubUser & { memberRole?: HouseholdMember['role'] };

const UNDO_MS = 5000;

/** End of `today` (local), so every completion made today counts and the week is today's week. */
const statsNow = (today: string) => { const d = dayFromKey(today); d.setHours(23, 59, 59, 999); return d; };

const houseCleanKey = (householdId: string, day: string) => `homehub.houseClean.${householdId}.${day}`;

function readFlag(key: string): boolean {
  try { return window.sessionStorage.getItem(key) === '1'; } catch { return false; }
}

function writeFlag(key: string) {
  try { window.sessionStorage.setItem(key, '1'); } catch { /* storage blocked: the moment may show again */ }
}

export function ChoreChartClient() {
  const { currentUser, currentMember, permissions } = useAuth();
  const { toast, toastError } = useToast();
  const capabilities = useMemo(() => choreCapabilities(permissions), [permissions]);
  const isManager = currentMember?.role === 'owner' || currentMember?.role === 'admin';
  const { settings, setLeaderboardEnabled } = useChoreSettings(currentUser?.householdId);
  const { burst, layer: confettiLayer } = useConfetti();

  const [assignedChores, setAssignedChores] = useState<ChoreRecord[]>([]);
  const [choreTemplates, setChoreTemplates] = useState<ChoreTemplate[]>([]);
  const [householdUsers, setHouseholdUsers] = useState<ChoreUser[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
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
  const [houseClean, setHouseClean] = useState<CleanRoom[] | null>(null);

  const [showFullHistory, setShowFullHistory] = useState(false);
  const [showFullFuture, setShowFullFuture] = useState(false);
  const [filterRoomId, setFilterRoomId] = useState<string>('all');

  // Chores that already celebrated in this visit: confetti never fires twice for one chore.
  const celebrated = useRef(new Set<string>());
  const choresRef = useRef<ChoreRecord[]>([]);
  useEffect(() => { choresRef.current = assignedChores; }, [assignedChores]);

  useEffect(() => { setIsMounted(true); }, []);

  const roomsById = useMemo(() => new Map(rooms.map(room => [room.id, room])), [rooms]);
  const usersByEmail = useMemo(() => new Map(householdUsers.map(user => [user.email, user as HomeHubUser])), [householdUsers]);
  const memberColors = useMemo(() => memberColorMap(householdUsers.map(user => user.uid || user.email)), [householdUsers]);

  const getCollectionRef = useCallback((collectionName: string) => {
    if (!currentUser?.householdId) return null;
    return collection(db, 'households', currentUser.householdId, collectionName);
  }, [currentUser]);

  const fetchAllData = useCallback(async () => {
    if (!currentUser?.householdId || !currentUser.email) {
      setLoading(false);
      return;
    }
    try {
      const householdDocSnap = await getDoc(doc(db, 'households', currentUser.householdId));
      if (!householdDocSnap.exists()) throw new Error('not-found');
      // Assignees come from approved membership records (the authority), enriched
      // with profile details where readable. One unreadable profile must not break the page.
      const membersSnap = await getDocs(collection(db, 'households', currentUser.householdId, 'members'));
      const approvedMembers = membersSnap.docs
        .map(snap => snap.data() as HouseholdMember)
        .filter(member => member.email && member.role !== 'newuser' && (member.status || 'active') === 'active');
      const profileResults = await Promise.allSettled(approvedMembers.map(member => getDoc(doc(db, 'users', member.email))));
      const usersData: ChoreUser[] = approvedMembers.map((member, index) => {
        const result = profileResults[index];
        const profile = result.status === 'fulfilled' && result.value.exists() ? result.value.data() as HomeHubUser : null;
        return {
          ...(profile || {}),
          uid: member.uid,
          email: member.email,
          displayName: profile?.displayName || member.displayName || member.email,
          avatarUrl: profile?.avatarUrl || member.avatarUrl || null,
          memberRole: member.role,
        } as ChoreUser;
      });
      setHouseholdUsers(usersData);

      const choresCollection = getCollectionRef('chores');
      const templatesCollection = getCollectionRef('chore-templates');
      const roomsCollection = getCollectionRef('rooms');
      if (!choresCollection || !templatesCollection || !roomsCollection) return;

      // Recurring chores, retention and reminders run on the server (hourly, and
      // here on demand) so every household member sees the same schedule.
      const firebaseUser = auth.currentUser;
      if (firebaseUser) {
        await syncHouseholdUpkeep({ idToken: await firebaseUser.getIdToken(), householdId: currentUser.householdId })
          .catch(syncError => console.warn('Household upkeep could not run.', syncError));
      }

      const [choresSnapshot, templatesSnapshot, roomsSnapshot] = await Promise.all([
        getDocs(query(choresCollection)),
        getDocs(query(templatesCollection)),
        getDocs(query(roomsCollection)),
      ]);

      setChoreTemplates(templatesSnapshot.docs.map(d => ({ id: d.id, ...d.data() } as ChoreTemplate)).sort((a, b) => a.task.localeCompare(b.task)));
      setRooms(roomsSnapshot.docs.map(d => ({ id: d.id, ...d.data() } as Room)).sort((a, b) => a.name.localeCompare(b.name)));
      setAssignedChores(choresSnapshot.docs.map(d => {
        const chore = { id: d.id, ...d.data() } as ChoreRecord;
        const user = usersData.find(u => u.email === chore.assignedToEmail);
        return { ...chore, assignedToDisplayName: user?.displayName || chore.assignedToDisplayName || chore.assignedToEmail };
      }));
    } catch (error) {
      console.error('Error fetching chores:', error instanceof Error ? error.message : String(error));
      toastError(error, "Couldn't load chores");
    } finally {
      setLoading(false);
    }
  }, [getCollectionRef, currentUser, toastError]);

  useEffect(() => {
    if (currentUser?.householdId) void fetchAllData();
    else setLoading(false);
  }, [currentUser, fetchAllData]);

  // Chores created elsewhere (the command palette's quick add): refresh silently.
  useEffect(() => {
    const householdId = currentUser?.householdId;
    if (!householdId) return;
    return onDataChanged('chores', householdId, () => void fetchAllData());
  }, [currentUser?.householdId, fetchAllData]);

  // Chore reminders are sent by the server (functions/src/reminders.ts), not
  // by whichever browser happens to have this page open.

  const patchChores = useCallback((ids: readonly string[], patch: (chore: ChoreRecord) => ChoreRecord) => {
    const idSet = new Set(ids);
    setAssignedChores(previous => previous.map(chore => (idSet.has(chore.id) ? patch(chore) : chore)));
  }, []);

  /** Assignment notifications go to other people only, never to yourself. */
  const shouldNotify = useCallback((email: string) => email !== currentUser?.email, [currentUser?.email]);

  /* ---------------------------------------------------------------------- */
  /* Creating                                                                */
  /* ---------------------------------------------------------------------- */

  const handleCreateChore = useCallback(async (input: AddChoreInput) => {
    if (!currentUser?.householdId) return false;
    const choresCollection = getCollectionRef('chores');
    const templatesCollection = getCollectionRef('chore-templates');
    const notificationsCollection = getCollectionRef('notifications');
    if (!choresCollection || !templatesCollection || !notificationsCollection) return false;
    const assignee = householdUsers.find(user => user.email === input.assignedToEmail);
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
        const stateKey = `assigned|${input.dueDate}|${input.assignedToEmail}`;
        const batch = writeBatch(db);
        batch.set(choreRef, {
          task: input.task,
          notes: input.notes,
          assignedToEmail: input.assignedToEmail,
          assignedToDisplayName: assigneeName,
          dueDate: new Date(`${input.dueDate}T12:00:00`).toISOString(),
          originalDueDate: input.dueDate,
          roomIds,
          isCompleted: false,
          completedSubTasks: [],
          sourceType: 'temporary',
        });
        if (shouldNotify(input.assignedToEmail)) {
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
        const templateId = uniqueTemplateId(stableSlugify(input.task), new Set(choreTemplates.map(t => t.id)));
        const recurrence: Recurrence = { ...input.recurrence, assignedToEmail: input.assignedToEmail };
        await setDoc(doc(templatesCollection, templateId), {
          task: input.task,
          notes: input.notes,
          roomIds,
          subTasks: [],
          recurrence,
          assignedToEmail: input.assignedToEmail,
        });
        if (shouldNotify(input.assignedToEmail)) {
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
      toast({ title: 'Chore added', description: `${input.task} is on ${assignee.email === currentUser.email ? 'your' : `${assigneeName}'s`} list.` });
      await fetchAllData();
      return true;
    } catch (error) {
      toastError(error, "Couldn't add the chore");
      return false;
    }
  }, [currentUser, getCollectionRef, householdUsers, choreTemplates, shouldNotify, toast, toastError, fetchAllData]);

  const handleSaveChoreTemplate = async (choreData: Partial<ChoreTemplate>, id?: string) => {
    const templatesCollection = getCollectionRef('chore-templates');
    const choresCollection = getCollectionRef('chores');
    if (!templatesCollection || !choresCollection) return false;
    const templateId = id || uniqueTemplateId(stableSlugify(choreData.task!), new Set(choreTemplates.map(t => t.id)));
    const templateRef = doc(templatesCollection, templateId);
    try {
      await runTransaction(db, async (transaction) => {
        const oldTemplateSnap = id ? await transaction.get(templateRef) : null;
        const oldTemplate = oldTemplateSnap?.exists() ? oldTemplateSnap.data() as ChoreTemplate : null;
        transaction.set(templateRef, choreData, { merge: true });
        if (!id) return;
        const openChores = await getDocs(query(choresCollection, where('templateId', '==', id), where('isCompleted', '==', false)));
        const removedRoomIds = oldTemplate?.roomIds && choreData.roomIds ? oldTemplate.roomIds.filter(roomId => !choreData.roomIds!.includes(roomId)) : [];
        openChores.forEach(choreDoc => {
          const chore = choreDoc.data() as ChoreRecord;
          if (removedRoomIds.length > 0 && chore.roomIds?.some(roomId => removedRoomIds.includes(roomId))) {
            transaction.delete(choreDoc.ref);
          } else {
            transaction.update(choreDoc.ref, { task: choreData.task, notes: choreData.notes, subTasks: choreData.subTasks });
          }
        });
      });
      toast({ title: id ? 'Chore updated' : 'Saved to library' });
      await fetchAllData();
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
      await runTransaction(db, async (transaction) => {
        const openChores = await getDocs(query(choresCollection, where('templateId', '==', id), where('isCompleted', '==', false)));
        transaction.delete(doc(templatesCollection, id));
        openChores.forEach(choreDoc => transaction.delete(choreDoc.ref));
      });
      toast({ title: 'Chore deleted' });
      await fetchAllData();
    } catch (error) {
      toastError(error, "Couldn't delete the chore");
    }
  };

  const handleOpenAssignDialog = (templates: ChoreTemplate[]) => {
    setTemplatesToAssign(templates);
    setIsAssignOpen(true);
    setIsLibraryOpen(false);
  };

  const handleAssignChores = useCallback(async (assignment: { assignedToEmail: string; roomIds: string[] }, schedule: AssignSchedule) => {
    if (!currentUser?.householdId || templatesToAssign.length === 0) return false;
    const templatesCollection = getCollectionRef('chore-templates');
    const choresCollection = getCollectionRef('chores');
    if (!choresCollection || !templatesCollection) return false;
    const user = householdUsers.find(u => u.email === assignment.assignedToEmail);
    if (!user) {
      toastError({ code: 'not-found' }, "Couldn't assign");
      return false;
    }
    const assignedToDisplayName = memberName(user);
    const batch = writeBatch(db);
    if (schedule.type === 'recurring') {
      for (const template of templatesToAssign) {
        const recurrence: Recurrence = { ...schedule.recurrence, assignedToEmail: assignment.assignedToEmail };
        batch.set(doc(templatesCollection, template.id), { recurrence, assignedToEmail: assignment.assignedToEmail }, { merge: true });
      }
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
            assignedToEmail: assignment.assignedToEmail,
            assignedToDisplayName,
            dueDate: schedule.dueDate.toISOString(),
            isCompleted: false,
            notes: template.notes || '',
            subTasks: template.subTasks || [],
            completedSubTasks: [],
            templateId: template.id,
            // One-time library assignment: never folded as a missed repeating instance.
            sourceType: 'template',
            originalDueDate,
            roomIds: roomId === 'general' ? [] : [roomId],
          });
        });
      }
    }
    try {
      await batch.commit();
      if (shouldNotify(assignment.assignedToEmail)) {
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
      await fetchAllData();
      return true;
    } catch (error) {
      toastError(error, "Couldn't assign");
      return false;
    }
  }, [currentUser, getCollectionRef, householdUsers, templatesToAssign, shouldNotify, toast, toastError, fetchAllData]);

  /* ---------------------------------------------------------------------- */
  /* Rooms and repeating chores                                              */
  /* ---------------------------------------------------------------------- */

  const handleSaveRoom = async (roomData: { name: string; icon: string }, id?: string) => {
    const roomsCollection = getCollectionRef('rooms');
    if (!roomsCollection) return false;
    const roomId = id || uniqueTemplateId(stableSlugify(roomData.name), new Set(rooms.map(r => r.id)));
    try {
      await setDoc(doc(roomsCollection, roomId), roomData);
      toast({ title: id ? 'Room updated' : 'Room added' });
      await fetchAllData();
      return true;
    } catch (error) {
      toastError(error, "Couldn't save the room");
      return false;
    }
  };

  const handleDeleteRoom = async (id: string) => {
    const roomsCollection = getCollectionRef('rooms');
    const templatesCollection = getCollectionRef('chore-templates');
    if (!roomsCollection || !templatesCollection) return;
    try {
      await runTransaction(db, async (transaction) => {
        transaction.delete(doc(roomsCollection, id));
        choreTemplates.filter(t => t.roomIds?.includes(id)).forEach(template => {
          transaction.update(doc(templatesCollection, template.id), { roomIds: template.roomIds?.filter(roomId => roomId !== id) });
        });
      });
      toast({ title: 'Room deleted' });
      await fetchAllData();
    } catch (error) {
      toastError(error, "Couldn't delete the room");
    }
  };

  const replaceRecurrence = async (choreId: string, update: DocumentData, title: string, failure: string) => {
    const templatesCollection = getCollectionRef('chore-templates');
    const choresCollection = getCollectionRef('chores');
    if (!templatesCollection || !choresCollection) return false;
    try {
      await runTransaction(db, async (transaction) => {
        const openChores = await getDocs(query(choresCollection, where('templateId', '==', choreId), where('isCompleted', '==', false)));
        transaction.update(doc(templatesCollection, choreId), update);
        openChores.forEach(choreDoc => transaction.delete(choreDoc.ref));
      });
      toast({ title });
      await fetchAllData();
      return true;
    } catch (error) {
      toastError(error, failure);
      return false;
    }
  };

  const handleUpdateRecurringTask = (choreId: string, assignedToEmail: string, recurrence: Recurrence) =>
    replaceRecurrence(choreId, { assignedToEmail, recurrence }, 'Repeating chore updated', "Couldn't update the schedule");

  const handleDeleteRecurringTask = async (choreId: string) => {
    await replaceRecurrence(choreId, { recurrence: null, assignedToEmail: null }, 'Stopped repeating', "Couldn't stop the schedule");
  };

  /* ---------------------------------------------------------------------- */
  /* Completing (H05)                                                        */
  /* ---------------------------------------------------------------------- */

  const today = useToday();

  const maybeCelebrateHouse = useCallback((before: readonly ChoreRecord[], after: readonly ChoreRecord[]) => {
    if (!currentUser?.householdId) return;
    const hadDue = !isToDoClear(before, today);
    if (!hadDue || !isToDoClear(after, today)) return;
    const key = houseCleanKey(currentUser.householdId, today);
    if (readFlag(key)) return;
    writeFlag(key);
    const doneToday = after.filter(chore => {
      const instant = completionInstant(chore);
      return instant && dayKey(instant) === today;
    });
    const roomIds = [...new Set(doneToday.flatMap(chore => chore.roomIds || []))];
    const cleanRooms = roomIds.map(id => roomsById.get(id)).filter(Boolean).map(room => ({ id: room!.id, name: room!.name, icon: room!.icon }));
    setHouseClean(cleanRooms);
    playFeedback('celebrate');
  }, [currentUser?.householdId, today, roomsById]);

  const undoCompletion = useCallback(async (snapshots: Map<string, CompletionSnapshot>) => {
    const choresCollection = getCollectionRef('chores');
    if (!choresCollection) return;
    const batch = writeBatch(db);
    const locals = new Map<string, ReturnType<typeof undoCompletionUpdate>['local']>();
    snapshots.forEach((snapshot, id) => {
      const { update, local } = undoCompletionUpdate(snapshot);
      batch.update(doc(choresCollection, id), update);
      locals.set(id, local);
    });
    const saved = new Map(choresRef.current.filter(c => snapshots.has(c.id)).map(c => [c.id, completionFields(c)]));
    patchChores([...snapshots.keys()], chore => ({ ...chore, ...locals.get(chore.id) }));
    try {
      await batch.commit();
    } catch (error) {
      // Put back only these chores' completion fields; keep anything else that changed meanwhile.
      setAssignedChores(current => restoreChoreFields(current, saved));
      toastError(error, "Couldn't undo");
    }
  }, [getCollectionRef, patchChores, toastError]);

  const completeChores = useCallback(async (chores: readonly ChoreRecord[], origin: DOMRect | null) => {
    const choresCollection = getCollectionRef('chores');
    if (!choresCollection || chores.length === 0) return;
    const snapshots = new Map<string, CompletionSnapshot>();
    const locals = new Map<string, Partial<ChoreRecord>>();
    const batch = writeBatch(db);
    for (const chore of chores) {
      snapshots.set(chore.id, completionSnapshot(chore));
      // One tap completes, including any open steps; Undo restores them exactly.
      const { update, local } = completionUpdate(chore, openSubTasks(chore).length > 0);
      batch.update(doc(choresCollection, chore.id), update);
      locals.set(chore.id, local);
    }
    const before = choresRef.current;
    const after = before.map(chore => (locals.has(chore.id) ? { ...chore, ...locals.get(chore.id) } as ChoreRecord : chore));
    const saved = new Map(before.filter(c => locals.has(c.id)).map(c => [c.id, completionFields(c)]));
    setAssignedChores(current => restoreChoreFields(current, locals));
    setSelectedChoreIds(previous => previous.filter(id => !locals.has(id)));
    try {
      await batch.commit();
    } catch (error) {
      // Roll back only this completion's chores (a parallel completion may have succeeded).
      setAssignedChores(current => restoreChoreFields(current, saved));
      toastError(error, chores.length === 1 ? "Couldn't complete the chore" : "Couldn't complete the chores");
      return;
    }

    playFeedback('complete');
    const fresh = chores.filter(chore => !celebrated.current.has(chore.id));
    fresh.forEach(chore => celebrated.current.add(chore.id));
    if (fresh.length > 0 && origin) {
      burst(origin, Math.min(40, fresh.reduce((sum, chore) => sum + confettiCount(chore), 0)));
    }

    const label = chores.length === 1 ? chores[0].task : `${chores.length} chores`;
    const handle = toast({
      title: chores.length === 1 ? 'Done' : 'Chores done',
      description: `${label} marked complete.`,
      duration: UNDO_MS,
      action: (
        <ToastAction altText={`Undo completing ${label}`} onClick={() => { handle.dismiss(); void undoCompletion(snapshots); }}>
          Undo
        </ToastAction>
      ),
    });
    maybeCelebrateHouse(before, after);
  }, [getCollectionRef, toast, toastError, burst, undoCompletion, maybeCelebrateHouse]);

  const reopenChore = useCallback(async (chore: ChoreRecord) => {
    const choresCollection = getCollectionRef('chores');
    if (!choresCollection) return;
    const saved = new Map([[chore.id, completionFields(chore)]]);
    patchChores([chore.id], c => ({ ...c, isCompleted: false, completedAt: undefined, completedAtServer: undefined }));
    try {
      await updateDoc(doc(choresCollection, chore.id), { isCompleted: false, completedAt: deleteField(), completedAtServer: deleteField() });
    } catch (error) {
      setAssignedChores(current => restoreChoreFields(current, saved));
      toastError(error, "Couldn't reopen the chore");
    }
  }, [getCollectionRef, patchChores, toastError]);

  const handleToggleDone = useCallback((chore: ChoreRecord, origin: HTMLElement | null) => {
    if (!capabilities.canComplete) return;
    if (chore.isCompleted) void reopenChore(chore);
    // Measure now: the row leaves the To Do list before the write finishes.
    else void completeChores([chore], origin?.getBoundingClientRect() ?? null);
  }, [capabilities.canComplete, completeChores, reopenChore]);

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
    patchChores([chore.id], c => ({ ...c, completedSubTasks: next }));
    try {
      await updateDoc(doc(choresCollection, chore.id), { completedSubTasks: next });
    } catch (error) {
      patchChores([chore.id], c => ({ ...c, completedSubTasks: current }));
      toastError(error, "Couldn't update the step");
    }
  }, [getCollectionRef, capabilities.canComplete, patchChores, toastError]);

  const deleteChores = async (ids: string[], title: string) => {
    const choresCollection = getCollectionRef('chores');
    if (!choresCollection || ids.length === 0) return;
    try {
      const batch = writeBatch(db);
      ids.forEach(id => batch.delete(doc(choresCollection, id)));
      await batch.commit();
      toast({ title });
      setAssignedChores(previous => previous.filter(chore => !ids.includes(chore.id)));
    } catch (error) {
      toastError(error, "Couldn't delete");
    }
  };

  const handleReassign = useCallback(async (chore: ChoreRecord, email: string) => {
    const choresCollection = getCollectionRef('chores');
    const user = householdUsers.find(u => u.email === email);
    if (!choresCollection || !user || email === chore.assignedToEmail) return;
    const updates = { assignedToEmail: email, assignedToDisplayName: memberName(user) };
    const previous = { assignedToEmail: chore.assignedToEmail, assignedToDisplayName: chore.assignedToDisplayName };
    patchChores([chore.id], c => ({ ...c, ...updates }));
    try {
      await updateDoc(doc(choresCollection, chore.id), updates);
      toast({ title: 'Chore reassigned', description: `${chore.task} is now ${memberName(user)}'s.` });
    } catch (error) {
      patchChores([chore.id], c => ({ ...c, ...previous }));
      toastError(error, "Couldn't reassign");
    }
  }, [getCollectionRef, householdUsers, patchChores, toast, toastError]);

  const closeHouseClean = useCallback(() => setHouseClean(null), []);

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

  const statsMembers = useMemo(() => householdUsers.map(user => ({
    email: user.email, uid: user.uid || user.email, name: memberName(user), role: user.memberRole,
  })), [householdUsers]);
  // Follows `today`, so the week, streaks and podium roll over at midnight.
  const stats = useMemo(() => computeChoreStats(assignedChores, statsMembers, statsNow(today)), [assignedChores, statsMembers, today]);
  const photos = useMemo(() => new Map(householdUsers.map(user => [user.email, user.avatarUrl])), [householdUsers]);

  if (loading || !isMounted) {
    return (
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
    return <SignInPrompt what="manage chores" />;
  }

  const filteredChores = assignedChores.filter(chore => {
    if (filterRoomId === 'all') return true;
    if (filterRoomId === 'general') return !chore.roomIds || chore.roomIds.length === 0;
    return chore.roomIds?.includes(filterRoomId);
  });

  const byDue = (a: ChoreRecord, b: ChoreRecord) => choreDueKey(a).localeCompare(choreDueKey(b)) || a.task.localeCompare(b.task);
  const recurringTemplateIds = new Set(choreTemplates.filter(t => !!normalizeRecurrence(t.recurrence)).map(t => t.id));
  const todoEntries = collapseMissedRecurring(filteredChores.filter(c => !c.isCompleted && choreDueKey(c) <= today).sort(byDue), recurringTemplateIds);
  const futureChores = filteredChores.filter(c => !c.isCompleted && choreDueKey(c) > today).sort(byDue);
  const weekAhead = addDaysToKey(today, 7);
  const visibleFutureChores = showFullFuture ? futureChores : futureChores.filter(c => choreDueKey(c) <= weekAhead);
  const recentFrom = addDaysToKey(today, -3);
  const completedChores = filteredChores
    .filter(c => c.isCompleted && completionInstant(c))
    .sort((a, b) => completionInstant(b)!.getTime() - completionInstant(a)!.getTime());
  const visibleCompletedChores = showFullHistory ? completedChores : completedChores.filter(c => dayKey(completionInstant(c)!) >= recentFrom);
  const completedToday = completedChores.filter(c => dayKey(completionInstant(c)!) === today).length;
  const recurringChores = choreTemplates.filter(t => !!normalizeRecurrence(t.recurrence));
  const isEmptyHousehold = assignedChores.length === 0 && choreTemplates.length === 0;

  const groupByRoom = (entries: ToDoEntry[]) => {
    const grouped = new Map<string, { name: string; icon: string; entries: ToDoEntry[] }>();
    for (const entry of entries) {
      const roomIds = entry.chore.roomIds && entry.chore.roomIds.length > 0 ? entry.chore.roomIds : ['general'];
      for (const roomId of roomIds) {
        const room = roomId === 'general' ? { name: 'General', icon: 'Home' } : (roomsById.get(roomId) || { name: 'Unknown Room', icon: 'Home' });
        const group = grouped.get(room.name) || { name: room.name, icon: room.icon, entries: [] };
        group.entries.push(entry);
        grouped.set(room.name, group);
      }
    }
    return [...grouped.values()].sort((a, b) => (a.name === 'General' ? 1 : b.name === 'General' ? -1 : a.name.localeCompare(b.name)));
  };
  const asEntries = (chores: ChoreRecord[]): ToDoEntry[] => chores.map(chore => ({ chore, missed: [] }));

  const listProps = {
    today,
    usersByEmail,
    users: householdUsers as HomeHubUser[],
    colors: memberColors,
    capabilities,
    selectMode,
    selectedIds: new Set(selectedChoreIds),
    openIds,
    onToggleOpen: toggleOpen,
    onToggleDone: handleToggleDone,
    onToggleSelect: toggleSelect,
    onSubTaskToggle: (chore: ChoreRecord, subTask: string) => void handleSubTaskToggle(chore, subTask),
    onReassign: (chore: ChoreRecord, email: string) => void handleReassign(chore, email),
    onDelete: (chore: ChoreRecord) => setChoreToDelete(chore),
    onClearMissed: (entry: ToDoEntry) => void deleteChores(entry.missed.map(c => c.id), `Cleared ${entry.missed.length} missed`),
  };

  const roomGroups = (prefix: string, entries: ToDoEntry[], openByDefault: boolean) => {
    const groups = groupByRoom(entries);
    return (
      <Accordion type="multiple" className="w-full space-y-2" defaultValue={openByDefault ? groups.map(g => `${prefix}-${g.name}`) : []}>
        {groups.map(group => (
          <AccordionItem value={`${prefix}-${group.name}`} key={`${prefix}-${group.name}`} className="rounded-lg border bg-background px-2 md:px-3">
            <AccordionTrigger className="py-2 text-sm font-semibold hover:no-underline md:text-base">
              <span className="flex items-center gap-2"><RoomIcon name={group.icon} className="h-4 w-4" /> {group.name} ({group.entries.length})</span>
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

  return (
    <>
      {confettiLayer}
      <HouseCleanMoment open={!!houseClean} rooms={houseClean || []} onDone={closeHouseClean} />

      <AlertDialog open={!!choreToDelete} onOpenChange={(open) => !open && setChoreToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {choreToDelete?.task}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes this {choreToDelete?.isCompleted ? 'completed' : 'active'} chore. This action cannot be undone.
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

      <AlertDialog open={!!choresPendingCompletion} onOpenChange={(open) => !open && setChoresPendingCompletion(null)}>
        <AlertDialogContent className="max-h-[90vh] max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Complete chores with unfinished steps?</AlertDialogTitle>
            <AlertDialogDescription>
              {choresPendingCompletion?.length || 0} selected chore(s) still have open steps. Completing them marks those steps done too.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ScrollArea className="max-h-[42vh] rounded-md border">
            <div className="space-y-2 p-3">
              {choresPendingCompletion?.map(chore => (
                <div key={chore.id} className="rounded-md bg-muted/50 p-2">
                  <p className="text-sm font-medium leading-tight">{chore.task}</p>
                  <p className="text-xs text-muted-foreground">{openSubTasks(chore).length} unfinished step(s)</p>
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
        currentUserEmail={currentUser.email}
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
        currentUserEmail={currentUser.email}
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
        currentUserEmail={currentUser.email}
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
            <Button onClick={openAdd}><Plus className="mr-2 h-4 w-4" /> Add Chore</Button>
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

      {isEmptyHousehold ? (
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
                    {filterRoomId === 'all' ? 'All Rooms' : (filterRoomId === 'general' ? 'General' : roomsById.get(filterRoomId)?.name || 'Filter')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuLabel>Filter by room</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuRadioGroup value={filterRoomId} onValueChange={setFilterRoomId}>
                    <DropdownMenuRadioItem value="all">All Rooms</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="general">General</DropdownMenuRadioItem>
                    {rooms.map(room => (
                      <DropdownMenuRadioItem key={room.id} value={room.id}>
                        <span className="flex items-center gap-2"><RoomIcon name={room.icon} className="h-3 w-3" />{room.name}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
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
                  <p className="text-sm font-medium">{selectedChores.length} chore(s) selected</p>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setSelectedChoreIds([])}>Clear</Button>
                    <Button size="sm" onClick={handleCompleteSelected}>Complete selected</Button>
                  </div>
                </div>
              </div>
            )}

            <Accordion type="multiple" defaultValue={['todo']} className="w-full space-y-3 md:space-y-4">
              <AccordionItem value="todo" className="rounded-lg border bg-card px-3 shadow-raised md:px-4">
                <AccordionTrigger className="py-2 font-headline text-base hover:no-underline md:py-3 md:text-xl">To Do ({todoEntries.length})</AccordionTrigger>
                <AccordionContent className="pt-1">
                  {todoEntries.length > 0 ? roomGroups('todo', todoEntries, true) : (
                    <EmptyState
                      kind="chores"
                      compact
                      headingLevel={3}
                      title={completedToday > 0 ? 'All done for today' : 'Nothing due today'}
                      description={nextUp ? `Next up: ${nextUp.task}, ${format(new Date(`${choreDueKey(nextUp)}T12:00:00`), 'EEE, MMM d')}.` : 'Nothing is scheduled. Add a chore when something comes up.'}
                      action={capabilities.canCreate ? { label: 'Add Chore', icon: <Plus className="h-4 w-4" />, onClick: openAdd } : undefined}
                    />
                  )}
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="future" className="rounded-lg border bg-card px-3 shadow-raised md:px-4">
                <div className="flex items-center justify-between">
                  <AccordionPrimitive.Header className="flex flex-1">
                    <AccordionPrimitive.Trigger asChild>
                      <button className="flex flex-1 items-center justify-between py-2 text-left font-headline text-base md:py-3 md:text-xl [&[data-state=open]>svg]:rotate-180">
                        Future ({visibleFutureChores.length})
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
                      <button className="flex flex-1 items-center justify-between py-2 text-left font-headline text-base md:py-3 md:text-xl [&[data-state=open]>svg]:rotate-180">
                        Completed ({visibleCompletedChores.length})
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
              <ChoreLeaderboard stats={stats} colors={memberColors} photos={photos} showPodium={isPodiumDay(statsNow(today))} />
            </aside>
          )}
        </div>
      )}
    </>
  );
}
