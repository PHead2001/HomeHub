
"use client";

import { User, LogOut, ScanBarcode, Home, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import { isActiveRoute } from '@/lib/navigation';
import { SPRING_SNAPPY } from '@/lib/motion';
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
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar';
import { NotificationBell } from './notification-bell';
import { Logo } from './brand/logo';
import { openCommandPalette } from './command/events';


const NAV_LINKS: Array<{ href: string; label: string; permission: HouseholdPermission }> = [
  { href: '/shopping', label: 'Shopping', permission: 'shopping.view' },
  { href: '/pets', label: 'Pets', permission: 'pets.view' },
  { href: '/maintenance', label: 'Maintenance', permission: 'maintenance.view' },
  { href: '/chores', label: 'Chores', permission: 'chores.view' },
  // Gated like Chores: the calendar shows chores (and other dated items).
  { href: '/calendar', label: 'Calendar', permission: 'chores.view' },
  { href: '/automation', label: 'Automation', permission: 'automation.view' },
];

export function Header() {
  const { currentUser, currentMember, permissions, logout } = useAuth();
  const pathname = usePathname() || '/';
  const isPendingNewUser = currentMember?.role === 'newuser';

  return (
    <header className="surface-glass sticky top-0 z-50 w-full border-b border-border-subtle">
      <div className="container mx-auto flex h-14 items-center px-4">
        <Link href="/" aria-label="HomeHub home" className="flex items-center gap-2 mr-6">
          <Logo size={24} animated />
          <span className="font-headline text-xl font-bold">HomeHub</span>
        </Link>
        <nav aria-label="Main" className="hidden md:flex items-center gap-1 text-sm">
          {NAV_LINKS.filter((link) => permissions[link.permission]).map((link) => {
            const active = isActiveRoute(pathname, link.href);
            return (
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
                  // Slides between links (shared layoutId); instant under reduced motion.
                  <motion.span
                    layoutId="header-nav-underline"
                    aria-hidden
                    className="absolute inset-x-2.5 -bottom-3 h-0.5 rounded-full bg-primary"
                    transition={SPRING_SNAPPY}
                  />
                )}
              </Link>
            );
          })}
        </nav>
        <div className="flex flex-1 items-center justify-end gap-2">
            {currentUser ? (
              <>
                 {currentUser.householdId && currentMember && !isPendingNewUser && (
                   <Button
                     variant="ghost"
                     size="icon"
                     onClick={() => openCommandPalette()}
                     aria-label="Search or quick add"
                     aria-keyshortcuts="Control+K Meta+K"
                     title="Search or quick add (Ctrl+K)"
                     data-testid="header-search"
                   >
                     <Search className="h-5 w-5" aria-hidden />
                   </Button>
                 )}
                 {permissions['notifications.view'] && !isPendingNewUser && <NotificationBell />}
                 <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" className="relative h-8 w-8 rounded-full" aria-label="Account menu">
                      <Avatar className="h-9 w-9" aria-hidden>
                         <AvatarImage src={currentUser.avatarUrl ?? undefined} alt={currentUser.displayName} />
                        <AvatarFallback>{currentUser.displayName ? currentUser.displayName[0].toUpperCase() : 'U'}</AvatarFallback>
                      </Avatar>
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
