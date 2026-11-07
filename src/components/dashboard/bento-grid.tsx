'use client';

/**
 * Dashboard bento grid (H22): live tiles shown by default, from exact facts (no
 * "Generate" step). Each tile deep-links to its module, numbers tick in, and a
 * peek (H26) lists the details on hover or keyboard focus. Tiles tilt slightly
 * toward the cursor on fine pointers (visual layer only; the link never moves).
 * Weather (only when the member turned live weather on) and household streaks
 * (Chores' own stats) complete the grid. Sections the member
 * cannot view are left out; sections still loading show a fixed-size skeleton so
 * nothing shifts.
 */
import type { PointerEvent, ReactNode } from 'react';
import Link from 'next/link';
import { Bell, CheckSquare, CloudSun, Flame, PawPrint, Refrigerator, ShoppingCart, Wrench, type LucideIcon } from 'lucide-react';
import { NumberTicker } from '@/components/motion/number-ticker';
import type { DashboardFacts } from '@/lib/dashboard/facts';
import { MAINTENANCE_REMINDERS_HREF, PANTRY_HREF } from '@/lib/dashboard/links';
import { streakDaysLabel } from '@/lib/dashboard/streaks';
import { tiltFor } from '@/lib/dashboard/tilt';
import { temperatureLabel, weatherSummary } from '@/lib/dashboard/weather';
import { useLiveWeather } from '@/lib/dashboard/use-weather';
import { useAuth } from '@/hooks/use-auth';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { cn } from '@/lib/utils';
import { PeekCard } from './peek-card';
import styles from './dashboard.module.css';

const fineHover = () => typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

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
  const reduced = useReducedMotion();
  // The link box is the click target and never moves; only the inner visual layer tilts.
  const onPointerMove = (event: PointerEvent<HTMLAnchorElement>) => {
    if (reduced || event.pointerType !== 'mouse' || !fineHover()) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const tilt = tiltFor(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
    event.currentTarget.style.setProperty('--tilt-x', `${tilt.x}deg`);
    event.currentTarget.style.setProperty('--tilt-y', `${tilt.y}deg`);
  };
  const onPointerLeave = (event: PointerEvent<HTMLAnchorElement>) => {
    event.currentTarget.style.removeProperty('--tilt-x');
    event.currentTarget.style.removeProperty('--tilt-y');
  };
  return (
    <PeekCard peek={peek ?? null} className={cn('min-w-0', className)}>
      <Link
        href={href}
        data-testid={testId}
        className={cn(styles.tilt, 'block h-full rounded-xl')}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
      >
        <span className={cn(styles.tiltLayer, 'glow-card flex h-full min-h-[8.5rem] flex-col gap-2 rounded-xl border bg-card p-4 shadow-raised transition-ui hover:border-primary/40')}>
          <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Icon aria-hidden className="h-4 w-4 text-primary" />
            <span className="truncate">{title}</span>
          </span>
          {children}
        </span>
      </Link>
    </PeekCard>
  );
}

/** A section whose read failed: says so, and never shows an empty or zero state instead. */
function UnavailableTile({ href, title, icon: Icon, testId, className }: { href: string; title: string; icon: LucideIcon; testId: string; className?: string }) {
  return (
    <Link
      href={href}
      data-testid={testId}
      data-unavailable="true"
      className={cn('flex min-h-[8.5rem] min-w-0 flex-col gap-2 rounded-xl border border-dashed bg-card p-4 text-sm transition-ui', className)}
    >
      <span className="flex items-center gap-2 font-medium text-muted-foreground">
        <Icon aria-hidden className="h-4 w-4" />
        <span className="truncate">{title}</span>
      </span>
      <span className="text-muted-foreground">Unavailable right now. Open to check.</span>
    </Link>
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

export function BentoGrid({ facts, loading, failed }: { facts: DashboardFacts; loading: boolean; failed: Set<string> }) {
  const { permissions } = useAuth();
  const weather = useLiveWeather();
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
    ) : failed.has('chores') ? <UnavailableTile key="chores" href="/chores" title="Today's chores" icon={CheckSquare} testId="dashboard-tile-chores" className="sm:col-span-2 lg:row-span-2" /> : loading ? <TileSkeleton key="chores" className="sm:col-span-2 lg:row-span-2" /> : null);
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
    ) : failed.has('shopping') ? <UnavailableTile key="shopping" href="/shopping" title="Shopping" icon={ShoppingCart} testId="dashboard-tile-shopping" className="sm:col-span-2" /> : loading ? <TileSkeleton key="shopping" className="sm:col-span-2" /> : null);
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
                <span className={cn('shrink-0 text-xs', pet.fed === null ? 'text-muted-foreground' : pet.fed ? 'text-success' : 'text-warning')}>
                  {pet.countLabel}
                </span>
              </li>
            ))}
            {pets.pets.length > 3 && <li className="text-xs text-muted-foreground">+{pets.pets.length - 3} more</li>}
          </ul>
        )}
      </Tile>
    ) : failed.has('pets') ? <UnavailableTile key="pets" href="/pets" title="Pets" icon={PawPrint} testId="dashboard-tile-pets" /> : loading ? <TileSkeleton key="pets" /> : null);
  }

  if (permissions['maintenance.view']) {
    const maintenance = facts.maintenance;
    const next = maintenance?.next;
    tiles.push(maintenance ? (
      <Tile
        key="maintenance"
        href={next?.href ?? MAINTENANCE_REMINDERS_HREF}
        title="Next maintenance"
        icon={Wrench}
        testId="dashboard-tile-maintenance"
        peek={maintenance.items.length > 0 ? (
          <ul className="space-y-1">
            {maintenance.items.map((item, index) => (
              <li key={`${item.label}-${index}`} className="flex justify-between gap-2">
                <span className="truncate">{item.label}</span>
                <span className={cn('shrink-0 text-xs', item.overdue ? 'text-warning' : 'text-muted-foreground')}>
                  {item.statusLabel}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      >
        {next ? (
          <>
            <span className="truncate font-medium">{next.label}</span>
            {/* Maintenance's own copy: the status badge text and the "when" line, which
                says "mi over" / "mi to go" for mileage triggers. Never a negative span. */}
            <span className={cn('font-headline text-2xl font-semibold', next.overdue ? 'text-warning' : 'text-foreground')}>
              {next.statusLabel}
            </span>
            {next.detail && <span className="truncate text-sm text-muted-foreground" data-testid="maintenance-tile-detail">{next.detail}</span>}
          </>
        ) : (
          <span className="text-sm text-muted-foreground">Nothing scheduled.</span>
        )}
      </Tile>
    ) : failed.has('maintenance') ? <UnavailableTile key="maintenance" href={MAINTENANCE_REMINDERS_HREF} title="Next maintenance" icon={Wrench} testId="dashboard-tile-maintenance" /> : loading ? <TileSkeleton key="maintenance" /> : null);
  }

  if (permissions['shopping.view']) {
    const pantry = facts.pantry;
    tiles.push(pantry ? (
      <Tile key="pantry" href={PANTRY_HREF} title="Expiring soon" icon={Refrigerator} testId="dashboard-tile-pantry">
        <Big value={pantry.expiringSoon} suffix={pantry.expired > 0 ? `· ${pantry.expired} expired` : 'this week'} />
        {pantry.nearest[0] ? (
          <span className="truncate text-sm text-muted-foreground">{pantry.nearest[0].name} {pantry.nearest[0].label}</span>
        ) : (
          <span className="text-sm text-muted-foreground">Nothing close to expiring.</span>
        )}
      </Tile>
    ) : failed.has('pantry') ? <UnavailableTile key="pantry" href={PANTRY_HREF} title="Expiring soon" icon={Refrigerator} testId="dashboard-tile-pantry" /> : loading ? <TileSkeleton key="pantry" /> : null);
  }

  if (permissions['notifications.view'] && failed.has('notifications')) {
    tiles.push(<UnavailableTile key="notifications" href="/notifications" title="Notifications" icon={Bell} testId="dashboard-tile-notifications" />);
  } else if (permissions['notifications.view'] && facts.notifications) {
    tiles.push(
      <Tile key="notifications" href="/notifications" title="Notifications" icon={Bell} testId="dashboard-tile-notifications">
        <Big value={facts.notifications.unread} suffix="unread" />
        <span className="text-sm text-muted-foreground">{facts.notifications.unread === 0 ? 'All caught up.' : 'See what needs you.'}</span>
      </Tile>,
    );
  }

  if (permissions['chores.view']) {
    const streaks = facts.streaks;
    tiles.push(streaks ? (
      <Tile
        key="streaks"
        href="/chores"
        title="Household streaks"
        icon={Flame}
        testId="dashboard-tile-streaks"
        peek={streaks.top.length > 0 ? (
          <ul className="space-y-1">
            {streaks.top.map((entry) => (
              <li key={entry.email} className="flex justify-between gap-2">
                <span className="truncate">{entry.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{streakDaysLabel(entry.streak)}{entry.activeToday ? '' : ', not yet today'}</span>
              </li>
            ))}
          </ul>
        ) : null}
      >
        {streaks.longest > 0 ? (
          <>
            <Big value={streaks.longest} suffix={`${streaks.longest === 1 ? 'day' : 'days'} best streak`} />
            <span className="truncate text-sm text-muted-foreground" data-testid="streaks-leader">
              {streaks.top[0].name}{streaks.running > 1 ? ` and ${streaks.running - 1} more on a streak` : ''}
            </span>
          </>
        ) : (
          <span className="text-sm text-muted-foreground">No streaks yet. Finish a chore today to start one.</span>
        )}
        <span className="text-xs text-muted-foreground" data-testid="streaks-week">{streaks.weekCompleted} done this week</span>
      </Tile>
    ) : failed.has('streaks') || failed.has('chores') ? <UnavailableTile key="streaks" href="/chores" title="Household streaks" icon={Flame} testId="dashboard-tile-streaks" /> : <TileSkeleton key="streaks" />);
  }

  if (weather) {
    tiles.push(
      <Tile key="weather" href="#weather-settings" title="Weather" icon={CloudSun} testId="dashboard-tile-weather">
        <span className="sr-only">{weatherSummary(weather)}</span>
        <span aria-hidden className="font-headline text-3xl font-semibold tabular-nums">{temperatureLabel(weather)}</span>
        <span aria-hidden className="truncate text-sm text-muted-foreground">{weather.label} in {weather.place}</span>
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
