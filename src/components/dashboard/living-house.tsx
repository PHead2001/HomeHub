'use client';

/**
 * The living house (H01): the dashboard hero. Inline SVG and CSS only, built from
 * the household's chore rooms and read-only dashboard facts:
 * - each room glows amber with a badge when it has overdue chores, shows a dot
 *   for chores due today, and sparkles once when today's work there is done;
 * - pets wander in the yard; a pet that has not been fed recently sits by its bowl;
 * - the fridge shows how stocked it is and pulses when food expires soon;
 * - the car and the outdoor HVAC unit show a wrench when service is due;
 * - windows light up in the evening (H02), with seasonal touches (H27) and a
 *   Konami-code disco mode (H29).
 * Every room and object is a real link with a full text name, so the scene is
 * keyboard-navigable and readable without the picture. Under reduced motion it
 * renders fully static.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { AirVent, Car, Cat, Dog, PawPrint, Refrigerator, Sparkles, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { playFeedback } from '@/lib/feedback';
import { seasonFor, type Season } from '@/lib/dashboard/ambience';
import { isTypingTarget, konamiStep } from '@/lib/dashboard/shortcuts';
import { roomSummary, type DashboardFacts, type PetState, type RoomState } from '@/lib/dashboard/facts';
import { MAINTENANCE_REMINDERS_HREF, PANTRY_HREF, petFeedingHref } from '@/lib/dashboard/links';
import { useDayLight } from './time-of-day';
import { PeekCard } from './peek-card';
import styles from './dashboard.module.css';

const SEASONAL_KEY = 'homehub.dashboard.seasonal';
const DISCO_MS = 10_000;
const MAX_ROOMS = 6;

const readSeasonalPref = () => {
  try {
    return window.localStorage.getItem(SEASONAL_KEY) !== 'off';
  } catch {
    return true;
  }
};

function RoomTile({ room, href, sparkle }: { room: RoomState; href: string; sparkle: boolean }) {
  const summary = roomSummary(room);
  const peek = room.chores.length > 0 ? (
    <div>
      <p className="font-medium">{room.name}</p>
      <ul className="mt-1 space-y-1">
        {room.chores.map((chore) => (
          <li key={chore.id} className="flex items-baseline justify-between gap-2">
            <span className="truncate">{chore.task}</span>
            <span className={cn('shrink-0 text-xs', chore.overdue ? 'text-warning' : 'text-muted-foreground')}>{chore.dueLabel}</span>
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  return (
    <PeekCard peek={peek} className="min-w-0">
      <Link
        href={href}
        aria-label={`${room.name}: ${summary}`}
        data-room-status={room.status}
        data-testid={`house-room-${room.id}`}
        className={cn(styles.room, 'block rounded-lg outline-none')}
      >
        <span
          className={cn(
            styles.roomVisual,
            'relative flex h-full min-h-[4.5rem] flex-col justify-between gap-1 overflow-hidden rounded-lg border p-2.5',
            room.status === 'overdue' && 'border-warning/60 bg-warning/10',
            room.status === 'due' && 'border-primary/50 bg-primary/10',
            room.status === 'clear' && 'border-border-subtle bg-background/60',
          )}
        >
          {room.status === 'overdue' && (
            <span aria-hidden className={cn(styles.overdueGlow, 'pointer-events-none absolute inset-0 rounded-lg shadow-[inset_0_0_18px_hsl(var(--warning)/0.35)]')} />
          )}
          <span className="flex items-start justify-between gap-2">
            <span className="truncate text-sm font-medium">{room.name}</span>
            {room.overdue > 0 ? (
              <span aria-hidden className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-warning px-1 text-[11px] font-semibold text-warning-foreground">
                {room.overdue}
              </span>
            ) : room.dueToday > 0 ? (
              <span aria-hidden className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" />
            ) : sparkle ? (
              <Sparkles aria-hidden className={cn(styles.sparkle, 'h-4 w-4 shrink-0 text-success')} />
            ) : null}
          </span>
          <span className={cn('truncate text-xs', room.status === 'overdue' ? 'text-foreground' : 'text-muted-foreground')}>{summary}</span>
        </span>
      </Link>
    </PeekCard>
  );
}

function PetSprite({ pet, index, reduced }: { pet: PetState; index: number; reduced: boolean }) {
  const [hopping, setHopping] = useState(false);
  const pressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const Icon = pet.type === 'Dog' ? Dog : pet.type === 'Cat' ? Cat : PawPrint;
  // The Pets module's own wording: "1 of 2 today. Fed 2 h ago by Sam".
  const status = `${pet.fed ? '' : 'waiting by the bowl, '}${pet.countLabel}. ${pet.headline}`;

  // Long-press (H29): a little hop and the "add" chirp, only if sound/haptics are on.
  const startPress = () => {
    longPressed.current = false;
    pressTimer.current = window.setTimeout(() => {
      longPressed.current = true;
      playFeedback('add');
      if (!reduced) setHopping(true);
    }, 550);
  };
  const endPress = () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  return (
    <Link
      href={petFeedingHref(pet.id)}
      aria-label={`${pet.name}: ${status}`}
      data-testid={`house-pet-${pet.id}`}
      data-fed={pet.fed ? 'true' : 'false'}
      className="relative flex shrink-0 flex-col items-center gap-0.5 rounded-lg px-1 py-0.5 text-[11px]"
      onPointerDown={startPress}
      onPointerUp={endPress}
      onPointerLeave={endPress}
      onContextMenu={(event) => event.preventDefault()}
      onClick={(event) => {
        if (longPressed.current) {
          event.preventDefault();
          longPressed.current = false;
        }
      }}
    >
      <span className="flex items-end gap-0.5">
        <span
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-full border bg-card text-foreground',
            pet.fed && !reduced && (index % 2 ? styles.wanderSlow : styles.wander),
            hopping && styles.hop,
          )}
          onAnimationEnd={(event) => {
            if (event.animationName.includes('hop')) setHopping(false);
          }}
        >
          <Icon aria-hidden className="h-4 w-4" />
        </span>
        {!pet.fed && (
          <svg aria-hidden viewBox="0 0 20 10" className="mb-0.5 h-2.5 w-5 text-warning">
            <path d="M1 2h18l-2.5 7h-13z" fill="currentColor" />
          </svg>
        )}
      </span>
      <span className={cn('max-w-[4.5rem] truncate', pet.fed ? 'text-muted-foreground' : 'font-medium text-warning')}>{pet.name}</span>
    </Link>
  );
}

function YardObject({ href, label, children, testId }: { href: string; label: string; children: ReactNode; testId: string }) {
  return (
    <Link href={href} aria-label={label} data-testid={testId} className="relative flex shrink-0 flex-col items-center gap-0.5 rounded-lg px-1 py-0.5 text-[11px] text-muted-foreground">
      {children}
    </Link>
  );
}

const WrenchBadge = ({ className }: { className?: string }) => (
  <span aria-hidden className={cn('absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-warning text-warning-foreground', className)}>
    <Wrench className="h-2.5 w-2.5" />
  </span>
);

function Roof({ season, golden, lit }: { season: Season; golden: boolean; lit: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 400 70" preserveAspectRatio="none" className="block h-14 w-full sm:h-16">
      <rect x="300" y="8" width="22" height="34" rx="2" className="fill-muted" />
      <polygon
        points="6,68 200,6 394,68"
        className={cn(golden ? 'fill-warning/80 stroke-warning' : 'fill-secondary stroke-border')}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="200" cy="44" r="10" className="fill-background stroke-border" strokeWidth="2" />
      <circle cx="200" cy="44" r="7" className={cn(styles.windowLight, 'fill-warning')} style={{ opacity: lit ? 0.85 : 0 }} />
      {season === 'winter' && (
        <>
          <path d="M40,58 Q120,30 200,10 Q280,30 360,58 L330,58 Q270,36 200,20 Q130,36 70,58 Z" className="fill-foreground/80" />
          {[80, 150, 250, 330].map((x, i) => (
            <circle key={x} cx={x} cy={4} r="1.6" className={cn(styles.snow, 'fill-foreground/80')} style={{ animationDelay: `${i * -3.5}s` }} />
          ))}
        </>
      )}
      {season === 'holidays' && (
        <g transform="translate(352 30)">
          <polygon points="0,-24 12,0 -12,0" className="fill-success" />
          <polygon points="0,-14 15,10 -15,10" className="fill-success" />
          <rect x="-2" y="10" width="4" height="6" className="fill-muted-foreground" />
          {[[-6, 4], [5, -6], [7, 6], [-3, -12]].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="1.6" className={cn(styles.twinkle, i % 2 ? 'fill-warning' : 'fill-destructive')} style={{ animationDelay: `${i * 0.4}s` }} />
          ))}
        </g>
      )}
    </svg>
  );
}

export function LivingHouse({
  facts,
  title,
  roomHref = '/chores',
  golden = false,
  demo = false,
  now,
}: {
  facts: DashboardFacts;
  title: string;
  roomHref?: string;
  golden?: boolean;
  /** Landing-page mode: mock data, links still go to real routes. */
  demo?: boolean;
  now: Date;
}) {
  const reduced = useReducedMotion();
  const light = useDayLight();
  // The dashboard renders only after sign-in on the client, so reading storage here is safe.
  const [seasonalOn, setSeasonalOn] = useState(() => (typeof window === 'undefined' ? true : readSeasonalPref()));
  const [discoRequested, setDisco] = useState(false);
  const disco = discoRequested && !reduced;
  const season = seasonFor(now);

  // Konami code → 10 s of disco. Never under reduced motion, never while typing.
  useEffect(() => {
    if (reduced || demo) return;
    let progress = 0;
    let timeout: number | null = null;
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const step = konamiStep(progress, event.key);
      progress = step.progress;
      if (step.done) {
        // Captured first, so the final "a" does not also open quick add.
        event.preventDefault();
        setDisco(true);
        if (timeout !== null) window.clearTimeout(timeout);
        timeout = window.setTimeout(() => setDisco(false), DISCO_MS);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [reduced, demo]);

  const toggleSeasonal = () => {
    const next = !seasonalOn;
    setSeasonalOn(next);
    try {
      window.localStorage.setItem(SEASONAL_KEY, next ? 'on' : 'off');
    } catch {
      // Storage unavailable: the switch still works for this visit.
    }
  };

  const rooms = facts.chores?.rooms ?? [];
  const shownRooms = rooms.slice(0, MAX_ROOMS);
  const hiddenRooms = rooms.length - shownRooms.length;
  const pets = facts.pets?.pets ?? [];
  const maintenance = facts.maintenance;
  const pantry = facts.pantry;
  const activeSeason = seasonalOn ? season : null;
  const fullness = pantry ? Math.min(1, pantry.fridgeItems / 10) : 0;
  const climateItem = maintenance?.items.find((item) => item.climate && (item.overdue || item.dueSoon));
  const vehicleItem = maintenance?.items.find((item) => item.kind === 'vehicle' && (item.overdue || item.dueSoon));

  const summary = [
    facts.chores ? (rooms.some((room) => room.status === 'overdue')
      ? `Rooms with overdue chores: ${rooms.filter((room) => room.status === 'overdue').map((room) => room.name).join(', ')}.`
      : 'No room has overdue chores.') : null,
    facts.pets && pets.length > 0 ? `${pets.filter((pet) => !pet.fed).length} of ${pets.length} pets waiting to be fed.` : null,
    maintenance ? (maintenance.overdue + maintenance.dueSoon > 0 ? `${maintenance.overdue + maintenance.dueSoon} maintenance items due soon.` : 'Maintenance is up to date.') : null,
  ].filter(Boolean).join(' ');

  return (
    <section aria-labelledby="living-house-title" className="mb-6" data-testid="living-house">
      <div
        className={cn(styles.house, 'overflow-hidden rounded-2xl border bg-card/80 shadow-raised', disco && styles.disco)}
        style={light?.style}
        data-disco={disco ? 'true' : undefined}
      >
        <div aria-hidden className={styles.sky} />
        <div className="flex items-center justify-between gap-2 px-4 pt-3">
          <h2 id="living-house-title" className="min-w-0 truncate font-headline text-lg font-semibold">{title}</h2>
          {season && !demo && (
            <button
              type="button"
              onClick={toggleSeasonal}
              aria-pressed={seasonalOn}
              className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Seasonal touches {seasonalOn ? 'on' : 'off'}
            </button>
          )}
        </div>
        <p className="sr-only">{summary}</p>

        <div className="px-3 sm:px-6">
          <Roof season={activeSeason} golden={golden} lit={Boolean(light?.lit)} />
          <div className="rounded-b-lg border-x-2 border-b-2 border-border bg-background/40 p-2 sm:p-3">
            {facts.chores ? (
              shownRooms.length > 0 ? (
                <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Rooms">
                  {shownRooms.map((room) => (
                    <li key={room.id} className="min-w-0">
                      <RoomTile room={room} href={roomHref} sparkle={room.status === 'clear' && room.doneToday > 0} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-2 py-4 text-center text-sm text-muted-foreground">
                  Add rooms to your chores and they will appear here.{' '}
                  <Link href="/chores" className="font-medium text-primary underline-offset-4 hover:underline">Open Chores</Link>
                </p>
              )
            ) : (
              <p className="px-2 py-4 text-center text-sm text-muted-foreground">Welcome home.</p>
            )}
            {hiddenRooms > 0 && (
              <p className="mt-2 text-center text-xs text-muted-foreground">
                <Link href={roomHref} className="hover:text-foreground">+{hiddenRooms} more {hiddenRooms === 1 ? 'room' : 'rooms'}</Link>
              </p>
            )}
          </div>
        </div>

        <div className="mt-2 flex items-end gap-3 overflow-x-auto border-t border-border-subtle bg-secondary/40 px-4 pb-2 pt-3" aria-label="Yard" role="group">
          {pantry && (
            <YardObject
              href={PANTRY_HREF}
              testId="house-fridge"
              label={`Fridge: ${pantry.fridgeItems} ${pantry.fridgeItems === 1 ? 'item' : 'items'}${pantry.expiringSoon ? `, ${pantry.expiringSoon} expiring soon` : ''}`}
            >
              <span className="relative flex h-9 w-7 items-end overflow-hidden rounded-md border bg-card">
                <span aria-hidden className="absolute inset-x-0 bottom-0 bg-info/30" style={{ height: `${Math.round(fullness * 100)}%` }} />
                <Refrigerator aria-hidden className={cn('relative m-auto h-4 w-4', pantry.expiringSoon > 0 && !reduced && styles.pulse)} />
                {pantry.expiringSoon > 0 && <span aria-hidden className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-warning" />}
              </span>
              <span>Fridge</span>
            </YardObject>
          )}
          {maintenance && (
            <YardObject
              href={climateItem?.href ?? MAINTENANCE_REMINDERS_HREF}
              testId="house-hvac"
              label={maintenance.climateDue ? `Heating and cooling: ${climateItem?.label ?? 'needs attention'}` : 'Heating and cooling: all good'}
            >
              <span className="relative flex h-9 w-9 items-center justify-center rounded-md border bg-card">
                <AirVent aria-hidden className="h-4 w-4" />
                {maintenance.climateDue && <WrenchBadge />}
              </span>
              <span>HVAC</span>
            </YardObject>
          )}
          {maintenance && maintenance.vehicles > 0 && (
            <YardObject
              href={vehicleItem?.href ?? MAINTENANCE_REMINDERS_HREF}
              testId="house-car"
              label={maintenance.vehicleDue ? `Car: ${vehicleItem?.label ?? 'service'} due` : 'Car: no service due'}
            >
              <span className="relative flex h-9 w-12 items-center justify-center rounded-md border bg-card">
                <Car aria-hidden className="h-5 w-5" />
                {maintenance.vehicleDue && <WrenchBadge />}
              </span>
              <span>Driveway</span>
            </YardObject>
          )}
          <span className="flex-1" aria-hidden />
          {pets.map((pet, index) => (
            <PetSprite key={pet.id} pet={pet} index={index} reduced={reduced || demo} />
          ))}
        </div>
      </div>
    </section>
  );
}
