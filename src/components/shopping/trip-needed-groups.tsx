'use client';

import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { AisleGroup } from '@/lib/shopping/items';
import { aisleTargetIds } from '@/lib/shopping/trip-mode';
import type { ShoppingListItem } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ShoppingItemRow } from './shopping-item-row';
import styles from './trip-mode.module.css';

/** A callback that keeps one identity across renders and always calls the latest function. */
function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

type GroupProps = {
  group: AisleGroup<ShoppingListItem>;
  headingId: string;
  headingClass: string;
  canToggle: boolean;
  canOpenEditor: boolean;
  onToggle: (item: ShoppingListItem) => void;
  onEdit: (item: ShoppingListItem) => void;
  /** Per row id: "Sam added · 2d" and the shown photo, as primitives so rows stay memoised. */
  rowExtras: ReadonlyMap<string, { attribution: string | null; photo: string | null | undefined; enterDelay: number | undefined }>;
};

/** One aisle: its sticky heading and rows (memoised: an untouched aisle does not re-render). */
const AisleSection = memo(function AisleSection({ group, headingId, headingClass, canToggle, canOpenEditor, onToggle, onEdit, rowExtras }: GroupProps) {
  return (
    <>
      <h4 id={headingId} className={cn(styles.aisle, 'mb-1 px-2 py-1.5 text-sm font-semibold uppercase tracking-wide coarse:text-base', headingClass)}>
        {group.category}
      </h4>
      <AnimatePresence initial={false}>
        {group.items.map((item) => {
          const extras = rowExtras.get(item.id);
          return (
            <ShoppingItemRow
              key={`item:${item.id}`}
              trip
              item={item}
              canToggle={canToggle}
              canOpenEditor={canOpenEditor}
              onToggle={onToggle}
              onEdit={onEdit}
              attribution={extras?.attribution ?? null}
              photoUrl={extras?.photo}
              enterDelay={extras?.enterDelay}
            />
          );
        })}
      </AnimatePresence>
    </>
  );
}, (before, after) => {
  if (before.group !== after.group && (before.group.category !== after.group.category || before.group.items.length !== after.group.items.length
    || before.group.items.some((item, index) => item !== after.group.items[index]))) return false;
  if (before.headingId !== after.headingId || before.headingClass !== after.headingClass || before.canToggle !== after.canToggle
    || before.canOpenEditor !== after.canOpenEditor || before.onToggle !== after.onToggle || before.onEdit !== after.onEdit) return false;
  return after.group.items.every((item) => {
    const a = before.rowExtras.get(item.id);
    const b = after.rowExtras.get(item.id);
    return a?.attribution === b?.attribution && a?.photo === b?.photo && a?.enterDelay === b?.enterDelay;
  });
});

/**
 * The open list's needed items by aisle in trip mode (S8b): each aisle a section
 * with a sticky heading (SH-18a, SH-33c; one level below the "Needed" section
 * heading, SH-26d), flowing into two or three columns when the list is wide
 * (SH-14a), with taller rows on touch (SH-33b). Aisles and rows are memoised and
 * no row runs a layout animation (SH-27c).
 */
export function TripNeededGroups({
  groups,
  headingClass,
  canToggle,
  canOpenEditor,
  onToggle,
  onEdit,
  attributionFor,
  photoFor,
  enterDelayFor,
}: {
  groups: readonly AisleGroup<ShoppingListItem>[];
  headingClass: string;
  canToggle: boolean;
  canOpenEditor: boolean;
  onToggle: (item: ShoppingListItem) => void;
  onEdit: (item: ShoppingListItem) => void;
  attributionFor: (item: ShoppingListItem) => string | null;
  photoFor: (item: ShoppingListItem) => string | null | undefined;
  /** The staggered entrance delay of a row on a freshly opened list, or undefined. */
  enterDelayFor: (groupIndex: number, itemIndex: number) => number | undefined;
}) {
  const toggle = useStableCallback(onToggle);
  const edit = useStableCallback(onEdit);
  const headingIds = useMemo(() => aisleTargetIds(groups), [groups]);
  const rowExtras = new Map<string, { attribution: string | null; photo: string | null | undefined; enterDelay: number | undefined }>();
  groups.forEach((group, groupIndex) => group.items.forEach((item, itemIndex) => {
    rowExtras.set(item.id, { attribution: attributionFor(item), photo: photoFor(item), enterDelay: enterDelayFor(groupIndex, itemIndex) });
  }));

  return (
    <div className={styles.groups}>
      <div className={styles.flow} data-testid="trip-groups">
        <AnimatePresence initial={false}>
          {groups.map((group, index) => (
            <motion.section
              key={`aisle:${group.category}`}
              className={cn(styles.group, 'pb-3')}
              data-testid="trip-aisle"
              exit={{ opacity: 0, transition: { duration: 0.12, delay: 0.15 } }}
            >
              <AisleSection
                group={group}
                headingId={headingIds[index]}
                headingClass={headingClass}
                canToggle={canToggle}
                canOpenEditor={canOpenEditor}
                onToggle={toggle}
                onEdit={edit}
                rowExtras={rowExtras}
              />
            </motion.section>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
