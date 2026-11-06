"use client";

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Bot, CheckSquare, Home, LayoutGrid, PawPrint, ScanBarcode, ShoppingCart, User, Users, Wrench, type LucideIcon } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from './ui/sheet';
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
  { href: '/automation', label: 'Automation', icon: Bot, permission: 'automation.view' },
  { href: '/household', label: 'Household', icon: Users, permission: 'household.view' },
  { href: '/library', label: 'Barcode Library', icon: ScanBarcode },
  { href: '/profile', label: 'Profile', icon: User },
];

const isActive = (pathname: string, href: string) =>
  href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);

export function MobileTabBar() {
  const pathname = usePathname() || '/';
  const { currentUser, currentMember, permissions } = useAuth();
  const [moreOpen, setMoreOpen] = useState(false);

  // Only approved members of a household get module navigation.
  if (!currentUser?.householdId || !currentMember || currentMember.role === 'newuser') return null;

  const allowed = (item: NavItem) => !item.permission || permissions[item.permission];
  const primary = PRIMARY.filter(allowed);
  const more = MORE.filter(allowed);
  const moreActive = more.some((item) => isActive(pathname, item.href));

  const tabClass = (active: boolean) => cn(
    'flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg py-1.5 text-[11px] font-medium transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
  );

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-50 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <ul className="mx-auto flex h-16 max-w-lg items-stretch gap-1 px-2">
        {primary.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <li key={item.href} className="flex flex-1">
              <Link href={item.href} aria-current={active ? 'page' : undefined} className={tabClass(active)}>
                <Icon className={cn('h-5 w-5 transition-transform', active && 'scale-110')} strokeWidth={active ? 2.5 : 2} aria-hidden />
                <span className="truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
        {more.length > 0 && (
          <li className="flex flex-1">
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
                <ul className="mt-4 grid grid-cols-3 gap-2">
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
                            'flex h-20 flex-col items-center justify-center gap-1.5 rounded-xl border text-center text-xs font-medium transition-colors',
                            active ? 'border-primary bg-primary/10 text-primary' : 'bg-card hover:bg-accent',
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
          </li>
        )}
      </ul>
    </nav>
  );
}
