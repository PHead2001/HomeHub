// Shortcut hints for tooltips (H28), read from the one global shortcut map so a
// hint can never disagree with what the key does.
import { SHORTCUTS } from '@/lib/dashboard/shortcuts';

/** "Add item (A)" for the shortcut whose map label is `shortcutLabel`; `label` alone if none. */
export function shortcutTitle(label: string, shortcutLabel: string): string {
  const shortcut = SHORTCUTS.find((entry) => entry.label === shortcutLabel);
  return shortcut ? `${label} (${shortcut.keys.join(' then ')})` : label;
}

/** The map label of the `A` shortcut. */
export const ADD_SHOPPING_ITEM_SHORTCUT = 'Add a shopping item';
