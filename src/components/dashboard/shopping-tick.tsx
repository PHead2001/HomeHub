'use client';

/**
 * HP-33c / HP-36b: tick a needed item from the dashboard's Shopping tile with Shopping's
 * shared tick (`tickShoppingItem` in `src/lib/shopping/tick.ts`, the same operation the
 * Shopping page's rows call): the reader's uid as the buyer, the server's time, a fresh
 * `purchaseOpId`, never over a purchase the live list already shows, queued offline with
 * the same honest status, and a 10 s Undo through the shared Undo (`undoShoppingTick`,
 * refused with "Changed by someone else — not undone" when someone ticked it again).
 *
 * The rows come from the dashboard's live listeners, which show a tick at once (offline
 * too), so a ticked row leaves the tile by itself; a failed tick comes back with Retry.
 */
import { useCallback, useEffect, useRef } from 'react';
import Link from 'next/link';
import { ToastAction } from '@/components/ui/toast';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { playFeedback } from '@/lib/feedback';
import { UNDO_WINDOW_MS } from '@/lib/undo-window';
import { offlineTickNote } from '@/lib/shopping/save-status';
import { notUndoneNotice, reportFailure, tickShoppingItem, undoShoppingTick } from '@/lib/shopping/tick';
import { shoppingTickIO } from '@/lib/shopping/tick-firestore';
import type { ShoppingTileItem } from '@/lib/dashboard/facts';
import { focusAfterTick, shoppingRowKey, TICK_DONE_STATES, type TickRowState } from '@/lib/dashboard/shopping-tile';
import { cn } from '@/lib/utils';
import { ActionButton } from './one-tap';
import { useDoneTracking } from './use-done-tracking';
import styles from './dashboard.module.css';

const TILE_SELECTOR = '[data-testid="dashboard-tile-shopping"]';
const TILE_LINK_SELECTOR = '[data-testid="dashboard-tile-shopping-link"]';

/** The tile's tick controls that are on screen (rows hidden beside the house are skipped), in order. */
function visibleTickKeys(tile: Element | null): string[] {
  if (!tile) return [];
  return [...tile.querySelectorAll<HTMLElement>('[data-tick-key]')]
    .filter((control) => control.getClientRects().length > 0)
    .map((control) => control.dataset.tickKey ?? '');
}

/**
 * The control to focus once the ticked row has left: the target row's tick, else the
 * tile link. Resolved from the tile mounted now, not the one seen at the tick: the last
 * row's departure re-mounts the tile (with rows it is a card around a link, without them
 * the tile is the link itself).
 */
function focusTargetAfterTick(targetKey: string | null): HTMLElement | null {
  const tile = document.querySelector<HTMLElement>(TILE_SELECTOR);
  if (!tile) return null;
  const row = targetKey ? tile.querySelector<HTMLElement>(`[data-tick-key="${CSS.escape(targetKey)}"]`) : null;
  return row ?? tile.querySelector<HTMLElement>(TILE_LINK_SELECTOR) ?? (tile.matches('a[href]') ? tile : null);
}

/**
 * Focus after a tick (SH-26a on the dashboard): once the ticked row has left, focus goes
 * to the next row's tick (else the previous one, else the tile link), and only when it was
 * on the ticked control, so it never jumps from somewhere the member moved to.
 */
function focusWhenRowLeaves(button: HTMLButtonElement, targetKey: string | null, frames = 20) {
  requestAnimationFrame(() => {
    if (button.isConnected) {
      // Still listed (saving, or the tick failed): focus stays on it.
      if (frames > 0) focusWhenRowLeaves(button, targetKey, frames - 1);
      return;
    }
    const active = document.activeElement;
    if (active && active !== document.body) return;
    focusTargetAfterTick(targetKey)?.focus({ preventScroll: true });
  });
}

/**
 * The tile's tick states. `liveKeys` are the listed rows' keys from live (or stale)
 * listener data, undefined while loading; a row is tickable only while it is listed.
 */
export function useShoppingTick(liveKeys?: readonly string[]) {
  const { currentUser } = useAuth();
  const { toast } = useToast();
  const { states, set, settle } = useDoneTracking<TickRowState>(liveKeys, TICK_DONE_STATES);
  const busy = useRef(new Set<string>());
  const live = useRef<ReadonlySet<string>>(new Set());
  // The first offline tick on this page carries the offline note in its Undo (SH-7c).
  const offlineNoted = useRef(false);
  const liveKey = liveKeys?.join('|');
  const householdId = currentUser?.householdId ?? null;
  const uid = currentUser?.uid ?? null;

  useEffect(() => {
    live.current = new Set(liveKeys ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey]);

  const undo = useCallback(async (item: ShoppingTileItem, opId: string) => {
    if (!householdId) return;
    // The dashboard lists only needed items, so it cannot tell a newer purchase: the
    // rules decide (accepted only while this tick's purchaseOpId stands).
    const started = undoShoppingTick(shoppingTickIO, { path: { householdId, listId: item.listId, itemId: item.id }, opId, known: undefined });
    if (started.status === 'already') return;
    if (started.status === 'refused') {
      toast(notUndoneNotice(item.name)!);
      return;
    }
    const state = await reportFailure(started.track(), (error) => {
      toast(notUndoneNotice(item.name, error) ?? { variant: 'destructive', title: `Could not undo ${item.name}` });
    });
    if (state !== 'failed') set(shoppingRowKey(item), null);
  }, [householdId, set, toast]);

  const tick = useCallback(async (item: ShoppingTileItem, button: HTMLButtonElement) => {
    const key = shoppingRowKey(item);
    if (!householdId || !uid || busy.current.has(key)) return;
    const tile = button.closest(TILE_SELECTOR);
    const hadFocus = document.activeElement === button;
    const targetKey = focusAfterTick(visibleTickKeys(tile), key);
    // The live list lists needed items only: a row no longer in it was ticked or removed elsewhere.
    const started = tickShoppingItem(shoppingTickIO, {
      path: { householdId, listId: item.listId, itemId: item.id },
      uid,
      current: live.current.has(key) ? { status: 'needed' } : null,
    });
    if (started.status !== 'ticked') {
      set(key, null);
      toast({ title: 'Already changed', description: `${item.name} was ticked or removed on another device.` });
      return;
    }
    busy.current.add(key);
    set(key, 'saving');
    playFeedback('complete');
    if (hadFocus) focusWhenRowLeaves(button, targetKey);
    try {
      let note: string | undefined;
      if (started.offline && !offlineNoted.current) {
        offlineNoted.current = true;
        note = offlineTickNote(await started.storedLocally());
      }
      // The Undo is offered at once, as on the Shopping page; a refusal (now or after a
      // late answer) withdraws it, says so and brings the row back with Retry.
      const handle = toast({
        group: 'shopping-tick',
        title: `${item.name} is in the cart`,
        description: note,
        duration: UNDO_WINDOW_MS,
        action: (
          <ToastAction altText={`Undo ticking ${item.name}`} onClick={() => { handle.dismiss(); void undo(item, started.opId); }}>
            Undo
          </ToastAction>
        ),
      });
      const state = await reportFailure(started.track(), () => {
        handle.dismiss();
        set(key, 'failed');
        toast({ variant: 'destructive', title: `Could not tick ${item.name}`, description: 'It is still on the list. Try again.' });
      });
      // Done until the row leaves; not if it was un-ticked elsewhere before this answer.
      if (state !== 'failed') settle(key);
    } finally {
      busy.current.delete(key);
    }
  }, [householdId, uid, set, settle, toast, undo]);

  return { states, tick };
}

export type ShoppingTick = ReturnType<typeof useShoppingTick>;

/**
 * The needed items below the tile's link, each with a tick for members with
 * `shopping.edit`. Beside the house only as many rows show as the screen height allows
 * (`.shoppingRows` in dashboard.module.css, `WIDE_TICK_ROW_STEPS`), and "+N more" is
 * left to the tile link.
 */
export function ShoppingTickRows({
  rows, more, showLists, canTick, tick,
}: {
  rows: ShoppingTileItem[];
  more: number;
  showLists: boolean;
  canTick: boolean;
  tick: ShoppingTick;
}) {
  if (rows.length === 0) return null;
  return (
    <div className={cn(styles.shoppingWork, 'flex min-w-0 flex-col gap-2')} data-testid="dashboard-shopping-items">
      <ul className={cn(styles.shoppingRows, 'flex flex-col gap-1.5')} aria-label="Needed shopping items">
        {rows.map((item) => {
          const key = shoppingRowKey(item);
          return (
            <li key={key} className="flex min-w-0 items-center justify-between gap-2" data-testid={`dashboard-shopping-item-${item.listId}-${item.id}`}>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {item.name}
                  {item.quantity > 1 && <span className="font-normal text-muted-foreground"> ×{item.quantity}</span>}
                </span>
                {showLists && <span className="block truncate text-xs text-muted-foreground">{item.listName}</span>}
              </span>
              {canTick && (
                <ActionButton
                  state={tick.states[key]}
                  idle="Tick"
                  label={`Tick ${item.name}`}
                  testId={`shopping-tick-${item.listId}-${item.id}`}
                  dataKey={key}
                  onClick={(button) => void tick.tick(item, button)}
                />
              )}
            </li>
          );
        })}
      </ul>
      {more > 0 && (
        <Link href="/shopping" className={cn(styles.hitSlop, styles.wideHide, 'self-start text-xs text-muted-foreground hover:text-foreground')} data-testid="dashboard-shopping-more">
          +{more} more
        </Link>
      )}
    </div>
  );
}
