
"use client";

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { User, LogOut, ScanBarcode, Home, Search, ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { fittingLinkCount, isActiveRoute } from '@/lib/navigation';
import type { HouseholdPermission } from '@/lib/types';
import { Button } from './ui/button';
import { useAuth } from '@/hooks/use-auth';
import { LoginDialog } from './login-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MemberAvatar } from './member-avatar';
import { LazyShortcutHint as ShortcutHint } from './ui/lazy-shortcut-hint';
import { GO_TARGETS } from '@/lib/dashboard/shortcuts';
import dynamic from 'next/dynamic';
import { Logo } from './brand/logo';
import { openCommandPalette } from './command/events';

// The bell reads notifications from Firestore; it loads as its own chunk once a
// signed-in member with notifications.view is known, so signed-out pages never
// download Firestore. The placeholder keeps the icon button's size (no shift).
// The sliding underline uses `motion`; it loads as its own chunk (only signed-in
// members see nav links), with a plain underline until then.
const HeaderNavUnderline = dynamic(() => import('./header-nav-underline').then((mod) => mod.HeaderNavUnderline), {
  ssr: false,
  loading: () => <span aria-hidden className="absolute inset-x-2.5 bottom-0 h-0.5 coarse:inset-x-3 rounded-full bg-primary" />,
});

const NotificationBell = dynamic(() => import('./notification-bell').then((mod) => mod.NotificationBell), {
  ssr: false,
  loading: () => <span aria-hidden className="inline-block h-10 w-10" />,
});


const NAV_LINKS: Array<{ href: string; label: string; permission: HouseholdPermission }> = [
  { href: '/shopping', label: 'Shopping', permission: 'shopping.view' },
  { href: '/pets', label: 'Pets', permission: 'pets.view' },
  { href: '/maintenance', label: 'Maintenance', permission: 'maintenance.view' },
  { href: '/chores', label: 'Chores', permission: 'chores.view' },
  // Gated like Chores: the calendar shows chores (and other dated items).
  { href: '/calendar', label: 'Calendar', permission: 'chores.view' },
  { href: '/automation', label: 'Automation', permission: 'automation.view' },
];

/** The `G` then letter shortcut for a nav link, when it has one (hint in its tooltip). */
const goShortcut = (href: string) => Object.values(GO_TARGETS).find((target) => target.href === href)?.id;

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

// Links fill the header's height (56 px, so the hit area clears 48 px on touch screens)
// and inset their focus ring so the nav's overflow clip never cuts it. On touch
// screens the text is 16 px (SL-4).
const NAV_LINK_CLASS =
  'relative flex shrink-0 items-center whitespace-nowrap rounded-md px-2.5 text-sm -outline-offset-2 transition-colors coarse:px-3 coarse:text-base';
const navLinkTone = (active: boolean) =>
  active ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground';

type NavLink = (typeof NAV_LINKS)[number];

/**
 * Header links (SL-7). Shows as many links as fit, in order, and moves the rest into
 * a "More" menu, so the header never scrolls sideways at 768-1023 px, at 130% text
 * or with touch-sized links, and the account button stays on screen. Widths come
 * from an invisible (so unfocusable and unannounced) copy of every label, re-measured whenever it or the nav
 * resizes (fonts loading, text size changes). Before the first measurement every
 * link renders and the nav clips.
 */
function HeaderNav({ links, pathname }: { links: NavLink[]; pathname: string }) {
  const navRef = useRef<HTMLElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [fitting, setFitting] = useState<number | null>(null);
  const linkKey = links.map((link) => link.href).join('|');

  useIsomorphicLayoutEffect(() => {
    const nav = navRef.current;
    const measure = measureRef.current;
    if (!nav || !measure) return;
    const update = () => {
      const items = Array.from(measure.children) as HTMLElement[];
      const more = items.pop();
      const gap = Number.parseFloat(getComputedStyle(measure).columnGap) || 0;
      setFitting(
        fittingLinkCount(
          items.map((item) => item.getBoundingClientRect().width),
          nav.clientWidth,
          more?.getBoundingClientRect().width ?? 0,
          gap,
        ),
      );
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(nav);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [linkKey]);

  const count = fitting ?? links.length;
  const shown = links.slice(0, count);
  const overflow = links.slice(count);
  const overflowActive = overflow.some((link) => isActiveRoute(pathname, link.href));

  return (
    <nav
      ref={navRef}
      aria-label="Main"
      className="relative hidden min-w-0 flex-1 items-stretch gap-1 self-stretch overflow-hidden md:flex"
    >
      {shown.map((link) => {
        const active = isActiveRoute(pathname, link.href);
        const shortcut = goShortcut(link.href);
        const anchor = (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={cn(NAV_LINK_CLASS, navLinkTone(active))}
          >
            {link.label}
            {active && <HeaderNavUnderline />}
          </Link>
        );
        return shortcut ? (
          <ShortcutHint key={link.href} shortcut={shortcut}>{anchor}</ShortcutHint>
        ) : anchor;
      })}
      {overflow.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger className={cn(NAV_LINK_CLASS, 'gap-1', navLinkTone(overflowActive))}>
            More
            <ChevronDown aria-hidden className="h-4 w-4" />
            {overflowActive && <HeaderNavUnderline />}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            {overflow.map((link) => {
              const active = isActiveRoute(pathname, link.href);
              return (
                <DropdownMenuItem key={link.href} asChild className={cn(active && 'font-medium text-primary')}>
                  <Link href={link.href} aria-current={active ? 'page' : undefined}>
                    {link.label}
                  </Link>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {/* Measuring copy: same type and padding as the links, never seen or reached. */}
      <div
        ref={measureRef}
        aria-hidden
        className="pointer-events-none invisible absolute left-0 top-0 flex gap-1"
      >
        {links.map((link) => (
          <span key={link.href} className={cn(NAV_LINK_CLASS, 'font-medium')}>{link.label}</span>
        ))}
        <span className={cn(NAV_LINK_CLASS, 'gap-1 font-medium')}>
          More
          <ChevronDown className="h-4 w-4" />
        </span>
      </div>
    </nav>
  );
}

export function Header() {
  const { currentUser, currentMember, permissions, logout } = useAuth();
  const pathname = usePathname() || '/';
  const isPendingNewUser = currentMember?.role === 'newuser';

  return (
    // data-site-header: kept out of the page crossfade during route view transitions.
    <header data-site-header className="surface-glass sticky top-0 z-50 w-full border-b border-border-subtle">
      <div className="container mx-auto flex h-14 items-center px-4">
        <Link href="/" aria-label="HomeHub home" className="mr-4 flex shrink-0 items-center gap-2 lg:mr-6">
          <Logo size={24} animated />
          <span className="font-headline text-xl font-bold">HomeHub</span>
        </Link>
        <HeaderNav links={NAV_LINKS.filter((link) => permissions[link.permission])} pathname={pathname} />
        <div className="ml-auto flex shrink-0 items-center justify-end gap-2 pl-2">
            {currentUser ? (
              <>
                 {currentUser.householdId && currentMember && !isPendingNewUser && (
                   <ShortcutHint shortcut="palette" label="Search or quick add">
                     <Button
                       variant="ghost"
                       size="icon"
                       onClick={() => openCommandPalette()}
                       aria-label="Search or quick add"
                       data-testid="header-search"
                     >
                       <Search className="h-5 w-5" aria-hidden />
                     </Button>
                   </ShortcutHint>
                 )}
                 {permissions['notifications.view'] && !isPendingNewUser && <NotificationBell />}
                 <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="rounded-full" aria-label="Account menu">
                      {/* The shared gradient avatar (H24); the button carries the name. */}
                      <MemberAvatar
                        uid={currentUser.uid}
                        name={currentUser.displayName || currentUser.email || 'Member'}
                        photoUrl={currentUser.avatarUrl}
                        decorative
                        className="h-9 w-9 text-xs"
                      />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-56" align="end" forceMount>
                    <DropdownMenuLabel className="font-normal">
                      <div className="flex flex-col space-y-1">
                        <p className="text-sm font-medium leading-none">{currentUser.displayName}</p>
                        <p className="text-xs leading-none text-muted-foreground truncate">
                          {currentUser.email}
                        </p>
                      </div>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                       <Link href="/profile">
                          <User className="mr-2" />
                          <span>Profile</span>
                       </Link>
                    </DropdownMenuItem>
                    {!isPendingNewUser && permissions['household.view'] && (
                      <DropdownMenuItem asChild>
                        <Link href="/household">
                          <Home className="mr-2" />
                          <span>Manage Household</span>
                        </Link>
                      </DropdownMenuItem>
                    )}
                    {!isPendingNewUser && (
                    <DropdownMenuItem asChild>
                       <Link href="/library">
                          <ScanBarcode className="mr-2" />
                          <span>Barcode Library</span>
                       </Link>
                    </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={logout}>
                      <LogOut className="mr-2" />
                      <span>Log out</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : (
                <LoginDialog>
                    <Button>Login</Button>
                </LoginDialog>
            )}
        </div>
      </div>
    </header>
  );
}
