"use client";

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  CalendarDays,
  CheckSquare,
  Home,
  LayoutGrid,
  PawPrint,
  Plus,
  ScanBarcode,
  ShoppingCart,
  User,
  Users,
  UtensilsCrossed,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { cn } from '@/lib/utils';
import { isActiveRoute } from '@/lib/navigation';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from './ui/sheet';
import { openCommandPalette } from './command/events';
import { MAINTENANCE_LOGS_HREF } from '@/lib/dashboard/links';
import { isComposingKey } from '@/lib/dashboard/shortcuts';
import styles from './dashboard/dashboard.module.css';
import type { HouseholdPermission } from '@/lib/types';

type NavItem = { href: string; label: string; icon: LucideIcon; permission?: HouseholdPermission };

// Primary tabs on phones. Anything the member can't view is left out, never shown disabled.
const PRIMARY: NavItem[] = [
  { href: '/', label: 'Home', icon: Home },
  { href: '/chores', label: 'Chores', icon: CheckSquare, permission: 'chores.view' },
  { href: '/shopping', label: 'Shopping', icon: ShoppingCart, permission: 'shopping.view' },
  { href: '/pets', label: 'Pets', icon: PawPrint, permission: 'pets.view' },
];

const MORE: NavItem[] = [
  { href: '/maintenance', label: 'Maintenance', icon: Wrench, permission: 'maintenance.view' },
  // Gated like Chores (the calendar shows chores).
  { href: '/calendar', label: 'Calendar', icon: CalendarDays, permission: 'chores.view' },
  { href: '/automation', label: 'Automation', icon: Bot, permission: 'automation.view' },
  { href: '/household', label: 'Household', icon: Users, permission: 'household.view' },
  { href: '/library', label: 'Barcode Library', icon: ScanBarcode },
  { href: '/profile', label: 'Profile', icon: User },
];

type QuickAction = { label: string; short: string; icon: LucideIcon; permission: HouseholdPermission } & ({ text: string } | { href: string });

// The floating quick-add fan (H18). Each opens the palette pre-filled for that kind
// of entry (same parser and confirm step), or the module's own form.
const QUICK_ACTIONS: QuickAction[] = [
  { label: 'Add chore', short: 'Chore', icon: CheckSquare, permission: 'chores.create', text: 'chore ' },
  { label: 'Add shopping item', short: 'Item', icon: ShoppingCart, permission: 'shopping.edit', text: 'add ' },
  { label: 'Log feeding', short: 'Feeding', icon: UtensilsCrossed, permission: 'pets.addLogs', text: 'fed ' },
  { label: 'Log maintenance', short: 'Service', icon: Wrench, permission: 'maintenance.createLogs', href: MAINTENANCE_LOGS_HREF },
];

const LONG_PRESS_MS = 500;
// In rem, like the fan buttons, so the fan keeps its spacing at every text size.
const FAN_RADIUS_REM = 5.25;

const isActive = isActiveRoute;

function QuickAddFab({ actions }: { actions: QuickAction[] }) {
  const router = useRouter();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const pressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const root = useRef<HTMLLIElement>(null);
  const firstAction = useRef<HTMLButtonElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    firstAction.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isComposingKey(event)) {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const run = (action: QuickAction) => {
    setOpen(false);
    if ('href' in action) router.push(action.href);
    else openCommandPalette({ text: action.text });
  };

  // Long-press opens voice add (H14); the palette hides the mic where unsupported.
  const startPress = () => {
    longPressed.current = false;
    pressTimer.current = window.setTimeout(() => {
      longPressed.current = true;
      setOpen(false);
      openCommandPalette({ voice: true });
    }, LONG_PRESS_MS);
  };
  const endPress = () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  const count = actions.length;
  // Fan across the upper half-circle, evenly spaced, left to right.
  const positions = actions.map((_, index) => {
    const angle = Math.PI * (count === 1 ? 0.5 : 0.1 + (0.8 * index) / (count - 1));
    return { x: -Math.cos(angle) * FAN_RADIUS_REM, y: -Math.sin(angle) * FAN_RADIUS_REM };
  });

  return (
    <li ref={root} className="relative flex w-16 shrink-0 items-start justify-center">
      <div
        id="tabbar-quick-add-menu"
        role="menu"
        aria-label="Quick add"
        aria-hidden={!open}
        className="absolute bottom-12 left-1/2 z-50 h-0 w-0"
        style={{ visibility: open ? 'visible' : 'hidden' }}
      >
        {actions.map((action, index) => {
          const Icon = action.icon;
          const { x, y } = positions[index];
          return (
            <button
              key={action.label}
              ref={index === 0 ? firstAction : undefined}
              type="button"
              role="menuitem"
              aria-label={action.label}
              tabIndex={open ? 0 : -1}
              onClick={() => run(action)}
              className={cn(styles.fanItem, 'absolute left-0 top-0 flex h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-full border bg-popover text-[0.625rem] font-medium text-popover-foreground shadow-overlay')}
              style={{
                transform: open
                  ? `translate(calc(-50% + ${x.toFixed(3)}rem), calc(-50% + ${y.toFixed(3)}rem))`
                  : 'translate(-50%, -50%) scale(0.4)',
                opacity: open ? 1 : 0,
                transitionDelay: open && !reduced ? `${index * 30}ms` : undefined,
              }}
            >
              <Icon aria-hidden className="h-4 w-4 text-primary" />
              <span aria-hidden className="leading-tight">{action.short}</span>
            </button>
          );
        })}
      </div>
      <button
        ref={toggle}
        type="button"
        aria-label="Quick add"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="tabbar-quick-add-menu"
        data-testid="tabbar-quick-add"
        onPointerDown={startPress}
        onPointerUp={endPress}
        onPointerLeave={endPress}
        onPointerCancel={endPress}
        onContextMenu={(event) => event.preventDefault()}
        onClick={() => {
          if (longPressed.current) {
            longPressed.current = false;
            return;
          }
          setOpen((current) => !current);
        }}
        className="relative z-50 -mt-5 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-overlay ring-4 ring-background"
      >
        <Plus aria-hidden className={cn('h-6 w-6 transition-transform duration-200', open && 'rotate-45')} />
      </button>
    </li>
  );
}

export function MobileTabBar() {
  const pathname = usePathname() || '/';
  const { currentUser, currentMember, permissions } = useAuth();
  const [moreOpen, setMoreOpen] = useState(false);

  // Only approved members of a household get module navigation.
  if (!currentUser?.householdId || !currentMember || currentMember.role === 'newuser') return null;

  const allowed = (item: { permission?: HouseholdPermission }) => !item.permission || permissions[item.permission];
  const primary = PRIMARY.filter(allowed);
  const more = MORE.filter(allowed);
  const quickActions = QUICK_ACTIONS.filter(allowed);
  const moreActive = more.some((item) => isActive(pathname, item.href));

  const tabClass = (active: boolean) => cn(
    'flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg py-1.5 text-[0.6875rem] font-medium transition-colors',
    active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
  );

  const items = primary.map((item) => {
    const active = isActive(pathname, item.href);
    const Icon = item.icon;
    return (
      <li key={item.href} className="flex min-w-0 flex-1">
        <Link href={item.href} aria-current={active ? 'page' : undefined} className={tabClass(active)}>
          {/* Active icons fill and bounce once (static under reduced motion). */}
          <span key={active ? `${item.href}-active` : item.href} className={cn('flex', active && styles.pop)}>
            <Icon className="h-5 w-5" fill={active ? 'currentColor' : 'none'} fillOpacity={active ? 0.2 : 0} strokeWidth={active ? 2.5 : 2} aria-hidden />
          </span>
          <span className="truncate">{item.label}</span>
        </Link>
      </li>
    );
  });

  if (more.length > 0) {
    items.push(
      <li key="more" className="flex min-w-0 flex-1">
        <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
          <SheetTrigger asChild>
            <button type="button" className={tabClass(moreActive)} aria-current={moreActive ? 'page' : undefined}>
              <LayoutGrid className="h-5 w-5" strokeWidth={moreActive ? 2.5 : 2} aria-hidden />
              <span>More</span>
            </button>
          </SheetTrigger>
          <SheetContent side="bottom" className="rounded-t-2xl pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
            <SheetHeader className="text-left">
              <SheetTitle>More</SheetTitle>
              <SheetDescription>Everything else in HomeHub.</SheetDescription>
            </SheetHeader>
            {/* At least 6rem per tile: three across on phones at 100%, two at 130%. */}
            <ul className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] gap-2">
              {more.map((item) => {
                const active = isActive(pathname, item.href);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={() => setMoreOpen(false)}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex min-h-20 flex-col items-center justify-center gap-1.5 rounded-xl border py-2 text-center text-xs font-medium transition-colors',
                        active ? 'border-primary bg-primary/10 text-primary' : 'bg-card shadow-raised hover:bg-accent',
                      )}
                    >
                      <Icon className="h-5 w-5" aria-hidden />
                      <span className="px-1 leading-tight">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </SheetContent>
        </Sheet>
      </li>,
    );
  }

  if (quickActions.length > 0) {
    // The raised quick-add sits in the middle of the bar.
    items.splice(Math.floor(items.length / 2), 0, <QuickAddFab key="quick-add" actions={quickActions} />);
  }

  return (
    <nav
      aria-label="Primary"
      className="surface-glass fixed inset-x-0 bottom-0 z-50 border-t border-border-subtle md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <ul className="mx-auto flex h-16 max-w-lg items-stretch gap-1 px-2">
        {items}
      </ul>
    </nav>
  );
}
