'use client';

import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { PlusCircle, ShoppingBasket } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/empty-state';
import { NumberTicker } from '@/components/motion/number-ticker';
import { Stagger } from '@/components/motion/stagger';
import type { AisleGroup } from '@/lib/shopping/items';
import { neededEmptyCopy, shoppingActivity, writeWaitText } from '@/lib/shopping/overview';
import { listTint } from '@/lib/shopping/list-style';
import type { ShoppingList, ShoppingListItem, ShoppingStore } from '@/lib/types';
import { cn } from '@/lib/utils';
import { renderListIcon } from './list-icons';
import { QuickAddBar, type QuickAddOutcome } from './quick-add-bar';
import { ShoppingItemRow } from './shopping-item-row';
import { UndoSnackbar, type SnackbarEntry } from './undo-snackbar';
import type { QuickAddEntry } from '@/lib/shopping/items';
import styles from './shopping-overview.module.css';

/** The Grocery list shown inline on the overview, with what the section needs from the page. */
export type OverviewGrocery = {
  list: ShoppingList;
  /** Every Grocery list (a switcher appears when there are several). */
  groceries: readonly ShoppingList[];
  onPick: (listId: string) => void;
  /** The list's items from the page's items listener (needed and purchased). */
  items: readonly ShoppingListItem[];
  /** Its needed items by aisle (`neededAisleGroups`). */
  groups: AisleGroup<ShoppingListItem>[];
  loading: boolean;
  fromCache: boolean;
  hasPendingWrites: boolean;
  store: ShoppingStore | null;
  attributionFor: (item: ShoppingListItem) => string | null;
  /** The row's photo as the open list shows it (the live Barcode Library first, `rowPhoto`). */
  photoFor: (item: ShoppingListItem) => string | null;
  onToggle: (item: ShoppingListItem) => void;
  /** Why adds and ticks must wait (`writeWait`), or null when they may run. */
  writeWait: 'loading' | 'retrying' | null;
  onQuickAdd: (entries: QuickAddEntry[]) => Promise<QuickAddOutcome>;
  onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
};

/** The overview's width is under 40rem (the phone layout, matching the CSS container query). */
function useNarrow(element: HTMLElement | null, rem = 40) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const remPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setNarrow(element.getBoundingClientRect().width < rem * remPx);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, rem]);
  return narrow;
}

/**
 * The Shopping Lists overview (S8a: SH-11a–c, SH-28c): the household's Grocery
 * list inline (its needed items by aisle in responsive columns, each row tickable
 * like inside the list, and a large quick-add field), the pantry's expiring chips,
 * and every list as a card. Laid out by the width it has (container queries in
 * shopping-overview.module.css): on the wall tablet and desktops the Grocery
 * section sits beside a rail; on a phone everything is one column and the
 * quick-add field is a dock above the tab bar.
 */
export function ShoppingOverview({
  lists,
  canEdit,
  grocery,
  groceryWaiting,
  uid,
  memberNames,
  localOpIds,
  selfKnown,
  now,
  expiring,
  snackbarEntries,
  onCreateList,
  renderListCard,
}: {
  lists: readonly ShoppingList[];
  canEdit: boolean;
  grocery: OverviewGrocery | null;
  /** A Grocery list exists but which one to show is not known yet (the household default is loading). */
  groceryWaiting: boolean;
  uid: string | null;
  memberNames: ReadonlyMap<string, string>;
  /** purchaseOpIds of ticks made on this device (they are not "someone shopping"). */
  localOpIds: ReadonlySet<string>;
  /** `localOpIds` is complete (device storage works): otherwise the member's own ticks never read as "another device". */
  selfKnown: boolean;
  now: number;
  /** The expiring-soon chips (rendered by the page, from the pantry listener). */
  expiring?: ReactNode;
  snackbarEntries: SnackbarEntry[];
  onCreateList: () => void;
  renderListCard: (list: ShoppingList, options: { compact: boolean }) => ReactNode;
}) {
  // A callback ref: the root mounts only once there is a list.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const narrow = useNarrow(root);
  const items = grocery?.items;
  const activity = useMemo(
    () => (items ? shoppingActivity({ items, now, uid, localOpIds, names: memberNames, selfKnown }) : null),
    [items, now, uid, localOpIds, memberNames, selfKnown],
  );

  if (lists.length === 0) {
    return (
      <>
        {snackbarEntries.length > 0 && <UndoSnackbar floating entries={snackbarEntries} />}
        <EmptyState
          kind="lists"
          title="No shopping lists yet"
          description={canEdit ? 'Start with groceries, a hardware run or anything else you shop for.' : 'Lists your household creates will show up here.'}
          action={canEdit ? { label: 'Create a list', icon: <PlusCircle className="mr-2 h-4 w-4" aria-hidden />, onClick: onCreateList } : undefined}
          className="rounded-xl border border-dashed"
        />
      </>
    );
  }

  // On a phone the Undo sits in the quick-add dock, directly above the field;
  // elsewhere it floats near the bottom, away from the content.
  const dockSnackbar = narrow && canEdit && grocery !== null;
  const tint = grocery ? listTint(grocery.list) : null;

  return (
    <div ref={setRoot} className={styles.root} data-testid="shopping-overview">
      {!dockSnackbar && snackbarEntries.length > 0 && <UndoSnackbar floating entries={snackbarEntries} />}
      <div className={styles.layout}>
        {grocery && tint ? (
          <section
            aria-labelledby="overview-grocery-heading"
            className={cn(styles.grocery, 'rounded-xl border bg-card p-4 text-card-foreground shadow-raised sm:p-5')}
            data-testid="grocery-overview"
            data-list-id={grocery.list.id}
            data-from-cache={grocery.fromCache ? 'true' : 'false'}
            data-pending-writes={grocery.hasPendingWrites ? 'true' : 'false'}
          >
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2" style={{ order: 0 }}>
              <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', tint.classes.softChip)}>
                {renderListIcon(grocery.list, { className: 'h-5 w-5' })}
              </span>
              <div className="min-w-0 flex-1">
                <h2 id="overview-grocery-heading" className="break-words font-headline text-xl font-semibold leading-tight">
                  {grocery.list.name}
                </h2>
                <p className="text-sm text-muted-foreground">
                  <NumberTicker value={grocery.groups.reduce((sum, group) => sum + group.items.length, 0)} animateOnMount={false} /> to buy
                  {grocery.store && <> · Sorted for {grocery.store.name}</>}
                </p>
              </div>
              {grocery.groceries.length > 1 && (
                <Select value={grocery.list.id} onValueChange={grocery.onPick}>
                  <SelectTrigger aria-label="Grocery list shown here" className="h-11 w-auto min-w-[9rem] max-w-full coarse:h-12">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {grocery.groceries.map((list) => (
                      <SelectItem key={list.id} value={list.id}>{list.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button variant="outline" onClick={grocery.onOpen} aria-label={`Open ${grocery.list.name}`} className="h-11 coarse:h-12">
                Open list
              </Button>
              {activity && (
                <p role="status" data-testid="shopping-activity" className="w-full rounded-lg bg-success/10 px-3 py-1.5 text-sm font-medium text-success">
                  <ShoppingBasket className="mr-1.5 inline h-4 w-4 align-[-0.15em]" aria-hidden />
                  {activity.label}
                </p>
              )}
            </div>
            {canEdit && (
              <QuickAddBar
                // Keyed per list: a pending save's leftovers never land in another list's field.
                key={grocery.list.id}
                listName={grocery.list.name}
                onAdd={grocery.onQuickAdd}
                large
                loading={grocery.writeWait !== null}
                loadingText={grocery.writeWait ? writeWaitText(grocery.writeWait, grocery.list.name) : undefined}
                className={cn(styles.quickAdd, 'space-y-2')}
                above={dockSnackbar && snackbarEntries.length > 0 ? <UndoSnackbar entries={snackbarEntries} /> : undefined}
              />
            )}
            <div className={styles.items} data-overview-focus="" tabIndex={-1}>
              {grocery.loading ? (
                <div className="space-y-2" role="status" aria-label="Loading items">
                  <Skeleton className="h-6 w-32" />
                  <Skeleton className="h-11 w-full" />
                  <Skeleton className="h-11 w-full" />
                </div>
              ) : grocery.groups.length === 0 ? (
                <EmptyState compact kind="lists" headingLevel={3} {...neededEmptyCopy({ total: grocery.items.length, canEdit })} />
              ) : (
                <div className={styles.columns}>
                  <AnimatePresence initial={false}>
                    {grocery.groups.map((group) => (
                      <motion.div
                        key={`aisle:${group.category.toLowerCase()}`}
                        exit={{ opacity: 0, transition: { duration: 0.12, delay: 0.15 } }}
                        className={styles.group}
                        data-testid="overview-aisle"
                      >
                        <h3 className={cn('mb-1 px-2 text-sm font-semibold uppercase tracking-wide', tint.classes.text)}>{group.category}</h3>
                        <AnimatePresence initial={false}>
                          {group.items.map((item) => (
                            <ShoppingItemRow
                              key={`item:${item.id}`}
                              item={item}
                              canToggle={canEdit}
                              // Editing happens in the open list (the edit sheet lives there).
                              canOpenEditor={false}
                              onToggle={grocery.onToggle}
                              onEdit={() => undefined}
                              attribution={grocery.attributionFor(item)}
                              photoUrl={grocery.photoFor(item)}
                            />
                          ))}
                        </AnimatePresence>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </div>
          </section>
        ) : groceryWaiting ? (
          <div className="space-y-3 rounded-xl border bg-card p-5" role="status" aria-label="Loading the Grocery list">
            <Skeleton className="h-7 w-40" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        ) : (
          <EmptyState
            compact
            kind="lists"
            title="No Grocery list yet"
            description={canEdit ? 'A Grocery list shows its items right here, ready to tick, with a field to add more.' : 'When your household makes a Grocery list, its items show up here.'}
            action={canEdit ? { label: 'Create a list', icon: <PlusCircle className="mr-2 h-4 w-4" aria-hidden />, onClick: onCreateList } : undefined}
            className="rounded-xl border border-dashed"
            data-testid="grocery-overview-empty"
          />
        )}

        <div className={styles.rail}>
          {expiring}
          <section aria-labelledby="overview-lists-heading" className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 id="overview-lists-heading" className="font-headline text-lg font-semibold">All lists</h2>
              {canEdit && (
                <Button onClick={onCreateList} className="coarse:h-12">
                  <PlusCircle className="mr-2" aria-hidden /> Create New List
                </Button>
              )}
            </div>
            <Stagger className={styles.cards}>
              {lists.map((list) => renderListCard(list, { compact: true }))}
            </Stagger>
          </section>
        </div>
      </div>
    </div>
  );
}
