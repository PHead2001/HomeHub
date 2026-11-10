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
import { Bell, CheckSquare, CloudSun, Flame, PawPrint, Plus, Refrigerator, ShoppingCart, Wrench, type LucideIcon } from 'lucide-react';
import { NumberTicker } from '@/components/motion/number-ticker';
import { Stagger } from '@/components/motion/stagger';
import { ShortcutHint } from '@/components/ui/shortcut-hint';
import { openCommandPalette } from '@/components/command/events';
import { shortcutById, type ShortcutId } from '@/lib/dashboard/shortcuts';
import type { DashboardFacts } from '@/lib/dashboard/facts';
import { sectionHint, type SectionState } from '@/lib/dashboard/dashboard-store';
import { feedingFailureKey } from '@/lib/dashboard/assemble';
import { MAINTENANCE_REMINDERS_HREF, PANTRY_HREF } from '@/lib/dashboard/links';
import { streakDaysLabel, streakSummary } from '@/lib/dashboard/streaks';
import { tiltFor } from '@/lib/dashboard/tilt';
import { dailyLabel, temperatureLabel, weatherSummary } from '@/lib/dashboard/weather';
import { useLiveWeatherState } from '@/lib/dashboard/use-weather';
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
  quickAdd,
  hint,
  children,
}: {
  /** Omitted for a tile with nowhere to go (weather, HP-24): it is not a link. */
  href?: string;
  title: string;
  icon: LucideIcon;
  testId: string;
  className?: string;
  peek?: ReactNode;
  /** A quick-add button in the corner (outside the link), with its shortcut hint. */
  quickAdd?: { shortcut: ShortcutId; label: string };
  /** Stale data: "Reconnecting…" or "Updated 9:41" next to the title. */
  hint?: string | null;
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
  const body = (
    <>
      <span className={cn('flex items-center gap-2 text-sm font-medium text-muted-foreground', quickAdd && 'pr-8')}>
        <Icon aria-hidden className="h-4 w-4 text-primary" />
        <span className="truncate">{title}</span>
        {hint && <span className="ml-auto shrink-0 text-xs font-normal" data-testid={`${testId}-stale`}>{hint}</span>}
      </span>
      {children}
    </>
  );
  if (!href) {
    return (
      <div data-testid={testId} className={cn('relative min-w-0', className)}>
        <div className="flex h-full min-h-[8.5rem] flex-col gap-2 rounded-xl border bg-card p-4 shadow-raised">{body}</div>
      </div>
    );
  }
  return (
    <PeekCard peek={peek ?? null} className={cn('relative min-w-0', className)}>
      <Link
        href={href}
        data-testid={testId}
        className={cn(styles.tilt, 'block h-full rounded-xl')}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
      >
        <span className={cn(styles.tiltLayer, 'glow-card flex h-full min-h-[8.5rem] flex-col gap-2 rounded-xl border bg-card p-4 shadow-raised transition-ui hover:border-primary/40')}>
          {body}
        </span>
      </Link>
      {quickAdd && <TileQuickAdd {...quickAdd} />}
    </PeekCard>
  );
}

/**
 * Opens the palette with the same prefix as the keyboard shortcut (H28), so the
 * button and its key hint come from one binding. A sibling of the tile link (never
 * nested in it) in the tile's corner; the link box underneath does not move.
 */
function TileQuickAdd({ shortcut, label }: { shortcut: ShortcutId; label: string }) {
  const { action } = shortcutById(shortcut);
  const prefix = action.type === 'quick-add' ? action.prefix : '';
  return (
    <ShortcutHint shortcut={shortcut} label={label} side="left">
      <button
        type="button"
        aria-label={label}
        data-testid={`tile-quick-add-${shortcut}`}
        onClick={() => openCommandPalette({ text: prefix })}
        className="absolute right-2 top-2 z-10 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-ui hover:bg-muted hover:text-foreground"
      >
        <Plus aria-hidden className="h-4 w-4" />
      </button>
    </ShortcutHint>
  );
}

/**
 * A section whose read failed: says so, and never shows an empty or zero state instead.
 * A failed read keeps retrying in the background and offers Retry (a sibling of the
 * link, never inside it); a read the server refused says it is not shared with you.
 */
function UnavailableTile({
  href, title, icon: Icon, testId, className, unauthorized = false, onRetry,
}: { href: string; title: string; icon: LucideIcon; testId: string; className?: string; unauthorized?: boolean; onRetry?: () => void }) {
  return (
    <div className={cn('relative min-w-0', className)}>
      <Link
        href={href}
        data-testid={testId}
        data-unavailable="true"
        data-section-state={unauthorized ? 'unauthorized' : 'failed'}
        className="flex h-full min-h-[8.5rem] min-w-0 flex-col gap-2 rounded-xl border border-dashed bg-card p-4 text-sm transition-ui"
      >
        <span className="flex items-center gap-2 font-medium text-muted-foreground">
          <Icon aria-hidden className="h-4 w-4" />
          <span className="truncate">{title}</span>
        </span>
        <span className="text-muted-foreground">{unauthorized ? 'Not shared with you.' : 'Unavailable right now.'}</span>
      </Link>
      {!unauthorized && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          data-testid={`${testId}-retry`}
          className="absolute bottom-3 left-4 rounded-md border px-2 py-1 text-xs font-medium text-foreground transition-ui hover:bg-muted"
        >
          Retry
        </button>
      )}
    </div>
  );
}

function TileSkeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('min-h-[8.5rem] animate-pulse rounded-xl border bg-muted/40', className)} />;
}

/** HP-2b: an empty track when nothing is scheduled; full (green) only when today's work is all done. */
function ProgressRing({ done, total, settled }: { done: number; total: number; settled: boolean }) {
  const radius = 30;
  const circumference = 2 * Math.PI * radius;
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
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
        // Green only when the day is done and nothing is overdue: never a celebration over overdue work.
        className={cn(ratio >= 1 && settled ? 'stroke-success' : 'stroke-primary')}
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

export function BentoGrid({
  facts, loading, failed, sections = {}, timeZone, onRetry,
}: {
  facts: DashboardFacts;
  loading: boolean;
  failed: Set<string>;
  /** Section states (GOAL-states): stale tiles show a hint, unauthorized ones say so. */
  sections?: Readonly<Record<string, SectionState>>;
  timeZone?: string;
  onRetry?: () => void;
}) {
  const { permissions } = useAuth();
  const { report: weather, stale: weatherStale } = useLiveWeatherState();
  const tiles: ReactNode[] = [];
  const hint = (...groups: string[]) => sectionHint(sections, groups, timeZone);
  const unauthorized = (...groups: string[]) => groups.some((group) => sections[group]?.status === 'unauthorized');

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
        hint={hint('chores')}
        quickAdd={permissions['chores.create'] ? { shortcut: 'new-chore', label: 'Add a chore' } : undefined}
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
          <ProgressRing done={chores.todayDone} total={chores.todayTotal} settled={chores.overdueTotal === 0} />
          {chores.todayTotal === 0 ? (
            // HP-2a: 0 of 0 is an empty state, with the overdue count as the headline when there is one.
            <span className="min-w-0" data-testid="chores-tile-empty">
              {chores.overdueTotal > 0 ? (
                <span className="block font-headline text-2xl font-semibold tabular-nums text-warning">
                  <NumberTicker value={chores.overdueTotal} /> overdue
                </span>
              ) : null}
              <span className={cn('block', chores.overdueTotal > 0 ? 'text-sm text-muted-foreground' : 'font-headline text-xl font-semibold')}>
                Nothing scheduled today
              </span>
              {chores.mineOpen > 0 && (
                <span className="block text-sm text-muted-foreground"><NumberTicker value={chores.mineOpen} animateOnMount={false} /> open for you</span>
              )}
            </span>
          ) : (
            <span className="min-w-0">
              <span className="block font-headline text-2xl font-semibold tabular-nums">
                <NumberTicker value={chores.todayDone} /> of <NumberTicker value={chores.todayTotal} /> done
              </span>
              <span className="block text-sm text-muted-foreground">
                {chores.mineOpen === 0 ? 'Nothing assigned to you.' : <><NumberTicker value={chores.mineOpen} animateOnMount={false} /> open for you</>}
                {chores.overdueTotal > 0 && <span className="text-warning">{` · ${chores.overdueTotal} overdue`}</span>}
              </span>
            </span>
          )}
        </span>
        {chores.nextUp.length > 0 && (
          <span className="hidden text-sm text-muted-foreground lg:block">
            Next: <span className="text-foreground">{chores.nextUp[0].task}</span> ({chores.nextUp[0].dueLabel})
          </span>
        )}
      </Tile>
    ) : failed.has('chores') ? <UnavailableTile key="chores" href="/chores" title="Today's chores" icon={CheckSquare} testId="dashboard-tile-chores" className="sm:col-span-2 lg:row-span-2" unauthorized={unauthorized('chores')} onRetry={onRetry} /> : loading ? <TileSkeleton key="chores" className="sm:col-span-2 lg:row-span-2" /> : null);
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
        hint={hint('shopping')}
        quickAdd={permissions['shopping.edit'] ? { shortcut: 'add-item', label: 'Add a shopping item' } : undefined}
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
    ) : failed.has('shopping') ? <UnavailableTile key="shopping" href="/shopping" title="Shopping" icon={ShoppingCart} testId="dashboard-tile-shopping" className="sm:col-span-2" unauthorized={unauthorized('shopping')} onRetry={onRetry} /> : loading ? <TileSkeleton key="shopping" className="sm:col-span-2" /> : null);
  }

  if (permissions['pets.view']) {
    const pets = facts.pets;
    tiles.push(pets ? (
      <Tile
        key="pets"
        href="/pets"
        title="Pets"
        icon={PawPrint}
        testId="dashboard-tile-pets"
        // The pets collection and each pet's feeding history: a stale count is never shown as current.
        hint={hint('pets', ...pets.pets.map((pet) => feedingFailureKey(pet.id)))}
        quickAdd={permissions['pets.addLogs'] && pets.pets.length > 0 ? { shortcut: 'log-feeding', label: 'Log a feeding' } : undefined}
      >
        {pets.pets.length === 0 ? (
          <span className="text-sm text-muted-foreground">No pets yet.</span>
        ) : (
          <ul className="space-y-1 text-sm">
            {pets.pets.slice(0, 3).map((pet) => (
              <li key={pet.id} className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{pet.name}</span>
                <span className={cn('shrink-0 text-xs', pet.fed === null ? 'text-muted-foreground' : pet.fed ? 'text-success' : 'text-warning')}>
                  {pet.countLabel}{pet.feedingHint ? ` · ${pet.feedingHint}` : ''}
                </span>
              </li>
            ))}
            {pets.pets.length > 3 && <li className="text-xs text-muted-foreground">+<NumberTicker value={pets.pets.length - 3} animateOnMount={false} /> more</li>}
          </ul>
        )}
      </Tile>
    ) : failed.has('pets') ? <UnavailableTile key="pets" href="/pets" title="Pets" icon={PawPrint} testId="dashboard-tile-pets" unauthorized={unauthorized('pets')} onRetry={onRetry} /> : loading ? <TileSkeleton key="pets" /> : null);
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
        hint={hint('maintenance')}
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
    ) : failed.has('maintenance') ? <UnavailableTile key="maintenance" href={MAINTENANCE_REMINDERS_HREF} title="Next maintenance" icon={Wrench} testId="dashboard-tile-maintenance" unauthorized={unauthorized('maintenance')} onRetry={onRetry} /> : loading ? <TileSkeleton key="maintenance" /> : null);
  }

  if (permissions['shopping.view']) {
    const pantry = facts.pantry;
    tiles.push(pantry ? (
      <Tile key="pantry" href={PANTRY_HREF} title="Expiring soon" icon={Refrigerator} testId="dashboard-tile-pantry" hint={hint('pantry')}>
        {pantry.expiringSoon === 0 && pantry.expired === 0 ? (
          // HP-22d: said once, not "0 this week" over "Nothing close to expiring".
          <span className="font-headline text-xl font-semibold" data-testid="pantry-tile-empty">Nothing expiring this week</span>
        ) : (
          <>
            {/* HP-22e: the count keeps "this week"; expired items get their own line. */}
            <Big value={pantry.expiringSoon} suffix="this week" />
            {pantry.expired > 0 && <span className="text-sm text-warning" data-testid="pantry-tile-expired">{pantry.expired} expired</span>}
          </>
        )}
        {pantry.nearest[0] && (
          <span className="truncate text-sm text-muted-foreground">{pantry.nearest[0].name} {pantry.nearest[0].label}</span>
        )}
      </Tile>
    ) : failed.has('pantry') ? <UnavailableTile key="pantry" href={PANTRY_HREF} title="Expiring soon" icon={Refrigerator} testId="dashboard-tile-pantry" unauthorized={unauthorized('pantry')} onRetry={onRetry} /> : loading ? <TileSkeleton key="pantry" /> : null);
  }

  if (permissions['notifications.view'] && failed.has('notifications')) {
    tiles.push(<UnavailableTile key="notifications" href="/notifications" title="Notifications" icon={Bell} testId="dashboard-tile-notifications" unauthorized={unauthorized('notifications')} onRetry={onRetry} />);
  } else if (permissions['notifications.view'] && facts.notifications) {
    tiles.push(
      <Tile key="notifications" href="/notifications" title="Notifications" icon={Bell} testId="dashboard-tile-notifications" hint={hint('notifications')}>
        <Big value={facts.notifications.unread} suffix="unread" />
        <span className="text-sm text-muted-foreground">{facts.notifications.unread === 0 ? 'All caught up.' : 'See what needs you.'}</span>
      </Tile>,
    );
  }

  // Hidden entirely (no names, ranking, peek or screen-reader sentence) when the
  // household turned the Chores leaderboard off.
  if (permissions['chores.view'] && !facts.streaksHidden) {
    const streaks = facts.streaks;
    tiles.push(streaks ? (
      <Tile
        key="streaks"
        href="/chores"
        title="Household streaks"
        icon={Flame}
        testId="dashboard-tile-streaks"
        hint={hint('streaks', 'chores')}
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
        {/* One sentence for screen readers; the ticking number and labels below are visual only. */}
        <span className="sr-only" data-testid="streaks-summary">{streakSummary(streaks)}</span>
        {streaks.longest > 0 ? (
          <span aria-hidden className="flex min-w-0 flex-col gap-2">
            <Big value={streaks.longest} suffix={`${streaks.longest === 1 ? 'day' : 'days'} best streak`} />
            <span className="truncate text-sm text-muted-foreground" data-testid="streaks-leader">
              {streaks.top[0].name}{streaks.running > 1 ? ` and ${streaks.running - 1} more on a streak` : ''}
            </span>
          </span>
        ) : (
          <span aria-hidden className="text-sm text-muted-foreground">No streaks yet. Finish a chore today to start one.</span>
        )}
        <span aria-hidden className="text-xs text-muted-foreground" data-testid="streaks-week">{streaks.weekCompleted} done this week</span>
      </Tile>
    ) : failed.has('streaks') || failed.has('chores') ? <UnavailableTile key="streaks" href="/chores" title="Household streaks" icon={Flame} testId="dashboard-tile-streaks" unauthorized={unauthorized('streaks', 'chores')} onRetry={onRetry} /> : <TileSkeleton key="streaks" />);
  }

  if (weather) {
    const daily = dailyLabel(weather);
    tiles.push(
      // HP-24: not a link (there is no forecast page to open); the house holds the settings.
      <Tile
        key="weather"
        title="Weather"
        icon={CloudSun}
        testId="dashboard-tile-weather"
        // HP-6a: a failed refresh keeps the last good report, marked with its time.
        hint={weatherStale ? `Updated ${new Date(weather.fetchedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : null}
      >
        <span className="sr-only">{weatherSummary(weather)}</span>
        <span aria-hidden className="font-headline text-3xl font-semibold tabular-nums">{temperatureLabel(weather)}</span>
        <span aria-hidden className="truncate text-sm text-muted-foreground">{weather.label} in {weather.place}</span>
        {daily && <span aria-hidden className="truncate text-xs text-muted-foreground" data-testid="weather-tile-daily">{daily}</span>}
      </Tile>,
    );
  }

  const visible = tiles.filter(Boolean);

  return (
    <section aria-labelledby="dashboard-grid-heading" className="mb-8">
      <h2 id="dashboard-grid-heading" className="mb-3 font-headline text-xl font-semibold">Your Dashboard</h2>
      {visible.length > 0 ? (
        // Tiles (and their skeletons) enter in turn (H12 stagger budget).
        <Stagger className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-busy={loading || undefined} data-testid="dashboard-grid">
          {visible}
        </Stagger>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing to show yet. Your household role decides which sections appear here.</p>
      )}
    </section>
  );
}
