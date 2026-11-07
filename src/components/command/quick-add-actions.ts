'use client';

/**
 * Writes for natural-language quick-add (H13). Each one uses the same document
 * contract as the module that owns the data, so Firestore rules and the module's
 * screens treat the result exactly like something added there:
 * - shopping items: merged into a still-needed item of the same name with the
 *   Shopping list's own transaction (`findMergeTarget` + `mergeIntoNeededItem`),
 *   otherwise created with `buildShoppingListItem` and the shared category
 *   resolution (the guarded, quota-counted categorizer; "Other" offline);
 * - feedings: the Pets module's `addFeedingLog`, defaulting to the pet's usual
 *   portion (`feedingPlan`) and the latest feeding's food type (`knownFoodType`),
 *   exactly like the one-tap feed button;
 * - one-time chores: a temporary task (chore + targeted assignment notification,
 *   skipped when you assign it to yourself), as Chores creates them;
 * - repeating chores: a chore template with the Chores dialog's recurrence shape
 *   (`repeatingChoreTemplate`), a unique template id as Chores picks it, and the
 *   same "new repeating chore" notification; server upkeep creates the instances;
 * - maintenance logs: a routine log like the Maintenance "Add log" form
 *   (`quickMaintenanceLog`), with the odometer reading on the vehicle's log.
 * Firestore rules check the same permissions as on those screens (chores.create,
 * maintenance.createLogs). Nothing is written until the person confirms the preview.
 */
import { Timestamp, collection, doc, getDocs, limit, orderBy, query, setDoc, where, writeBatch } from 'firebase/firestore';
import { syncHouseholdUpkeep } from '@/app/chores/actions';
import { format } from 'date-fns';
import { categorizeGroceryItem } from '@/ai/flows/categorize-grocery-item-flow';
import { getAiActionContext, unwrapAiActionResult } from '@/ai/client';
import { auth, db } from '@/lib/firebase';
import { awaitWriteUnlessOffline, getDocOfflineAware, getDocsOfflineAware, isBrowserOffline } from '@/lib/firestore-offline';
import { addFeedingLog, petLogsCollection } from '@/components/pets/pet-log-api';
import { foodTypeFromLatest } from '@/lib/dashboard/quick-add';
import type { RawDoc } from '@/lib/dashboard/facts';
import { loggerName } from '@/lib/pets/care';
import type { FoodType, PortionUnit } from '@/lib/pets/types';
import { findMergeTarget, type QuickAddEntry } from '@/lib/shopping/items';
import { shoppingAddOutcome, type ShoppingAddOutcome } from '@/lib/dashboard/quick-add';
import { mergeIntoNeededItem } from '@/lib/shopping/item-transactions';
import { buildNotificationDocument, getDeterministicNotificationId } from '@/lib/notifications';
import { resolveShoppingCategory } from '@/lib/shopping-categorization';
import { DEFAULT_SHOPPING_CATEGORIES, buildShoppingListItem, normalizeStoredCategories } from '@/lib/shopping-items';
import type { Chore, ShoppingListItem, User } from '@/lib/types';
import type { MaintenanceTarget, QuickAddList, QuickAddMember, QuickAddRepeat, QuickAddRoom } from '@/lib/dashboard/quick-add';
import { quickMaintenanceLog, recurrenceFromRepeat, repeatingChoreTemplate } from '@/lib/dashboard/quick-add-writes';
import { uniqueTemplateId } from '@/lib/chores/list';
import { slugify, stableSlugify } from '@/lib/utils';

export async function addShoppingItems(
  householdId: string,
  list: QuickAddList,
  items: QuickAddEntry[],
  onLateError: (error: unknown) => void,
): Promise<ShoppingAddOutcome> {
  const categoriesSnapshot = await getDocOfflineAware(doc(db, 'households', householdId, 'shopping-lists', list.id, 'config', 'categories')).catch(() => null);
  const categories = (categoriesSnapshot?.exists() ? normalizeStoredCategories(categoriesSnapshot.data()) : null) ?? DEFAULT_SHOPPING_CATEGORIES;
  const offline = isBrowserOffline();
  const itemsRef = collection(db, 'households', householdId, 'shopping-lists', list.id, 'items');
  // As on the Shopping list: online, a name that is still needed merges into that
  // item (the transaction re-checks it is still needed); offline nothing merges.
  const needed = offline ? [] : (await getDocs(query(itemsRef, where('status', '==', 'needed'))).catch(() => null))
    ?.docs.map((entry) => ({ id: entry.id, ...(entry.data() as Omit<ShoppingListItem, 'id'>) })) ?? [];
  // Each entry is its own write, settled independently (Shopping's quick-add
  // contract): one failure never hides which entries were saved, and a retry
  // sends only the failed ones, so nothing is added twice.
  const settled = await Promise.allSettled(items.map(async (item): Promise<'saved' | 'queued'> => {
    const target = findMergeTarget(needed, item.name);
    if (target && await mergeIntoNeededItem(doc(itemsRef, target.id), item.quantity)) return 'saved';
    const { category } = await resolveShoppingCategory({
      itemName: item.name,
      categories,
      selectedCategory: offline ? 'Other' : undefined,
      categorize: async (input) => unwrapAiActionResult(await categorizeGroceryItem(input, await getAiActionContext(householdId))),
    });
    const { itemId, data } = buildShoppingListItem({ name: item.name, quantity: item.quantity, category });
    return awaitWriteUnlessOffline(setDoc(doc(itemsRef, itemId), data), onLateError);
  }));
  return shoppingAddOutcome(items, settled);
}

// Feedings go through the Pets module's own writer, so quick-add entries carry the
// same shape (including who logged them) as the one-tap button and the full form.
export async function logFeeding(
  householdId: string,
  petId: string,
  amount: number,
  unit: PortionUnit,
  viewer: User,
  onLateError: (error: unknown) => void,
) {
  // Same fields as the Pets one-tap feed: the planned or given portion, the food
  // type of the pet's latest feeding, and no comment.
  const foodType = await latestFoodType(householdId, petId);
  return awaitWriteUnlessOffline(addFeedingLog(householdId, petId, {
    amount,
    unit,
    foodType,
    loggedByUid: viewer.uid,
    loggedByName: loggerName(viewer),
  }), onLateError);
}

/** Lowest Timestamp, so the Timestamp-shape query matches every Timestamp date. */
const MIN_TIMESTAMP = Timestamp.fromMillis(-62135596800000);

/**
 * The food type to reuse for a quick-logged meal, as the Pets workflow picks it:
 * `knownFoodType` of the latest feeding, read in both date shapes (Timestamps and
 * older ISO strings, which Firestore orders separately) with offline-aware reads.
 * Dry only when there is no readable history (Pets' own default).
 */
async function latestFoodType(householdId: string, petId: string): Promise<FoodType> {
  const logs = petLogsCollection(householdId, petId, 'feeding-logs');
  const latest = (floor: unknown) => getDocsOfflineAware(query(logs, where('date', '>=', floor), orderBy('date', 'desc'), limit(1)))
    .then((snapshot) => snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as RawDoc & { date: unknown }))
    .catch(() => []);
  const [stamped, strings] = await Promise.all([latest(MIN_TIMESTAMP), latest('')]);
  return foodTypeFromLatest([stamped, strings]);
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
    assignedToEmail: assignee.email,
    assignedToDisplayName: assignee.name || assignee.email,
    dueDate: new Date(`${dueDate}T12:00:00`).toISOString(),
    originalDueDate: dueDate,
    roomIds: room && room.id !== 'general' ? [room.id] : [],
    isCompleted: false,
    completedSubTasks: [],
    sourceType: 'temporary',
  };
  batch.set(choreRef, chore);
  // No "new chore" notification for a chore you give yourself.
  if (assignee.uid !== viewer.uid && assignee.email !== viewer.email) {
    const stateKey = `assigned|${dueDate}|${assignee.email}`;
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
      targetUser: { uid: assignee.uid, email: assignee.email, displayName: assignee.name } as User,
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
  // Chores picks a readable id that is not taken; if the ids cannot be read, a
  // random suffix keeps it from overwriting an existing template.
  const existing = await getDocsOfflineAware(templates).then((snapshot) => new Set(snapshot.docs.map((entry) => entry.id))).catch(() => null);
  const templateId = existing ? uniqueTemplateId(stableSlugify(task), existing) : slugify(task);
  const template = repeatingChoreTemplate({
    task,
    roomId: room?.id ?? null,
    recurrence: recurrenceFromRepeat(repeat, firstDay),
    assigneeEmail: assignee.email,
  });
  const status = await awaitWriteUnlessOffline(setDoc(doc(templates, templateId), template), onLateError);

  if (assignee.uid !== viewer.uid && assignee.email !== viewer.email) {
    // As in Chores: the notification is best effort and never undoes the chore.
    void awaitWriteUnlessOffline(setDoc(doc(collection(db, 'households', householdId, 'notifications')), buildNotificationDocument({
      householdId,
      category: 'chores',
      title: 'New chore assigned',
      message: `You have a new repeating chore: ${task}.`,
      deepLink: '/chores',
      sourceType: 'chore-assignment',
      sourceId: templateId,
      targetUser: { uid: assignee.uid, email: assignee.email, displayName: assignee.name } as User,
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
  const logId = slugify(title);
  const data = quickMaintenanceLog({
    householdId,
    title,
    date: format(new Date(), 'yyyy-MM-dd'),
    mileage,
    target,
    nowIso: new Date().toISOString(),
  });
  const status = await awaitWriteUnlessOffline(setDoc(doc(db, 'households', householdId, 'maintenance', logId), data), onLateError);
  return { logId, status };
}
