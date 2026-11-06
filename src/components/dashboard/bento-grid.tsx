'use client';

/**
 * Dashboard bento grid (H22): live tiles shown by default, from exact facts (no
 * "Generate" step). Each tile deep-links to its module, numbers tick in, and a
 * peek (H26) lists the details on hover or keyboard focus. Sections the member
 * cannot view are left out; sections still loading show a fixed-size skeleton so
 * nothing shifts.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Bell, CheckSquare, PawPrint, Refrigerator, ShoppingCart, Wrench, type LucideIcon } from 'lucide-react';
import { NumberTicker } from '@/components/motion/number-ticker';
import { relativeDays } from '@/lib/dashboard/dates';
import { timeAgo, type DashboardFacts } from '@/lib/dashboard/facts';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { PeekCard } from './peek-card';

function Tile({
  href,
  title,
  icon: Icon,
  testId,
  className,
  peek,
  children,
}: {
  href: string;
  title: string;
  icon: LucideIcon;
  testId: string;
  className?: string;
  peek?: ReactNode;
  children: ReactNode;
}) {
  return (
    <PeekCard peek={peek ?? null} className={cn('min-w-0', className)}>
      <Link
        href={href}
        data-testid={testId}
        className="glow-card flex h-full min-h-[8.5rem] flex-col gap-2 rounded-xl border bg-card p-4 shadow-raised transition-ui hover:border-primary/40"
      >
        <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Icon aria-hidden className="h-4 w-4 text-primary" />
          <span className="truncate">{title}</span>
        </span>
        {children}
      </Link>
    </PeekCard>
  );
}

function TileSkeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('min-h-[8.5rem] animate-pulse rounded-xl border bg-muted/40', className)} />;
}

function ProgressRing({ done, total }: { done: number; total: number }) {
  const radius = 30;
  const circumference = 2 * Math.PI * radius;
  const ratio = total > 0 ? done / total : 1;
  return (
    <svg viewBox="0 0 72 72" className="h-20 w-20 shrink-0 -rotate-90" aria-hidden>
      <circle cx="36" cy="36" r={radius} fill="none" strokeWidth="7" className="stroke-muted" />
      <circle
        cx="36"
        cy="36"
        r={radius}
        fill="none"
        strokeWidth="7"
        strokeLinecap="round"
        className={cn(ratio >= 1 ? 'stroke-success' : 'stroke-primary')}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - ratio)}
        style={{ transition: 'stroke-dashoffset 600ms var(--ease-standard)' }}
      />
    </svg>
  );
}

const Big = ({ value, suffix }: { value: number; suffix?: string }) => (
  <span className="flex items-baseline gap-1.5">
    <NumberTicker value={value} className="font-headline text-3xl font-semibold tabular-nums" />
    {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
  </span>
);

export function BentoGrid({ facts, loading, failed, now }: { facts: DashboardFacts; loading: boolean; failed: Set<string>; now: Date }) {
  const { permissions } = useAuth();
  const tiles: ReactNode[] = [];

  if (permissions['chores.view']) {
    const chores = facts.chores;
    tiles.push(chores ? (
      <Tile
        key="chores"
        href="/chores"
        title="Today's chores"
        icon={CheckSquare}
        testId="dashboard-tile-chores"
        className="sm:col-span-2 lg:row-span-2"
        peek={chores.nextUp.length > 0 ? (
          <ul className="space-y-1">
            {chores.nextUp.map((chore) => (
              <li key={chore.id} className="flex justify-between gap-2">
                <span className="truncate">{chore.task}</span>
                <span className={cn('shrink-0 text-xs', chore.overdue ? 'text-warning' : 'text-muted-foreground')}>{chore.dueLabel}</span>
              </li>
            ))}
          </ul>
        ) : null}
      >
        <span className="flex flex-1 items-center gap-4">
          <ProgressRing done={chores.todayDone} total={chores.todayTotal} />
          <span className="min-w-0">
            <span className="block font-headline text-2xl font-semibold tabular-nums">
              <NumberTicker value={chores.todayDone} /> of <NumberTicker value={chores.todayTotal} /> done
            </span>
            <span className="block text-sm text-muted-foreground">
              {chores.mineOpen === 0 ? 'Nothing assigned to you.' : `${chores.mineOpen} open for you`}
              {chores.overdueTotal > 0 && <span className="text-warning">{` · ${chores.overdueTotal} overdue`}</span>}
            </span>
          </span>
        </span>
        {chores.nextUp.length > 0 && (
          <span className="hidden text-sm text-muted-foreground lg:block">
            Next: <span className="text-foreground">{chores.nextUp[0].task}</span> ({chores.nextUp[0].dueLabel})
          </span>
        )}
      </Tile>
    ) : failed.has('chores') ? null : loading ? <TileSkeleton key="chores" className="sm:col-span-2 lg:row-span-2" /> : null);
  }

  if (permissions['shopping.view']) {
    const shopping = facts.shopping;
    tiles.push(shopping ? (
      <Tile
        key="shopping"
        href="/shopping"
        title="Shopping"
        icon={ShoppingCart}
        testId="dashboard-tile-shopping"
        className="sm:col-span-2"
        peek={shopping.lists.length > 0 ? (
          <ul className="space-y-1">
            {shopping.lists.map((list) => (
              <li key={list.id} className="flex justify-between gap-2"><span className="truncate">{list.name}</span><span className="text-muted-foreground">{list.needed}</span></li>
            ))}
          </ul>
        ) : null}
      >
        <Big value={shopping.neededItems} suffix={shopping.neededItems === 1 ? 'item needed' : 'items needed'} />
        {shopping.firstItems.length > 0 ? (
          <span className="flex flex-wrap gap-1.5">
            {shopping.firstItems.map((item) => (
              <span key={`${item.listId}-${item.id}`} className="max-w-full truncate rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">{item.name}</span>
            ))}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">Lists are empty. Nice.</span>
        )}
      </Tile>
    ) : failed.has('shopping') ? null : loading ? <TileSkeleton key="shopping" className="sm:col-span-2" /> : null);
  }

  if (permissions['pets.view']) {
    const pets = facts.pets;
    tiles.push(pets ? (
      <Tile key="pets" href="/pets" title="Pets" icon={PawPrint} testId="dashboard-tile-pets">
        {pets.pets.length === 0 ? (
          <span className="text-sm text-muted-foreground">No pets yet.</span>
        ) : (
          <ul className="space-y-1 text-sm">
            {pets.pets.slice(0, 3).map((pet) => (
              <li key={pet.id} className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{pet.name}</span>
                <span className={cn('shrink-0 text-xs', pet.fed ? 'text-success' : 'text-warning')}>
                  {pet.fed ? `Fed ${pet.lastFedAt ? timeAgo(pet.lastFedAt, now) : ''}`.trim() : 'Not fed yet'}
                </span>
              </li>
            ))}
            {pets.pets.length > 3 && <li className="text-xs text-muted-foreground">+{pets.pets.length - 3} more</li>}
          </ul>
        )}
      </Tile>
    ) : failed.has('pets') ? null : loading ? <TileSkeleton key="pets" /> : null);
  }

  if (permissions['maintenance.view']) {
    const maintenance = facts.maintenance;
    const next = maintenance?.next;
    tiles.push(maintenance ? (
      <Tile
        key="maintenance"
        href={next?.href ?? '/maintenance'}
        title="Next maintenance"
        icon={Wrench}
        testId="dashboard-tile-maintenance"
        peek={maintenance.items.length > 0 ? (
          <ul className="space-y-1">
            {maintenance.items.map((item, index) => (
              <li key={`${item.label}-${index}`} className="flex justify-between gap-2">
                <span className="truncate">{item.label}</span>
                <span className={cn('shrink-0 text-xs', item.overdue ? 'text-warning' : 'text-muted-foreground')}>
                  {item.days === null ? 'by mileage' : relativeDays(item.days)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      >
        {next ? (
          <>
            <span className="truncate font-medium">{next.label}</span>
            <span className={cn('font-headline text-2xl font-semibold', next.overdue ? 'text-warning' : 'text-foreground')}>
              {next.days === null ? 'Due by mileage' : next.overdue ? `${-next.days} ${-next.days === 1 ? 'day' : 'days'} overdue` : next.days === 0 ? 'Due today' : `In ${next.days} ${next.days === 1 ? 'day' : 'days'}`}
            </span>
          </>
        ) : (
          <span className="text-sm text-muted-foreground">Nothing scheduled.</span>
        )}
      </Tile>
    ) : failed.has('maintenance') ? null : loading ? <TileSkeleton key="maintenance" /> : null);
  }

  if (permissions['shopping.view']) {
    const pantry = facts.pantry;
    tiles.push(pantry ? (
      <Tile key="pantry" href="/shopping" title="Expiring soon" icon={Refrigerator} testId="dashboard-tile-pantry">
        <Big value={pantry.expiringSoon} suffix={pantry.expired > 0 ? `· ${pantry.expired} expired` : 'this week'} />
        {pantry.nearest[0] ? (
          <span className="truncate text-sm text-muted-foreground">{pantry.nearest[0].name} {pantry.nearest[0].label}</span>
        ) : (
          <span className="text-sm text-muted-foreground">Nothing close to expiring.</span>
        )}
      </Tile>
    ) : failed.has('pantry') ? null : loading ? <TileSkeleton key="pantry" /> : null);
  }

  if (permissions['notifications.view'] && facts.notifications) {
    tiles.push(
      <Tile key="notifications" href="/notifications" title="Notifications" icon={Bell} testId="dashboard-tile-notifications">
        <Big value={facts.notifications.unread} suffix="unread" />
        <span className="text-sm text-muted-foreground">{facts.notifications.unread === 0 ? 'All caught up.' : 'See what needs you.'}</span>
      </Tile>,
    );
  }

  const visible = tiles.filter(Boolean);

  return (
    <section aria-labelledby="dashboard-grid-heading" className="mb-8">
      <h2 id="dashboard-grid-heading" className="mb-3 font-headline text-xl font-semibold">Your Dashboard</h2>
      {visible.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-busy={loading || undefined}>
          {visible}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing to show yet. Your household role decides which sections appear here.</p>
      )}
    </section>
  );
}
