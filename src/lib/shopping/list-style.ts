/**
 * List tints and icons (D14). A list is tinted with one of the eight palette
 * slots (`--member-1` … `--member-8`): they are defined per theme preset and
 * contrast-tested as text on every surface and as fills, so a tint can never
 * make a list unreadable. Lists store the slot as `color: "tint-N"`; older lists
 * that stored a free hex color (or nothing) get a stable slot from their id, so
 * no document needs migrating.
 */

import { memberColorFromIndex, memberColorIndex, type MemberColorIndex } from '../member-colors';
import type { ShoppingList, ShoppingListType } from '@/lib/types';

export const LIST_TINT_COUNT = 8;
export const LIST_TINT_VALUES = Array.from({ length: LIST_TINT_COUNT }, (_, i) => `tint-${i + 1}`);

/**
 * Names a member hears for each slot in the color picker (SH-26c): the colour,
 * from the member hues every theme shares (teal 172°, sky 205°, blue 238°,
 * violet 272°, pink 322°, red 8°, orange 36°, lime 96°).
 */
export const LIST_TINT_LABELS: Record<MemberColorIndex, string> = {
  1: 'Teal', 2: 'Sky blue', 3: 'Blue', 4: 'Violet', 5: 'Pink', 6: 'Red', 7: 'Orange', 8: 'Lime',
};

/** True for a stored `tint-N` value (N = 1..8). */
export function isListTint(value: unknown): value is string {
  return typeof value === 'string' && /^tint-[1-8]$/.test(value);
}

/** The palette slot for a list: its chosen tint, or a stable slot from its id. */
export function listTintIndex(list: Pick<ShoppingList, 'id' | 'color'>): MemberColorIndex {
  if (isListTint(list.color)) return Number(list.color.slice(5)) as MemberColorIndex;
  return memberColorIndex(list.id || 'list');
}

/** Token classes and colors for a list's tint. */
export function listTint(list: Pick<ShoppingList, 'id' | 'color'>) {
  return memberColorFromIndex(listTintIndex(list));
}

/** Icon name for each list type, used when a stored icon name is unknown. */
export const LIST_TYPE_ICON: Record<ShoppingListType, string> = {
  Grocery: 'ShoppingCart',
  Auto: 'Car',
  Hardware: 'Wrench',
  Pets: 'PawPrint',
  Custom: 'ClipboardList',
};

/** The icon name to render: the stored one when known, otherwise the list type's icon. */
export function resolveListIconName(list: Pick<ShoppingList, 'icon' | 'type'>, knownIcons: ReadonlySet<string>): string {
  if (list.icon && knownIcons.has(list.icon)) return list.icon;
  return LIST_TYPE_ICON[list.type] ?? LIST_TYPE_ICON.Custom;
}
