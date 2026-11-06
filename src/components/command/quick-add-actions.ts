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
 *   portion (`feedingPlan`) like the one-tap feed button;
 * - one-time chores: a temporary task (chore + targeted assignment notification,
 *   skipped when you assign it to yourself), as Chores creates them.
 * Nothing is written until the person confirms the preview.
 */
import { collection, doc, getDoc, getDocs, query, setDoc, where, writeBatch } from 'firebase/firestore';
import { format } from 'date-fns';
import { categorizeGroceryItem } from '@/ai/flows/categorize-grocery-item-flow';
import { getAiActionContext, unwrapAiActionResult } from '@/ai/client';
import { db } from '@/lib/firebase';
import { awaitWriteUnlessOffline, isBrowserOffline } from '@/lib/firestore-offline';
import { addFeedingLog } from '@/components/pets/pet-log-api';
import { loggerName } from '@/lib/pets/care';
import type { PortionUnit } from '@/lib/pets/types';
import { findMergeTarget, type QuickAddEntry } from '@/lib/shopping/items';
import { shoppingAddOutcome, type ShoppingAddOutcome } from '@/lib/dashboard/quick-add';
import { mergeIntoNeededItem } from '@/lib/shopping/item-transactions';
import { buildNotificationDocument, getDeterministicNotificationId } from '@/lib/notifications';
import { resolveShoppingCategory } from '@/lib/shopping-categorization';
import { DEFAULT_SHOPPING_CATEGORIES, buildShoppingListItem, normalizeStoredCategories } from '@/lib/shopping-items';
import type { Chore, ShoppingListItem, User } from '@/lib/types';
import type { QuickAddList, QuickAddMember } from '@/lib/dashboard/quick-add';

export async function addShoppingItems(
  householdId: string,
  list: QuickAddList,
  items: QuickAddEntry[],
  onLateError: (error: unknown) => void,
): Promise<ShoppingAddOutcome> {
  const categoriesSnapshot = await getDoc(doc(db, 'households', householdId, 'shopping-lists', list.id, 'config', 'categories')).catch(() => null);
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
  return awaitWriteUnlessOffline(addFeedingLog(householdId, petId, {
    amount,
    unit,
    foodType: 'Dry',
    comments: 'Logged with quick add',
    loggedByUid: viewer.uid,
    loggedByName: loggerName(viewer),
  }), onLateError);
}

export async function createOneTimeChore({
  householdId,
  viewer,
  task,
  dueDate,
  assignee,
}: {
  householdId: string;
  viewer: User;
  task: string;
  dueDate: string;
  assignee: QuickAddMember;
}) {
  const choreRef = doc(collection(db, 'households', householdId, 'chores'));
  const batch = writeBatch(db);
  const chore: Omit<Chore, 'id'> = {
    task,
    notes: '',
    assignedToEmail: assignee.email,
    assignedToDisplayName: assignee.name || assignee.email,
    dueDate: new Date(`${dueDate}T12:00:00`).toISOString(),
    originalDueDate: dueDate,
    roomIds: [],
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
  await batch.commit();
}
