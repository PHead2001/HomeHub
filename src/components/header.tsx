
"use client";

import { User, LogOut, ScanBarcode, Home, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { isActiveRoute } from '@/lib/navigation';
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
import { ShortcutHint } from './ui/shortcut-hint';
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
  loading: () => <span aria-hidden className="absolute inset-x-2.5 -bottom-3 h-0.5 rounded-full bg-primary" />,
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

export function Header() {
  const { currentUser, currentMember, permissions, logout } = useAuth();
  const pathname = usePathname() || '/';
  const isPendingNewUser = currentMember?.role === 'newuser';

  return (
    // data-site-header: kept out of the page crossfade during route view transitions.
    <header data-site-header className="surface-glass sticky top-0 z-50 w-full border-b border-border-subtle">
      <div className="container mx-auto flex h-14 items-center px-4">
        <Link href="/" aria-label="HomeHub home" className="flex items-center gap-2 mr-6">
          <Logo size={24} animated />
          <span className="font-headline text-xl font-bold">HomeHub</span>
        </Link>
        <nav aria-label="Main" className="hidden md:flex items-center gap-1 text-sm">
          {NAV_LINKS.filter((link) => permissions[link.permission]).map((link) => {
            const active = isActiveRoute(pathname, link.href);
            const shortcut = goShortcut(link.href);
            const anchor = (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative rounded-md px-2.5 py-1.5 transition-colors',
                  active ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {link.label}
                {active && (
                  <HeaderNavUnderline />
                )}
              </Link>
            );
            return shortcut ? (
              <ShortcutHint key={link.href} shortcut={shortcut}>{anchor}</ShortcutHint>
            ) : anchor;
          })}
        </nav>
        <div className="flex flex-1 items-center justify-end gap-2">
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
                    <Button variant="ghost" className="relative h-8 w-8 rounded-full" aria-label="Account menu">
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
