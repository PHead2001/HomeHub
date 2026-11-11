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
