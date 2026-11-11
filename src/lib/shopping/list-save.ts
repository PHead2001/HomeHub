import type { ShoppingListType } from '@/lib/types';

/**
 * The list document written by the Create and Edit list form (SH-5a). Name and
 * description are trimmed, the type is kept as chosen (a custom list may be a
 * Grocery list, SH-5b), and a new list records who created it (`createdByUid`,
 * never changed by an edit). `storeId` is not written here: the category dialog
 * sets it.
 */
export function listSaveData(
  values: { name: string; description?: string; icon: string; type: ShoppingListType; color?: string },
  { isNew, uid }: { isNew: boolean; uid: string | null },
): Record<string, unknown> {
  return {
    name: values.name.replace(/\s+/g, ' ').trim(),
    description: (values.description ?? '').trim(),
    icon: values.icon,
    type: values.type,
    color: values.color ?? '',
    ...(isNew && uid ? { createdByUid: uid } : {}),
  };
}

/**
 * Whether a list created a moment ago is opened when its save comes back (SH-20a).
 * The dialog closes at once but the save may take up to 4 s, so the new list
 * opens only if nothing changed meanwhile: the same household, the same view as
 * at submit (no other list opened, no Back), and no newer creation was submitted
 * (several creations open only the last one).
 */
export function shouldOpenCreatedList({
  request,
  latestRequest,
  selectionAtSubmit,
  selectionNow,
  householdAtSubmit,
  householdNow,
}: {
  request: number;
  latestRequest: number;
  selectionAtSubmit: string | null;
  selectionNow: string | null;
  householdAtSubmit: string | null;
  householdNow: string | null;
}): boolean {
  return request === latestRequest && selectionNow === selectionAtSubmit && householdNow === householdAtSubmit;
}
