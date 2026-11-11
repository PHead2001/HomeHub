'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CategoryConfig } from '@/lib/shopping/category-order';
import { neededAisleGroups } from '@/lib/shopping/overview';
import { aisleChips, filterAisleGroups, findHint, findQuery, leftLabel } from '@/lib/shopping/trip-mode';
import type { ShoppingListItem } from '@/lib/types';
import { useTripWakeLock } from './use-trip-wake-lock';

/**
 * The open list's trip mode state (S8b): the needed items by aisle (memoised),
 * narrowed by the quick-add field's text (SH-18c), the aisle chips (SH-18b), the
 * "n left" pill (SH-33d), the screen wake lock on phones (SH-33a) and the
 * `data-shopping-trip` flag on <html> that moves the tab bar's "+" aside (SH-12d).
 */
export function useTripMode({
  listId,
  active,
  items,
  config,
  store,
}: {
  /** The open list, or null on the overview. */
  listId: string | null;
  /** The open list is on screen (its tab is shown). */
  active: boolean;
  items: readonly ShoppingListItem[];
  config: Pick<CategoryConfig, 'list' | 'ordered'>;
  store: { aisleOrder: readonly unknown[] } | null;
}) {
  const open = Boolean(listId) && active;
  useTripWakeLock(open);

  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    root.setAttribute('data-shopping-trip', 'open');
    return () => root.removeAttribute('data-shopping-trip');
  }, [open]);

  // The field's text, per list: another list starts unfiltered.
  const [find, setFind] = useState<{ listId: string | null; text: string }>({ listId: null, text: '' });
  const text = find.listId === listId ? find.text : '';

  const groups = useMemo(
    () => (listId ? neededAisleGroups(items, config, store) : []),
    [listId, items, config, store],
  );
  const query = findQuery(text);
  const shownGroups = useMemo(() => filterAisleGroups(groups, query), [groups, query]);
  const chips = useMemo(() => aisleChips(groups), [groups]);
  const neededCount = groups.reduce((sum, group) => sum + group.items.length, 0);
  const matches = shownGroups.reduce((sum, group) => sum + group.items.length, 0);

  return {
    /** Every needed item by aisle, in walk order (row focus order and the entrance stagger use it). */
    groups,
    /** The aisles shown: `groups` narrowed by the field's text. */
    shownGroups,
    /** The aisle chips, hidden while the field filters (every aisle is then a jump away anyway). */
    chips: query ? [] : chips,
    left: leftLabel(neededCount, items.length),
    filtering: query !== null,
    hint: findHint(query, matches, text),
    setFindText: (next: string) => setFind((current) => (current.listId === listId && current.text === next ? current : { listId, text: next })),
  };
}
