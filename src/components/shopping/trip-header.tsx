'use client';

import { forwardRef, useEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, MoreVertical, ScanBarcode, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { AisleChip } from '@/lib/shopping/trip-mode';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import styles from './trip-mode.module.css';

export type ListAction = { key: string; label: string; icon: LucideIcon; onSelect: () => void };

/** 44 px; the icon size's `touch-target` makes it 48 px on touch (D-2). */
const ICON_BUTTON = 'h-11 w-11 shrink-0';

/**
 * The open list's secondary actions in one menu (SH-12b): Scan to tick, Trips,
 * Manage Categories and the Barcode Library. A chosen action runs after the menu
 * has closed and returned focus to its button, so the dialog it opens hands focus
 * back to that button when it closes.
 */
function ListActionsMenu({ actions }: { actions: ListAction[] }) {
  const pending = useRef<(() => void) | null>(null);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="More list actions" data-testid="list-actions-menu" className={ICON_BUTTON}>
          <MoreVertical className="h-5 w-5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-52"
        onCloseAutoFocus={() => {
          const run = pending.current;
          pending.current = null;
          if (run) window.setTimeout(run, 0);
        }}
      >
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <DropdownMenuItem key={action.key} className="coarse:min-h-12" onSelect={() => { pending.current = action.onSelect; }}>
              <Icon aria-hidden /> {action.label}
            </DropdownMenuItem>
          );
        })}
        {actions.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem asChild className="coarse:min-h-12">
          <Link href="/library"><ScanBarcode aria-hidden /> Barcode Library</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The compact sticky header of an open list (SH-12c, SH-33d, SH-18b): Back, the
 * list's name, the "n left" pill, the cart, Add Item and the actions menu, then
 * (for two or more aisles) the aisle chips that jump to an aisle. It sticks under
 * the site header and publishes its height as `--trip-header-h` on its parent, so
 * the sticky aisle headings sit right under it.
 */
export const TripHeader = forwardRef<HTMLDivElement, {
  icon: ReactNode;
  iconClass: string;
  name: string;
  storeName: string | null;
  left: string | null;
  cart: ReactNode;
  addItem: ReactNode;
  actions: ListAction[];
  chips: AisleChip[];
  onBack: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Opens the Needed section (an aisle chip tapped while it is collapsed). */
  onOpenNeeded: () => void;
  /** The open list's identity (household and list): a change drops a jump still waiting. */
  scopeKey: string;
}>(function TripHeader({ icon, iconClass, name, storeName, left, cart, addItem, actions, chips, onBack, onOpenNeeded, scopeKey }, forwarded) {
  const ref = useRef<HTMLDivElement | null>(null);
  // In-app Reduce motion as well as the system setting (`useReducedMotion`).
  const reduced = useReducedMotion();
  // Counts jumps; bumped when the list changes or the header unmounts, which drops a waiting jump.
  const jumpRef = useRef(0);
  useEffect(() => {
    const jumps = jumpRef;
    return () => {
      jumps.current += 1;
    };
  }, [scopeKey]);

  useEffect(() => {
    const node = ref.current;
    const host = node?.parentElement;
    if (!node || !host) return;
    const publish = () => host.style.setProperty('--trip-header-h', `${Math.round(node.getBoundingClientRect().height)}px`);
    publish();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const jump = async (targetId: string) => {
    // A jump belongs to the list it was tapped on: if another list opens (or this
    // header unmounts) while it waits for the aisle, it is dropped.
    const ticket = ++jumpRef.current;
    const stillCurrent = () => jumpRef.current === ticket && Boolean(ref.current?.isConnected);
    // A collapsed Needed section has no aisles in it: open it first, then wait (a
    // bounded number of frames) for the aisle to mount and the section's opening
    // animation to finish, so the page is tall enough to scroll to it.
    onOpenNeeded();
    let heading: HTMLElement | null = null;
    for (let frame = 0; frame < 60 && !heading; frame += 1) {
      heading = document.getElementById(targetId);
      if (!heading) await new Promise((resolve) => requestAnimationFrame(resolve));
      if (!stillCurrent()) return;
    }
    if (!heading) return;
    // Bounded: under reduced motion there may be no animation at all, and a
    // cancelled or paused one must not hold the jump.
    const region = heading.closest<HTMLElement>('[role="region"]');
    const running = region && typeof region.getAnimations === 'function' ? region.getAnimations() : [];
    if (running.length > 0) {
      await Promise.race([
        Promise.all(running.map((animation) => animation.finished.catch(() => undefined))),
        new Promise((resolve) => window.setTimeout(resolve, 600)),
      ]);
    }
    if (!heading.isConnected || !stillCurrent()) return;
    // The aisle's section (its scroll margin clears the sticky header), not the
    // sticky heading itself, whose own box moves while it sticks.
    const target = heading.closest('section') ?? heading;
    // The member's motion setting (system or Profile → Appearance), read at the tap.
    target.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
  };

  return (
    <div
      ref={(node) => {
        ref.current = node;
        if (typeof forwarded === 'function') forwarded(node);
        else if (forwarded) forwarded.current = node;
      }}
      className={cn(styles.header, 'rounded-t-xl border-b border-border-subtle bg-card px-2 py-2 sm:px-4')}
      data-testid="trip-header"
    >
      <div className="flex items-center gap-1 sm:gap-2">
        <Button variant="ghost" size="icon" aria-label="Back to all lists" onClick={onBack} className={ICON_BUTTON}>
          <ArrowLeft className="h-5 w-5" aria-hidden />
        </Button>
        <span className={cn('hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl sm:flex', iconClass)} aria-hidden>
          {icon}
        </span>
        <div className="min-w-0 flex-1 px-1">
          <h2 className="line-clamp-2 break-words font-headline text-lg font-semibold leading-tight sm:text-xl">{name}</h2>
          {(left || storeName) && (
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground sm:text-sm">
              {left && (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 font-semibold tabular-nums text-primary" data-testid="trip-left">{left}</span>
              )}
              {storeName && <span className="min-w-0 truncate" data-testid="list-store">Sorted for {storeName}</span>}
            </p>
          )}
        </div>
        {cart}
        {addItem}
        <ListActionsMenu actions={actions} />
      </div>
      {chips.length > 0 && (
        <nav aria-label="Jump to an aisle" className={cn(styles.chips, '-mx-2 mt-2 px-2 pb-0.5 sm:-mx-4 sm:px-4')} data-testid="aisle-chips">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => void jump(chip.targetId)}
              aria-label={`${chip.label}, ${chip.count} needed`}
              className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border bg-card px-3 text-sm font-medium transition-colors hover:bg-accent coarse:min-h-12"
            >
              <span aria-hidden>{chip.label}</span>
              <span aria-hidden className="tabular-nums text-muted-foreground">{chip.count}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
});
