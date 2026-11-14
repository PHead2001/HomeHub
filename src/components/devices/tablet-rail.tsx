'use client';

// The tablet's side rail (WT-14a): Home, Chores, Shopping, Pets, Calendar and More,
// with a big Add button. Switched-off sections are absent (WT-11b). There is no Speak
// button (JC-28), no account menu and no Log out (WT-14k): More holds Maintenance,
// Household notices and Tablet settings.

import { useState } from 'react';
import { Bell, CalendarDays, CheckSquare, Home, MoreHorizontal, PawPrint, Plus, Settings, ShoppingCart, Wrench, type LucideIcon } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { tabletNavItems, type TabletNavItem } from '@/lib/devices/start-page';
import { useTablet } from './tablet-context';

const ICONS: Record<TabletNavItem['key'], LucideIcon> = {
  home: Home,
  chores: CheckSquare,
  shopping: ShoppingCart,
  pets: PawPrint,
  calendar: CalendarDays,
  maintenance: Wrench,
  notices: Bell,
};

const itemClass = 'flex min-h-14 w-full flex-col items-center justify-center gap-1 rounded-xl px-1 py-2 text-xs font-medium text-muted-foreground transition-colors aria-[current=page]:bg-primary/15 aria-[current=page]:text-primary';

export function TabletRail() {
  const { settings, view, navigate, openQuickAdd, openSettings } = useTablet();
  const { rail, more } = tabletNavItems(settings.sections);
  const [moreOpen, setMoreOpen] = useState(false);
  const currentKey = view.kind === 'home' ? 'home' : view.kind === 'notices' ? 'notices' : view.section;
  const moreActive = more.some((item) => item.key === currentKey);

  return (
    <nav aria-label="Tablet" className="flex w-24 shrink-0 flex-col items-stretch gap-1 border-r border-border bg-card/60 px-2 py-3" data-testid="tablet-rail">
      {rail.map((item) => {
        const Icon = ICONS[item.key];
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => navigate(item.path)}
            aria-current={currentKey === item.key ? 'page' : undefined}
            className={itemClass}
            data-testid={`tablet-rail-${item.key}`}
          >
            <Icon aria-hidden className="h-6 w-6" />
            {item.label}
          </button>
        );
      })}
      <Popover open={moreOpen} onOpenChange={setMoreOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={itemClass} aria-current={moreActive ? 'page' : undefined} data-testid="tablet-rail-more">
            <MoreHorizontal aria-hidden className="h-6 w-6" />
            More
          </button>
        </PopoverTrigger>
        <PopoverContent side="right" align="start" className="w-64 p-2">
          <div className="flex flex-col gap-1">
            {more.map((item) => {
              const Icon = ICONS[item.key];
              return (
                <button
                  key={item.key}
                  type="button"
                  className="flex min-h-12 items-center gap-3 rounded-lg px-3 text-left text-base hover:bg-muted"
                  onClick={() => { setMoreOpen(false); navigate(item.path); }}
                  data-testid={`tablet-more-${item.key}`}
                >
                  <Icon aria-hidden className="h-5 w-5" />
                  {item.label}
                </button>
              );
            })}
            <button
              type="button"
              className="flex min-h-12 items-center gap-3 rounded-lg px-3 text-left text-base hover:bg-muted"
              onClick={() => { setMoreOpen(false); openSettings(); }}
              data-testid="tablet-more-settings"
            >
              <Settings aria-hidden className="h-5 w-5" />
              Tablet settings
            </button>
          </div>
        </PopoverContent>
      </Popover>
      <div className="flex-1" />
      <button
        type="button"
        onClick={openQuickAdd}
        className={cn('flex min-h-16 w-full flex-col items-center justify-center gap-1 rounded-2xl bg-primary text-sm font-semibold text-primary-foreground shadow-sm')}
        data-testid="tablet-add"
        aria-label="Add"
      >
        <Plus aria-hidden className="h-7 w-7" />
        Add
      </button>
    </nav>
  );
}
