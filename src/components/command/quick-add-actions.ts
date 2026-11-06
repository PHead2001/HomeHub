'use client';

/**
 * Writes for natural-language quick-add (H13). Each one uses the same document
 * contract as the module that owns the data, so Firestore rules and the module's
 * screens treat the result exactly like something added there:
 * - shopping items: `buildShoppingListItem` plus the share target's category
 *   resolution (the guarded, quota-counted categorizer; "Other" offline);
 * - feedings: the Pets feeding-log shape with the form's defaults;
 * - one-time chores: a temporary task (chore + targeted assignment notification,
 *   skipped when you assign it to yourself), as Chores creates them.
 * Nothing is written until the person confirms the preview.
 */
import { collection, doc, getDoc, setDoc, writeBatch } from 'firebase/firestore';
import { format } from 'date-fns';
import { categorizeGroceryItem } from '@/ai/flows/categorize-grocery-item-flow';
import { getAiActionContext, unwrapAiActionResult } from '@/ai/client';
import { db } from '@/lib/firebase';
import { awaitWriteUnlessOffline, isBrowserOffline } from '@/lib/firestore-offline';
import { addFeedingLog } from '@/components/pets/pet-log-api';
import { loggerName } from '@/lib/pets/care';
import { buildNotificationDocument, getDeterministicNotificationId } from '@/lib/notifications';
import { resolveShoppingCategory } from '@/lib/shopping-categorization';
import { DEFAULT_SHOPPING_CATEGORIES, buildShoppingListItem, normalizeStoredCategories } from '@/lib/shopping-items';
import type { Chore, User } from '@/lib/types';
import type { QuickAddList, QuickAddMember } from '@/lib/dashboard/quick-add';

export async function addShoppingItems(
  householdId: string,
  list: QuickAddList,
  items: Array<{ name: string; quantity: number }>,
  onLateError: (error: unknown) => void,
): Promise<'saved' | 'queued'> {
  const categoriesSnapshot = await getDoc(doc(db, 'households', householdId, 'shopping-lists', list.id, 'config', 'categories')).catch(() => null);
  const categories = (categoriesSnapshot?.exists() ? normalizeStoredCategories(categoriesSnapshot.data()) : null) ?? DEFAULT_SHOPPING_CATEGORIES;
  const offline = isBrowserOffline();
  let status: 'saved' | 'queued' = 'saved';
  for (const item of items) {
    const { category } = await resolveShoppingCategory({
      itemName: item.name,
      categories,
      selectedCategory: offline ? 'Other' : undefined,
      categorize: async (input) => unwrapAiActionResult(await categorizeGroceryItem(input, await getAiActionContext(householdId))),
    });
    const { itemId, data } = buildShoppingListItem({ name: item.name, quantity: item.quantity, category });
    const result = await awaitWriteUnlessOffline(
      setDoc(doc(db, 'households', householdId, 'shopping-lists', list.id, 'items', itemId), data),
      onLateError,
    );
    if (result === 'queued') status = 'queued';
  }
  return status;
}

// Feedings go through the Pets module's own writer, so quick-add entries carry the
// same shape (including who logged them) as the one-tap button and the full form.
export async function logFeeding(
  householdId: string,
  petId: string,
  amount: number | null,
  unit: 'Cups' | 'Cans' | 'Scoops' | null,
  viewer: User,
  onLateError: (error: unknown) => void,
) {
  return awaitWriteUnlessOffline(addFeedingLog(householdId, petId, {
    amount: amount ?? 1,
    unit: unit ?? 'Cups',
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
