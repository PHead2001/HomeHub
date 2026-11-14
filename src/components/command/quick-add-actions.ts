'use client';

/**
 * Writes for natural-language quick-add (H13). Each one uses the same document
 * contract as the module that owns the data, so Firestore rules and the module's
 * screens treat the result exactly like something added there:
 * - shopping items: the Shopping list's own save path (`addItemsToList`): merged
 *   online into a still-needed item of the same name, otherwise created at once
 *   with a remembered or local category, then one batched, quota-counted AI call
 *   for the rest;
 * - feedings: the Pets module's shared feed operation (`feedPet`), defaulting to
 *   the pet's usual portion (`feedingPlan`) and the latest feeding's food type
 *   (`knownFoodType`), exactly like the one-tap feed button, including its
 *   "Feed again?" check (the palette asks before logging again);
 * - one-time chores: a temporary task (chore + targeted assignment notification,
 *   skipped when you assign it to yourself), as Chores creates them;
 * - repeating chores: a chore template with the Chores dialog's recurrence shape
 *   (`repeatingChoreTemplate`), an id that is always new (`quickCreateId`), and the
 *   same "new repeating chore" notification; server upkeep creates the instances;
 * - maintenance logs: a routine log like the Maintenance "Add log" form
 *   (`quickMaintenanceLog`), with the odometer reading on the vehicle's log.
 * Firestore rules check the same permissions as on those screens (chores.create,
 * maintenance.createLogs). Nothing is written until the person confirms the preview.
 */
import { Timestamp, collection, doc, limit, orderBy, query, setDoc, where, writeBatch } from 'firebase/firestore';
import { syncHouseholdUpkeep } from '@/app/chores/actions';
import { format } from 'date-fns';
import { auth, db } from '@/lib/firebase';
import { awaitWriteUnlessOffline, getDocOfflineAware, getDocsOfflineAware } from '@/lib/firestore-offline';
import { petLogsCollection } from '@/components/pets/pet-log-api';
import { knownFromLogs, lastFedPreview } from '@/lib/pets/feed-decision';
import type { FeedConfirm } from '@/lib/pets/feed-plan';
import { feedPet, type FeedPetResult } from '@/lib/pets/feed-operation';
import { foodTypeFromLatest } from '@/lib/dashboard/quick-add';
import type { RawDoc } from '@/lib/dashboard/facts';
import { loggerName } from '@/lib/pets/care';
import type { PortionUnit } from '@/lib/pets/types';
import type { QuickAddEntry } from '@/lib/shopping/items';
import { addItemsToList } from '@/lib/shopping/add-items';
import { shoppingAddOutcome, type ShoppingAddOutcome } from '@/lib/dashboard/quick-add';
import { buildNotificationDocument, getDeterministicNotificationId } from '@/lib/notifications';
import { DEFAULT_SHOPPING_CATEGORIES, normalizeStoredCategories } from '@/lib/shopping-items';
import { assigneeFields } from '@functions/shared/assignee';
import { publicDisplayName } from '@/lib/member-directory';
import type { Chore, ShoppingListItem, User } from '@/lib/types';
import type { MaintenanceTarget, QuickAddList, QuickAddMember, QuickAddRepeat, QuickAddRoom } from '@/lib/dashboard/quick-add';
import { quickCreateId, quickMaintenanceLog, recurrenceFromRepeat, repeatingChoreTemplate } from '@/lib/dashboard/quick-add-writes';

export async function addShoppingItems(
  householdId: string,
  list: QuickAddList,
  items: QuickAddEntry[],
  onLateError: (error: unknown) => void,
): Promise<ShoppingAddOutcome & { settled: Promise<{ failed: QuickAddEntry[] }> }> {
  const categoriesSnapshot = await getDocOfflineAware(doc(db, 'households', householdId, 'shopping-lists', list.id, 'config', 'categories')).catch(() => null);
  const categories = (categoriesSnapshot?.exists() ? normalizeStoredCategories(categoriesSnapshot.data()) : null) ?? DEFAULT_SHOPPING_CATEGORIES;
  const itemsRef = collection(db, 'households', householdId, 'shopping-lists', list.id, 'items');
  // The list's items give merge targets (needed ones, merged online only) and
  // remembered categories; offline they come from the cache.
  const knownItems = (await getDocsOfflineAware(itemsRef).catch(() => null))
    ?.docs.map((entry) => ({ id: entry.id, ...(entry.data() as Omit<ShoppingListItem, 'id'>) })) ?? [];
  // The Shopping list's own save path: saved at once with a remembered or local
  // category, one batched AI call afterwards, each write classified honestly.
  const { outcomes } = await addItemsToList({
    householdId,
    listId: list.id,
    uid: auth.currentUser?.uid,
    entries: items,
    categories,
    knownItems,
    // Late AI answers only while the same household is signed in (the palette has no open list).
    active: () => ({ householdId: auth.currentUser ? householdId : null, listId: list.id }),
    onLateError: (_name, error) => onLateError(error),
  });
  // Each save state is kept: only `saved` and `stored-locally` are confirmed;
  // `sending` and `uncertain` stay unconfirmed until `settled` says how they ended.
  const outcome = shoppingAddOutcome(items, outcomes);
  const settled = Promise.all(outcomes.map(async (entryOutcome, index) => (
    entryOutcome.state === 'sending' || entryOutcome.state === 'uncertain'
      ? ((await entryOutcome.settled) === 'failed' ? items[index] : null)
      : null
  ))).then((late) => ({ failed: late.filter((entry): entry is QuickAddEntry => entry !== null) }));
  return { ...outcome, settled };
}

// Feedings go through the Pets module's shared feed operation, so quick-add
// entries carry the same shape (including who logged them) and the same
// duplicate-feed check as the one-tap button and the full form.
export async function logFeeding({
  householdId,
  petId,
  amount,
  unit,
  viewer,
  timeZone,
  opId,
  confirm = null,
  onLateError,
}: {
  householdId: string;
  petId: string;
  amount: number;
  unit: PortionUnit;
  viewer: User;
  timeZone?: string | null;
  /** One id per previewed feeding (`newFeedOpId`), reused when Confirm is pressed again (PE-23h). */
  opId: string;
  /** The answer to "Feed again?", bound to the state it was asked for (`feedConfirmOf`, PE-23g). */
  confirm?: FeedConfirm | null;
  onLateError: (error: unknown) => void;
}): Promise<FeedPetResult> {
  // Same fields as the Pets one-tap feed: the planned or given portion, the food
  // type of the pet's latest feeding, and no comment.
  const { food, known } = await feedingHistory(householdId, petId, timeZone);
  return feedPet({
    householdId,
    petId,
    portion: { amount, unit },
    food,
    opId,
    confirm,
    timeZone,
    known,
    user: { uid: viewer.uid, name: loggerName(viewer) },
    onLateError,
  });
}

/**
 * What a quick feeding reuses from the pet's history: the food type of its latest
 * feeding and, from the newest 20 per date shape as the pet cards read them,
 * today's count (household day) for the complete-day check when the state lags
 * behind. Shared by the typed quick add and the palette's Feeding mode buttons.
 */
export async function feedingHistory(householdId: string, petId: string, timeZone?: string | null) {
  const latest = await latestFeedings(householdId, petId);
  return { food: foodTypeFromLatest(latest), known: knownFromLogs(latest.flat(), new Date(), timeZone) };
}

/**
 * "Last fed 10 min ago by Sam (wet)" for the quick-add preview before saving
 * (PE-23e, QA-17), from the same newest feedings the save reads. The save still
 * runs the authoritative check in its transaction.
 */
export async function feedingPreviewLine(householdId: string, petId: string, timeZone?: string | null): Promise<string> {
  // Both date-shape reads are required: a failed one makes the line "Last feeding unavailable" (lastFedPreview).
  return lastFedPreview(await latestFeedingReads(householdId, petId), new Date(), timeZone);
}

/** Lowest Timestamp, so the Timestamp-shape query matches every Timestamp date. */
const MIN_TIMESTAMP = Timestamp.fromMillis(-62135596800000);

/**
 * The newest 20 feedings in each date shape (Timestamps and older ISO strings, which
 * Firestore orders separately) with offline-aware reads: the food type to reuse
 * (`foodTypeFromLatest`: `knownFoodType` of the latest, Dry without readable
 * history, as Pets picks it) and the last-fed fallback for a pet without a
 * feeding-state document.
 */
async function latestFeedingReads(householdId: string, petId: string): Promise<PromiseSettledResult<(RawDoc & { date: unknown })[]>[]> {
  const logs = petLogsCollection(householdId, petId, 'feeding-logs');
  const latest = (floor: unknown) => getDocsOfflineAware(query(logs, where('date', '>=', floor), orderBy('date', 'desc'), limit(20)))
    .then((snapshot) => snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as RawDoc & { date: unknown }));
  return Promise.allSettled([latest(MIN_TIMESTAMP), latest('')]);
}

/**
 * The same reads for saving a quick feeding: a failed read is left out (the food
 * type falls back to Dry and the transaction runs the authoritative check), but
 * the preview above never shows such a partial result as the last feeding.
 */
async function latestFeedings(householdId: string, petId: string): Promise<(RawDoc & { date: unknown })[][]> {
  const reads = await latestFeedingReads(householdId, petId);
  return reads.map((read) => (read.status === 'fulfilled' ? read.value : []));
}

export async function createOneTimeChore({
  householdId,
  viewer,
  task,
  dueDate,
  assignee,
  room = null,
  onLateError,
}: {
  householdId: string;
  viewer: User;
  task: string;
  dueDate: string;
  assignee: QuickAddMember;
  room?: QuickAddRoom | null;
  onLateError: (error: unknown) => void;
}): Promise<{ choreId: string; status: 'saved' | 'queued' }> {
  const choreRef = doc(collection(db, 'households', householdId, 'chores'));
  const batch = writeBatch(db);
  const chore: Omit<Chore, 'id'> = {
    task,
    notes: '',
    ...assigneeFields(assignee),
    assignedToDisplayName: publicDisplayName(assignee.name),
    dueDate: new Date(`${dueDate}T12:00:00`).toISOString(),
    originalDueDate: dueDate,
    roomIds: room && room.id !== 'general' ? [room.id] : [],
    isCompleted: false,
    completedSubTasks: [],
    sourceType: 'temporary',
  };
  batch.set(choreRef, chore);
  // No "new chore" notification for a chore you give yourself.
  if (assignee.uid !== viewer.uid) {
    // Keyed by uid: notification state keys are readable by every member.
    const stateKey = `assigned|${dueDate}|${assignee.uid}`;
    const notificationId = getDeterministicNotificationId({ sourceType: 'chore-assignment', sourceId: choreRef.id, stateKey });
    batch.set(doc(db, 'households', householdId, 'notifications', notificationId), buildNotificationDocument({
      householdId,
      category: 'chores',
      title: 'New chore assigned',
      message: `You have a new chore: ${task}. Due ${format(new Date(`${dueDate}T12:00:00`), 'MMM d, yyyy')}.`,
      deepLink: '/chores',
      sourceType: 'chore-assignment',
      sourceId: choreRef.id,
      stateKey,
      targetUser: { uid: assignee.uid },
    }));
  }
  // Like the other quick-add writes: offline, the batch stays queued (it syncs on
  // reconnect) instead of waiting for a server acknowledgement that cannot come.
  const status = await awaitWriteUnlessOffline(batch.commit(), onLateError);
  return { choreId: choreRef.id, status };
}

/**
 * A repeating chore, as the Chores "Add Chore" dialog creates one with Repeats on:
 * one `chore-templates` document (unique id from the task, as Chores picks it) and,
 * for someone else, a "new repeating chore" notification. Then the household's
 * upkeep runs (as when the Chores page loads), so the first instance appears now
 * rather than at the next hourly run. Online only for the upkeep; the template
 * itself queues offline.
 */
export async function createRepeatingChore({
  householdId,
  viewer,
  task,
  repeat,
  firstDay,
  assignee,
  room,
  onLateError,
}: {
  householdId: string;
  viewer: User;
  task: string;
  repeat: QuickAddRepeat;
  /** yyyy-MM-dd of the first occurrence (biweekly anchor). */
  firstDay: string;
  assignee: QuickAddMember;
  room: QuickAddRoom | null;
  onLateError: (error: unknown) => void;
}): Promise<{ templateId: string; status: 'saved' | 'queued' }> {
  const templates = collection(db, 'households', householdId, 'chore-templates');
  // Always a new document: a readable slug plus a Firestore auto-id. Picking a free
  // readable id would need the full template list, which offline (or from cache)
  // may be incomplete, so a queued write could overwrite a template on reconnect.
  const templateId = quickCreateId(task, doc(templates).id, 'chore');
  const template = repeatingChoreTemplate({
    task,
    roomId: room?.id ?? null,
    recurrence: recurrenceFromRepeat(repeat, firstDay),
    assignee,
  });
  const status = await awaitWriteUnlessOffline(setDoc(doc(templates, templateId), template), onLateError);

  if (assignee.uid !== viewer.uid) {
    // As in Chores: the notification is best effort and never undoes the chore.
    void awaitWriteUnlessOffline(setDoc(doc(collection(db, 'households', householdId, 'notifications')), buildNotificationDocument({
      householdId,
      category: 'chores',
      title: 'New chore assigned',
      message: `You have a new repeating chore: ${task}.`,
      deepLink: '/chores',
      sourceType: 'chore-assignment',
      sourceId: templateId,
      targetUser: { uid: assignee.uid },
    })), onLateError).catch((error) => console.warn('Chore saved, but the notification failed:', error instanceof Error ? error.message : String(error)));
  }

  const user = auth.currentUser;
  if (status === 'saved' && user) {
    void user.getIdToken()
      .then((idToken) => syncHouseholdUpkeep({ idToken, householdId }))
      .catch((error) => console.warn('Household upkeep could not run.', error instanceof Error ? error.message : String(error)));
  }
  return { templateId, status };
}

/** A maintenance log, as the Maintenance "Add log" form writes it (routine, dated today). */
export async function logMaintenance({
  householdId,
  title,
  mileage,
  target,
  onLateError,
}: {
  householdId: string;
  title: string;
  mileage: number | null;
  target: MaintenanceTarget | null;
  onLateError: (error: unknown) => void;
}): Promise<{ logId: string; status: 'saved' | 'queued' }> {
  const logs = collection(db, 'households', householdId, 'maintenance');
  // Always a new document (see createRepeatingChore): never overwrites a log.
  const logId = quickCreateId(title, doc(logs).id, 'log');
  const data = quickMaintenanceLog({
    householdId,
    title,
    date: format(new Date(), 'yyyy-MM-dd'),
    mileage,
    target,
    nowIso: new Date().toISOString(),
  });
  const status = await awaitWriteUnlessOffline(setDoc(doc(logs, logId), data), onLateError);
  return { logId, status };
}
