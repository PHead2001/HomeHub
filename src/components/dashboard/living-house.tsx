'use client';

/**
 * The living house (H01): the dashboard hero. An isometric-style cutaway in inline
 * SVG and CSS (no WebGL), built from the household's chore rooms
 * (`layoutHouse` in `src/lib/dashboard/house-layout.ts`) and read-only dashboard facts:
 * - each room glows amber with a badge when it has overdue chores, shows a dot for
 *   chores due today, and sparkles once when today's work there is done;
 * - fed pets wander between rooms; a pet not fed on schedule sits by its bowl; a
 *   pet whose feeding history is unavailable rests without any claim;
 * - the pantry (drawn as a fridge) shows how stocked it is and pulses when food
 *   expires soon, both counted over the whole pantry (HP-9);
 * - the car and the outdoor HVAC unit (only when the home has a climate asset, HP-8)
 *   show a wrench when service is due;
 * - a home health badge mirrors Maintenance's score (H10);
 * - windows light up in the evening and live weather is drawn over it (H02), with
 *   seasonal touches (H27), a disco mode (the Konami code, or five taps on the roof
 *   within two seconds, HP-19b) and pet sounds (H29).
 *
 * Touch (HP-13, HP-14): without a fine, hovering pointer each room lists its top chores
 * inline (two lines on phones, three wider, five in the wide layout) instead of in a
 * peek card, the text follows a larger type scale on coarse pointers, and every control
 * is at least 44 px (48 px on touch). Attention animations run three cycles and hold,
 * and run again when their state changes (HP-16a). The display settings (live weather,
 * seasonal touches) sit in the house's "..." menu (HP-18a).
 *
 * The SVG is decoration (`aria-hidden`). Every room is an HTML link laid exactly
 * over its rectangle, with the full text name, so the scene is navigable room by
 * room (Tab, or arrow keys between rooms) and readable without the picture.
 * Clicking a room zooms into it and morphs into Chores filtered to that room
 * (`/chores?room=<roomId>`); under reduced motion it is a plain navigation and the
 * scene is fully static. The zoom resets if the navigation does not happen (HP-11c).
 *
 * While the chores load (HP-7) the house keeps an outline: an earlier day's room layout
 * (names only, each labelled "Loading…") or a plain four-room outline, never the
 * no-permission copy and never "All clear".
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import Link from 'next/link';
import { AirVent, Car, Cat, Dog, PawPrint, Refrigerator, Sparkles, Wrench, type LucideProps } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { useMorphNavigation } from '@/hooks/use-morph-navigation';
import { morphStyle } from '@/lib/motion';
import { seasonFor, type Season } from '@/lib/dashboard/ambience';
import { isComposingKey, isTypingTarget, konamiStep } from '@/lib/dashboard/shortcuts';
import { roomSummary, type DashboardFacts, type PetState, type RoomState } from '@/lib/dashboard/facts';
import { choresRoomHref, roomMorphName, MAINTENANCE_OVERVIEW_HREF, MAINTENANCE_REMINDERS_HREF, PANTRY_HREF, petFeedingHref } from '@/lib/dashboard/links';
import { fitHouse, layoutHouse, MAX_HOUSE_ROOMS, placePets, roomNeighbor, type HouseLayout, type NavKey, type PetPlacement, type RoomPlacement } from '@/lib/dashboard/house-layout';
import { healthSummaryText, type HealthResult } from '@/lib/maintenance/health';
import { playPetSound } from '@/lib/dashboard/pet-sound';
import { useLiveWeather } from '@/lib/dashboard/use-weather';
import { staleHint, type SectionState } from '@/lib/dashboard/dashboard-store';
import type { HouseOutlineRoom } from '@/lib/dashboard/house-snapshot';
import { attentionKey, INLINE_CHORES, inlineRoomChores, onRoof, PEEK_ROOM_CHORES, registerTap, roomDetailRows, roomLinkName } from '@/lib/dashboard/touch';
import { useDayLight, WeatherLayer } from './time-of-day';
import { useWeatherSettings, WeatherCityForm } from './weather-controls';
import { HouseMenu } from './house-menu';
import { PeekCard } from './peek-card';
import { PetFedButton } from './one-tap';
import styles from './dashboard.module.css';

const SEASONAL_KEY = 'homehub.dashboard.seasonal';
const DISCO_MS = 10_000;
/** Camera move into a room before the route morph starts (scene budget 400–900 ms). */
const ZOOM_MS = 420;
/** HP-11c: a zoom still showing this long after the navigation started is undone. */
const ZOOM_RESET_MS = 3_000;
/** Anonymous rooms of the loading outline when no earlier layout is known (as the skeleton). */
const OUTLINE_IDS = ['outline-a', 'outline-b', 'outline-c', 'outline-d'];
const LOADING_LABEL = 'Loading…';

/** A room with no counts, drawn while the chores load. */
const placeholderRoom = (id: string, name: string): RoomState => ({
  id, name, overdue: 0, dueToday: 0, upcoming: 0, doneToday: 0, status: 'clear', chores: [],
});
const LONG_PRESS_MS = 550;
const NAV_KEYS = new Set<string>(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

const readSeasonalPref = () => {
  try {
    return window.localStorage.getItem(SEASONAL_KEY) !== 'off';
  } catch {
    return true;
  }
};

function PetIcon({ type, ...props }: { type: string } & LucideProps) {
  if (type === 'Dog') return <Dog {...props} />;
  if (type === 'Cat') return <Cat {...props} />;
  return <PawPrint {...props} />;
}

/** "1 of 2 today. Fed 2 h ago by Sam", or the Pets module's unavailable line. */
const petStatus = (pet: PetState) => (pet.fed === null
  ? pet.headline
  : `${pet.fed ? '' : 'waiting by the bowl, '}${pet.countLabel}. ${pet.headline}${pet.feedingHint ? ` (${pet.feedingHint})` : ''}`);

/* ------------------------------------------------------------------------- */
/* SVG layers (decorative)                                                    */
/* ------------------------------------------------------------------------- */

const points = (list: Array<{ x: number; y: number }>) => list.map((p) => `${p.x},${p.y}`).join(' ');

function RoomShape({ placement, room, lit, active }: { placement: RoomPlacement; room: RoomState; lit: boolean; active: boolean }) {
  const { x, y, w, h } = placement;
  const i = 9;
  return (
    <g className={cn(styles.roomLayer, active && styles.roomLayerActive)} data-room-shape={room.id}>
      <rect
        x={x + i}
        y={y + i}
        width={w - i * 2}
        height={h - i * 2}
        className={cn(room.status === 'overdue' ? 'fill-warning/20' : room.status === 'due' ? 'fill-primary/15' : 'fill-card')}
      />
      {/* Ceiling, side walls and floor in one-point perspective. */}
      <polygon points={points([{ x, y }, { x: x + w, y }, { x: x + w - i, y: y + i }, { x: x + i, y: y + i }])} className="fill-muted/70" />
      <polygon points={points([{ x, y }, { x: x + i, y: y + i }, { x: x + i, y: y + h - i }, { x, y: y + h }])} className="fill-muted/50" />
      <polygon points={points([{ x: x + w, y }, { x: x + w, y: y + h }, { x: x + w - i, y: y + h - i }, { x: x + w - i, y: y + i }])} className="fill-muted/30" />
      <polygon points={points([{ x, y: y + h }, { x: x + w, y: y + h }, { x: x + w - i, y: y + h - i }, { x: x + i, y: y + h - i }])} className="fill-secondary" />
      <rect x={x + w - 34} y={y + i + 6} width="16" height="12" rx="1.5" className="fill-background stroke-border" strokeWidth="1" data-room-window={room.id} />
      <rect x={x + w - 33} y={y + i + 7} width="14" height="10" rx="1" className={cn(styles.windowLight, 'fill-warning')} style={{ '--window-glow': lit ? 0.75 : 0 } as CSSProperties} />
      {room.status === 'overdue' && (
        // HP-16a: keyed by the count, so a newly overdue chore runs the glow again.
        <rect key={attentionKey('glow', room.overdue)} x={x + 2} y={y + 2} width={w - 4} height={h - 4} rx="2" className={cn(styles.overdueGlow, 'fill-none stroke-warning')} strokeWidth="3" />
      )}
      <rect x={x} y={y} width={w} height={h} className="fill-none stroke-border" strokeWidth="1.5" />
    </g>
  );
}

function PetFigure({ pet, placement, hopping, onHopEnd }: { pet: PetState; placement: PetPlacement; hopping: boolean; onHopEnd: () => void }) {
  const [p0, p1, p2] = [placement.path[0], placement.path[1] ?? placement.path[0], placement.path[2] ?? placement.path[0]];
  const style = {
    '--p0x': `${p0.x}px`, '--p0y': `${p0.y}px`,
    '--p1x': `${p1.x}px`, '--p1y': `${p1.y}px`,
    '--p2x': `${p2.x}px`, '--p2y': `${p2.y}px`,
    transform: `translate(${placement.at.x}px, ${placement.at.y}px)`,
  } as CSSProperties;
  return (
    <g data-pet-figure={pet.id} data-pet-mode={placement.mode} className={cn(placement.mode === 'wander' && styles.petWalk)} style={style}>
      <g className={cn(hopping && styles.hop)} onAnimationEnd={onHopEnd}>
        <circle cx="0" cy="-9" r="9" className={cn('fill-card', pet.fed === false ? 'stroke-warning' : 'stroke-border')} strokeWidth="1.5" />
        <PetIcon type={pet.type} x={-6} y={-15} width={12} height={12} className="text-foreground" strokeWidth={2} />
      </g>
    </g>
  );
}

function Scenery({ layout, season, golden, lit }: { layout: HouseLayout; season: Season; golden: boolean; lit: boolean }) {
  const { body, apex, width, groundY, height } = layout;
  return (
    <>
      <rect x="0" y={groundY} width={width} height={height - groundY} className="fill-secondary/70" />
      <line x1="0" x2={width} y1={groundY} y2={groundY} className="stroke-border" strokeWidth="1.5" />
      <polygon points={points(layout.sideWall)} className="fill-muted stroke-border" strokeWidth="1.5" strokeLinejoin="round" />
      {/* The chimney and the attic window keep their place on a steeper roof (HP-12e). */}
      <rect x={apex.x + body.w / 4} y={body.y - Math.round(layout.roofH * 0.86)} width="16" height={Math.round(layout.roofH * 0.52)} rx="2" className="fill-muted stroke-border" strokeWidth="1.5" />
      <polygon points={points(layout.roofSide)} className={cn(golden ? 'fill-warning/60' : 'fill-muted', 'stroke-border')} strokeWidth="1.5" strokeLinejoin="round" />
      <polygon points={points(layout.roofFront)} className={cn(golden ? 'fill-warning/80 stroke-warning' : 'fill-secondary stroke-border')} strokeWidth="2" strokeLinejoin="round" />
      <circle cx={apex.x} cy={body.y - Math.round(layout.roofH * 0.38)} r="10" className="fill-background stroke-border" strokeWidth="2" />
      <circle cx={apex.x} cy={body.y - Math.round(layout.roofH * 0.38)} r="7" className={cn(styles.windowLight, 'fill-warning')} style={{ '--window-glow': lit ? 0.85 : 0 } as CSSProperties} />
      <rect x={body.x} y={body.y} width={body.w} height={body.h} className="fill-background/40 stroke-border" strokeWidth="2" />
      {layout.emptyCells.map((cell) => (
        <g key={`${cell.x}-${cell.y}`}>
          <rect x={cell.x + 9} y={cell.y + 9} width={cell.w - 18} height={cell.h - 18} className="fill-muted/40" />
          <rect x={cell.x + cell.w / 2 - 10} y={cell.y + 22} width="20" height="16" rx="2" className="fill-background stroke-border" strokeWidth="1" />
        </g>
      ))}
      {season === 'winter' && (
        <>
          <polygon
            points={points([layout.roofFront[0], apex, layout.roofFront[2], { x: layout.roofFront[2].x - 18, y: body.y - 4 }, { x: apex.x, y: apex.y + 10 }, { x: layout.roofFront[0].x + 18, y: body.y - 4 }])}
            className="fill-foreground/80"
          />
          {[0.15, 0.4, 0.62, 0.86].map((t, index) => (
            <circle key={t} cx={Math.round(width * t)} cy={6} r="1.6" className={cn(styles.snow, 'fill-foreground/80')} style={{ animationDelay: `${index * -3.5}s` }} />
          ))}
        </>
      )}
      {season === 'holidays' && (
        <g transform={`translate(${width - 22} ${groundY - 2})`}>
          <polygon points="0,-30 12,-8 -12,-8" className="fill-success" />
          <polygon points="0,-20 15,2 -15,2" className="fill-success" />
          {[[-6, -6], [5, -16], [7, -3], [-3, -22]].map(([x, y], index) => (
            <circle key={index} cx={x} cy={y} r="1.6" className={cn(styles.twinkle, index % 2 ? 'fill-warning' : 'fill-destructive')} style={{ animationDelay: `${index * 0.4}s` }} />
          ))}
        </g>
      )}
      {season === 'halloween' && (
        <g transform={`translate(${width - 22} ${groundY + 13})`}>
          <ellipse cx="0" cy="0" rx="9" ry="7" className="fill-warning" />
          <rect x="-1" y="-10" width="2" height="4" className="fill-success" />
        </g>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------- */
/* HTML layers (the links)                                                    */
/* ------------------------------------------------------------------------- */

function RoomLink({
  room,
  placement,
  sparkle,
  morphing,
  loading = false,
  onActive,
  onNavigate,
}: {
  room: RoomState;
  placement: RoomPlacement;
  sparkle: boolean;
  morphing: boolean;
  /** HP-7b: drawn from an earlier day's layout while the chores load; no counts are claimed. */
  loading?: boolean;
  onActive: (id: string | null) => void;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>, room: RoomState, placement: RoomPlacement, href: string) => void;
}) {
  const summary = loading ? LOADING_LABEL : roomSummary(room);
  const href = choresRoomHref(room.id);
  // HP-13a: the inline lines for touch; the CSS shows as many as the screen allows.
  const inline = inlineRoomChores(room, INLINE_CHORES.wide, loading);
  const peek = !loading && room.chores.length > 0 ? (
    <div>
      <p className="font-medium">{room.name}</p>
      <ul className="mt-1 space-y-1">
        {room.chores.slice(0, PEEK_ROOM_CHORES).map((chore) => (
          <li key={chore.id} className="flex items-baseline justify-between gap-2">
            <span className="truncate">{chore.task}</span>
            <span className={cn('shrink-0 text-xs', chore.overdue ? 'text-warning' : 'text-muted-foreground')}>{chore.dueLabel}</span>
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  return (
    <li
      className="absolute min-w-0"
      style={{ left: `${placement.box.left}%`, top: `${placement.box.top}%`, width: `${placement.box.width}%`, height: `${placement.box.height}%` }}
    >
      <PeekCard peek={peek} className="h-full min-w-0">
        <Link
          href={href}
          // HP-28b: the chore titles are part of the name on every pointer.
          aria-label={roomLinkName(room, summary, loading)}
          aria-busy={loading || undefined}
          data-room-status={loading ? 'loading' : room.status}
          data-room-id={room.id}
          data-testid={`house-room-${room.id}`}
          // The click zooms first and then morphs (useMorphNavigation), so the
          // generic link transition must not hold the page meanwhile.
          data-route-transition="manual"
          className={cn(styles.room, 'block h-full rounded-sm outline-none')}
          onClick={(event) => onNavigate(event, room, placement, href)}
          onPointerEnter={(event) => {
            if (event.pointerType === 'mouse') onActive(room.id);
          }}
          onPointerLeave={() => onActive(null)}
          onFocus={() => onActive(room.id)}
          onBlur={() => onActive(null)}
        >
          <span
            className={cn(styles.roomVisual, 'flex h-full flex-col justify-between gap-0.5 overflow-hidden px-[9%] pb-[14%] pt-[10%]')}
            style={morphing ? morphStyle(roomMorphName(room.id)) : undefined}
          >
            <span className="flex min-w-0 items-start justify-between gap-1">
              <span className={cn(styles.roomName, 'truncate text-xs font-semibold sm:text-sm')} data-room-name={room.id}>{room.name}</span>
              {loading ? null : room.overdue > 0 ? (
                <span aria-hidden className={cn(styles.roomBadge, 'flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-warning px-1 text-[10px] font-semibold text-warning-foreground sm:h-5 sm:min-w-5 sm:text-[11px]')}>
                  {room.overdue}
                </span>
              ) : room.dueToday > 0 ? (
                <span aria-hidden className={cn(styles.roomDot, 'mt-1 h-2 w-2 shrink-0 rounded-full bg-primary')} />
              ) : sparkle ? (
                <Sparkles aria-hidden className={cn(styles.sparkle, 'h-4 w-4 shrink-0 text-success')} />
              ) : null}
            </span>
            <span className="flex min-h-0 min-w-0 flex-1 flex-col justify-end">
              <span className={cn(styles.roomState, 'hidden truncate text-[11px] min-[420px]:block sm:text-xs', room.status === 'overdue' ? 'text-foreground' : 'text-muted-foreground')}>{summary}</span>
              {inline.length > 0 && (
                // HP-13a: a size container; only the lines that fit the room's height show
                // (dashboard.module.css), and on phones the list moves under the house.
                <span aria-hidden className={cn(styles.touchOnly, styles.roomChores, 'min-w-0')} data-testid={`house-room-chores-${room.id}`}>
                  {inline.map((chore) => (
                    <span key={chore.id} className={cn('truncate', chore.overdue ? 'text-warning' : 'text-muted-foreground')}>{chore.task}</span>
                  ))}
                </span>
              )}
            </span>
          </span>
        </Link>
      </PeekCard>
    </li>
  );
}

/**
 * HP-13a on phones: the room overlays are too short for chore lines (a 3-column room is
 * about 70 px tall at 390 px), so on coarse pointers below 640 px the titles are listed
 * here, under the house, two per room. Hidden from assistive tech: each room link's
 * name already carries the titles (HP-28b).
 */
function RoomDetails({ rooms }: { rooms: RoomState[] }) {
  const rows = roomDetailRows(rooms);
  if (rows.length === 0) return null;
  return (
    <ul aria-hidden className={cn(styles.touchOnly, styles.roomDetails, 'mt-2 grid grid-cols-2 gap-x-3 gap-y-2 px-1 text-sm')} data-testid="house-room-details">
      {rows.map((row) => (
        <li key={row.id} className="min-w-0" data-testid={`house-room-details-${row.id}`}>
          <span className="block truncate font-medium text-foreground">{row.name}</span>
          {row.chores.map((chore) => (
            <span key={chore.id} className={cn('block truncate', chore.overdue ? 'text-warning' : 'text-muted-foreground')}>{chore.task}</span>
          ))}
        </li>
      ))}
    </ul>
  );
}

function PetChip({ pet, describedBy, onSound }: { pet: PetState; describedBy: string; onSound: (pet: PetState) => void }) {
  const pressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const endPress = () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  useEffect(() => endPress, []);

  return (
    <Link
      href={petFeedingHref(pet.id)}
      aria-label={`${pet.name}: ${petStatus(pet)}`}
      aria-describedby={describedBy}
      aria-keyshortcuts="Space"
      data-testid={`house-pet-${pet.id}`}
      data-fed={pet.fed === null ? 'unknown' : String(pet.fed)}
      data-feeding-stale={pet.feedingHint ? 'true' : undefined}
      title={pet.feedingHint ? `${pet.name}: ${pet.feedingHint}` : undefined}
      className={cn(styles.target, 'relative flex shrink-0 select-none flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-0.5 text-[11px] [-webkit-touch-callout:none]')}
      onPointerDown={() => {
        longPressed.current = false;
        endPress();
        pressTimer.current = window.setTimeout(() => {
          longPressed.current = true;
          onSound(pet);
        }, LONG_PRESS_MS);
      }}
      onPointerUp={endPress}
      onPointerLeave={endPress}
      onPointerCancel={endPress}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        // Keyboard equivalent of the long-press: Space (a link does nothing on Space).
        if (event.key === ' ' && !isComposingKey(event)) {
          event.preventDefault();
          onSound(pet);
        }
      }}
      onClick={(event) => {
        if (longPressed.current) {
          event.preventDefault();
          longPressed.current = false;
        }
      }}
    >
      <span className="flex items-end gap-0.5">
        <span className={cn('flex h-8 w-8 items-center justify-center rounded-full border bg-card text-foreground', pet.fed === false && 'border-warning', pet.feedingHint && 'border-dashed opacity-70')}>
          <PetIcon type={pet.type} aria-hidden className="h-4 w-4" />
        </span>
        {pet.fed === false && (
          <svg aria-hidden viewBox="0 0 20 10" className="mb-0.5 h-2.5 w-5 text-warning">
            <path d="M1 2h18l-2.5 7h-13z" fill="currentColor" />
          </svg>
        )}
      </span>
      <span className={cn(styles.yardLabel, styles.petName, 'max-w-[4.5rem] truncate', pet.fed === false ? 'font-medium text-warning' : 'text-muted-foreground')}>{pet.name}</span>
    </Link>
  );
}

function YardObject({ href, label, children, testId }: { href: string; label: string; children: ReactNode; testId: string }) {
  return (
    <Link href={href} aria-label={label} data-testid={testId} className={cn(styles.target, 'relative flex shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-0.5 text-[11px] text-muted-foreground')}>
      {children}
    </Link>
  );
}

const WrenchBadge = () => (
  <span aria-hidden className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-warning text-warning-foreground">
    <Wrench className="h-2.5 w-2.5" />
  </span>
);

/** Small meter for Maintenance's home health score (H10), linked to its overview. */
function HealthBadge({ health }: { health: HealthResult }) {
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  return (
    <Link
      href={MAINTENANCE_OVERVIEW_HREF}
      aria-label={healthSummaryText('Home health', health)}
      data-testid="house-health"
      data-score={health.score}
      // D-2: a small pill with a 44 px (48 px on touch) hit area.
      className={cn(styles.hitSlop, styles.healthText, 'flex shrink-0 items-center gap-1.5 rounded-full border bg-card/80 px-2 py-0.5 text-xs font-medium hover:border-primary/40')}
    >
      <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4 -rotate-90">
        <circle cx="10" cy="10" r={radius} fill="none" strokeWidth="3" className="stroke-muted" />
        <circle
          cx="10"
          cy="10"
          r={radius}
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          className={health.band === 'good' ? 'stroke-success' : health.band === 'fair' ? 'stroke-warning' : 'stroke-destructive'}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - health.score / 100)}
        />
      </svg>
      <span className="tabular-nums">{health.score}</span>
      <span className="hidden text-muted-foreground sm:inline">health</span>
    </Link>
  );
}

/* ------------------------------------------------------------------------- */
/* The house                                                                  */
/* ------------------------------------------------------------------------- */

/** The two-pane layout (HP-12); the same query as `.page` in dashboard.module.css. */
const WIDE_LAYOUT_QUERY = '(min-width: 1024px) and (orientation: landscape)';

/**
 * The size of the stage's pane on the wide layout, or null elsewhere. There the pane is a
 * size container whose size comes from the page (the house column's height), never from
 * the scene, so growing the rooms to fill it cannot feed back into it. Stacked layouts
 * keep the default room height (the stage there is sized by its width).
 */
function useWideStageBox(ref: RefObject<HTMLDivElement | null>) {
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(WIDE_LAYOUT_QUERY);
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const next = query.matches && rect.width > 0 && rect.height > 0 ? { width: Math.round(rect.width), height: Math.round(rect.height) } : null;
      setBox((current) => (current?.width === next?.width && current?.height === next?.height ? current : next));
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    query.addEventListener?.('change', measure);
    return () => {
      observer?.disconnect();
      query.removeEventListener?.('change', measure);
    };
  }, [ref]);
  return box;
}

export function LivingHouse({
  facts,
  title,
  golden = false,
  now,
  rooms: roomsSection,
  outline = null,
  timeZone,
  onRetry,
}: {
  facts: DashboardFacts;
  title: string;
  golden?: boolean;
  now: Date;
  /** The chores section's state (GOAL-states): stale shows a hint, unauthorized and failed say so. */
  rooms?: SectionState;
  /** HP-7b: an earlier day's room layout (names only) to draw while the chores load. */
  outline?: HouseOutlineRoom[] | null;
  timeZone?: string;
  onRetry?: () => void;
}) {
  const reduced = useReducedMotion();
  const light = useDayLight();
  const weather = useLiveWeather();
  const { navigate } = useMorphNavigation();
  // The dashboard renders only after sign-in on the client, so reading storage here is safe.
  const [seasonalOn, setSeasonalOn] = useState(() => (typeof window === 'undefined' ? true : readSeasonalPref()));
  const [discoRequested, setDisco] = useState(false);
  const [activeRoom, setActiveRoom] = useState<string | null>(null);
  const [zoom, setZoom] = useState<{ id: string; x: number; y: number } | null>(null);
  const [hoppingPet, setHoppingPet] = useState<string | null>(null);
  const weatherSettings = useWeatherSettings();
  const zoomTimer = useRef<number | null>(null);
  const discoTimer = useRef<number | null>(null);
  const roofTaps = useRef<number[]>([]);
  const roomsRef = useRef<HTMLUListElement>(null);
  const stageBoxRef = useRef<HTMLDivElement>(null);
  const stageBox = useWideStageBox(stageBoxRef);
  const disco = discoRequested && !reduced;
  const season = seasonFor(now);

  // 10 s of disco, from the Konami code or five roof taps (HP-19b). Never under reduced motion.
  const startDisco = useCallback(() => {
    setDisco(true);
    if (discoTimer.current !== null) window.clearTimeout(discoTimer.current);
    discoTimer.current = window.setTimeout(() => {
      discoTimer.current = null;
      setDisco(false);
    }, DISCO_MS);
  }, []);
  useEffect(() => () => {
    if (discoTimer.current !== null) window.clearTimeout(discoTimer.current);
  }, []);

  // Konami code, never while typing.
  useEffect(() => {
    if (reduced) return;
    let progress = 0;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (isComposingKey(event) || isTypingTarget(event.target)) return;
      const step = konamiStep(progress, event.key);
      progress = step.progress;
      if (step.done) {
        // Captured first, so the final "a" does not also open quick add.
        event.preventDefault();
        startDisco();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [reduced, startDisco]);

  useEffect(() => () => {
    if (zoomTimer.current !== null) window.clearTimeout(zoomTimer.current);
  }, []);

  // HP-11c: a page restored from the back/forward cache never keeps a stuck zoom.
  useEffect(() => {
    const reset = () => {
      if (zoomTimer.current !== null) window.clearTimeout(zoomTimer.current);
      zoomTimer.current = null;
      setZoom(null);
    };
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);

  const toggleSeasonal = () => {
    const next = !seasonalOn;
    setSeasonalOn(next);
    try {
      window.localStorage.setItem(SEASONAL_KEY, next ? 'on' : 'off');
    } catch {
      // Storage unavailable: the switch still works for this visit.
    }
  };

  // HP-7: the chores are still loading (the member can view them and nothing failed).
  const choresLoading = !facts.chores && roomsSection !== undefined && !facts.unavailable?.includes('chores');
  const outlineKey = choresLoading && outline ? JSON.stringify(outline) : '';
  const outlineRooms = useMemo(
    () => (outlineKey ? (JSON.parse(outlineKey) as HouseOutlineRoom[]).map((room) => placeholderRoom(room.id, room.name)) : []),
    [outlineKey],
  );
  const rooms = useMemo(() => facts.chores?.rooms ?? outlineRooms, [facts.chores, outlineRooms]);
  // With more rooms than fit, rooms that need attention (overdue, then due today,
  // including the "Unknown Room" bucket) are shown first; display keeps name order.
  const shownRooms = useMemo(() => {
    const rank = (room: RoomState) => (room.status === 'overdue' ? 0 : room.status === 'due' ? 1 : 2);
    const visibleIds = new Set([...rooms].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_HOUSE_ROOMS).map((room) => room.id));
    return rooms.filter((room) => visibleIds.has(room.id));
  }, [rooms]);
  const hiddenRooms = facts.chores ? rooms.length - shownRooms.length : 0;
  // Loading with no earlier layout: the same four-room outline as the skeleton, no links.
  const drawnRooms = useMemo(
    () => (choresLoading && shownRooms.length === 0 ? OUTLINE_IDS.map((id) => placeholderRoom(id, '')) : shownRooms),
    [choresLoading, shownRooms],
  );
  // Wall tablet (HP-12e): on the wide layout the rooms grow taller, then the roof steeper,
  // to fill the house's pane; the default geometry's aspect sizes the pane's width.
  const fit = stageBox ? fitHouse(drawnRooms.length, stageBox) : null;
  const cellH = fit?.cellH;
  const roofH = fit?.roofH;
  const layout = useMemo(() => layoutHouse(drawnRooms.map((room) => room.id), { cellH, roofH }), [drawnRooms, cellH, roofH]);
  const baseAspect = useMemo(() => {
    const base = layoutHouse(drawnRooms.map((room) => room.id));
    return base.width / base.height;
  }, [drawnRooms]);
  const pets = useMemo(() => facts.pets?.pets ?? [], [facts.pets]);
  const petPlacements = useMemo(
    () => placePets(pets, layout, Object.fromEntries(shownRooms.map((room) => [room.id, room.name]))),
    [pets, layout, shownRooms],
  );
  const maintenance = facts.maintenance;
  const pantry = facts.pantry;
  const activeSeason = seasonalOn ? season : null;
  // HP-9: the label, the fill and the pulse all count the whole pantry.
  const fullness = pantry ? Math.min(1, pantry.total / 10) : 0;
  const climateItem = maintenance?.items.find((item) => item.climate && (item.overdue || item.dueSoon));
  const vehicleItem = maintenance?.items.find((item) => item.kind === 'vehicle' && (item.overdue || item.dueSoon));
  const lit = Boolean(light?.lit);

  const summary = [
    choresLoading ? 'Rooms are loading.' : null,
    facts.chores ? (rooms.some((room) => room.status === 'overdue')
      ? `Rooms with overdue chores: ${rooms.filter((room) => room.status === 'overdue').map((room) => room.name).join(', ')}.`
      : 'No room has overdue chores.') : null,
    facts.pets && pets.length > 0 ? `${facts.pets.hungry} of ${pets.length} pets waiting to be fed.${facts.pets.unknown ? ` Feeding status unavailable for ${facts.pets.unknown}.` : ''}` : null,
    facts.unavailable?.length ? `Unavailable right now: ${facts.unavailable.join(', ')}.` : null,
    maintenance ? (maintenance.overdue + maintenance.dueSoon > 0 ? `${maintenance.overdue + maintenance.dueSoon} maintenance items due soon.` : 'Maintenance is up to date.') : null,
    facts.health ? healthSummaryText('Home health', facts.health) : null,
  ].filter(Boolean).join(' ');

  const onRoomNavigate = (event: MouseEvent<HTMLAnchorElement>, room: RoomState, placement: RoomPlacement, href: string) => {
    // Plain navigation under reduced motion and for modified clicks (new tab, etc.).
    if (reduced || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (zoom) return;
    setZoom({ id: room.id, x: placement.center.x, y: placement.center.y });
    const reset = () => {
      zoomTimer.current = null;
      setZoom(null);
    };
    zoomTimer.current = window.setTimeout(() => {
      try {
        navigate(href);
      } catch {
        reset();
        return;
      }
      // HP-11c: a navigation that never lands (a failed chunk after a deploy) unzooms.
      zoomTimer.current = window.setTimeout(reset, ZOOM_RESET_MS);
    }, ZOOM_MS);
  };

  const onRoomsKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (!NAV_KEYS.has(event.key) || isComposingKey(event)) return;
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-room-id]')?.dataset.roomId;
    if (!id) return;
    event.preventDefault();
    const next = roomNeighbor(layout, id, event.key as NavKey);
    if (next) roomsRef.current?.querySelector<HTMLElement>(`[data-room-id="${CSS.escape(next)}"]`)?.focus();
  };

  // HP-19b: five taps (or clicks) on the roof within two seconds start the disco. The
  // roof is drawn in the decorative SVG, so the tap is located on the stage.
  const onStageClick = (event: MouseEvent<HTMLDivElement>) => {
    if (reduced || zoom) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const point = {
      x: ((event.clientX - rect.left) / rect.width) * layout.width,
      y: ((event.clientY - rect.top) / rect.height) * layout.height,
    };
    if (!onRoof(point, layout)) return;
    const step = registerTap(roofTaps.current, event.timeStamp);
    roofTaps.current = step.taps;
    if (step.done) startDisco();
  };

  const onPetSound = (pet: PetState) => {
    playPetSound(pet.type);
    if (!reduced) setHoppingPet(pet.id);
  };

  const roomsState = facts.chores
    ? (shownRooms.length > 0 ? 'rooms' : 'empty')
    : facts.unavailable?.includes('chores') ? (roomsSection?.status === 'unauthorized' ? 'unauthorized' : 'unavailable')
      : choresLoading ? (shownRooms.length > 0 ? 'rooms' : 'loading') : 'none';
  const roomsHint = facts.chores ? staleHint(roomsSection, timeZone) : null;
  const bodyBox = {
    left: `${(layout.body.x / layout.width) * 100}%`,
    top: `${(layout.body.y / layout.height) * 100}%`,
    width: `${(layout.body.w / layout.width) * 100}%`,
    height: `${(layout.body.h / layout.height) * 100}%`,
  };

  return (
    <section aria-labelledby="living-house-title" className={cn(styles.houseSection, styles.houseFill, 'mb-6')} data-testid="living-house">
      <div
        className={cn(styles.house, styles.houseCard, 'overflow-hidden rounded-2xl border bg-card/80 shadow-raised', disco && styles.disco)}
        style={light?.style}
        data-disco={disco ? 'true' : undefined}
      >
        <div aria-hidden className={styles.sky} />
        {!reduced && weather?.effect && <WeatherLayer effect={weather.effect} scope="house" />}
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-4 pt-3">
          <div className="flex min-w-0 items-center gap-2">
            {/* HP-20a: the household name is shown once, on the subtitle line; here it names the section. */}
            <h2 id="living-house-title" className="sr-only">{title}</h2>
            {facts.health && <HealthBadge health={facts.health} />}
            {roomsHint && <span className="shrink-0 text-xs text-muted-foreground" data-testid="house-rooms-stale">{roomsHint}</span>}
          </div>
          {/* HP-18a: the display settings live in a "..." menu, out of the hero. */}
          <HouseMenu weather={weatherSettings} seasonal={season ? { on: seasonalOn, toggle: toggleSeasonal } : undefined} />
        </div>
        <WeatherCityForm settings={weatherSettings} />
        <p className="sr-only">{summary}</p>
        <p id="house-pet-sound-hint" className="sr-only">Long-press a pet, or press Space on it, to hear it when Sound is on in Profile, Appearance.</p>

        <div className={cn(styles.stageWrap, 'px-3 pt-1 sm:px-6')}>
          {/* HP-12e: on wide landscape screens a size container filling the card's free
              height; the stage fits inside it (dashboard.module.css `.stageBox`). */}
          <div ref={stageBoxRef} className={styles.stageBox} style={{ '--house-aspect-base': baseAspect } as CSSProperties} data-testid="house-stage-box">
            <div
              className={cn(styles.stage, styles.stageFrame, styles.stageFit, 'relative', zoom && styles.zooming)}
              // HP-12a: on wide landscape screens the stage fits its pane and its width follows
              // from this ratio (dashboard.module.css `.stageFit`).
              style={{ aspectRatio: `${layout.width} / ${layout.height}`, '--house-aspect': layout.width / layout.height, ...(zoom ? { transformOrigin: `${zoom.x}% ${zoom.y}%` } : null) } as CSSProperties}
              data-zoom={zoom?.id}
              onClick={onStageClick}
            >
              <svg aria-hidden viewBox={`0 0 ${layout.width} ${layout.height}`} className="absolute inset-0 h-full w-full overflow-visible">
                <Scenery layout={layout} season={activeSeason} golden={golden} lit={lit} />
                {layout.rooms.map((placement) => {
                  const room = drawnRooms[placement.index];
                  return <RoomShape key={room.id} placement={placement} room={room} lit={lit} active={activeRoom === room.id} />;
                })}
                {petPlacements.map((placement) => (placement.mode === 'bowl' && placement.bowl ? (
                  <path key={`bowl-${placement.id}`} d={`M${placement.bowl.x - 8} ${placement.bowl.y - 5}h16l-3 6h-10z`} className="fill-warning" />
                ) : null))}
                {petPlacements.map((placement, index) => (
                  <PetFigure
                    // HP-16a: the walk runs three times, and again after the next feeding.
                    key={attentionKey(placement.id, placement.mode, pets[index].countLabel)}
                    pet={pets[index]}
                    placement={reduced && placement.mode === 'wander' ? { ...placement, mode: 'idle' } : placement}
                    hopping={hoppingPet === placement.id && !reduced}
                    onHopEnd={() => setHoppingPet(null)}
                  />
                ))}
              </svg>

              {roomsState === 'rooms' ? (
                <ul ref={roomsRef} aria-label="Rooms" className="absolute inset-0" onKeyDown={onRoomsKeyDown}>
                  {layout.rooms.map((placement) => {
                    const room = shownRooms[placement.index];
                    return (
                      <RoomLink
                        key={room.id}
                        room={room}
                        placement={placement}
                        sparkle={room.status === 'clear' && room.doneToday > 0}
                        morphing={zoom?.id === room.id}
                        loading={!facts.chores}
                        onActive={setActiveRoom}
                        onNavigate={onRoomNavigate}
                      />
                    );
                  })}
                </ul>
              ) : (
                <div className="absolute flex items-center justify-center px-3 text-center" style={bodyBox}>
                  {roomsState === 'empty' ? (
                    <p className="rounded-md bg-card/90 px-2 py-1 text-sm text-muted-foreground">
                      Add rooms to your chores and they will appear here.{' '}
                      <Link href="/chores" className="font-medium text-primary underline-offset-4 hover:underline">Open Chores</Link>
                    </p>
                  ) : roomsState === 'unavailable' ? (
                    <p className="rounded-md bg-card/90 px-2 py-1 text-sm text-muted-foreground" data-testid="house-rooms-unavailable">
                      Rooms are unavailable right now.{' '}
                      {onRetry && (
                        <button type="button" onClick={onRetry} data-testid="house-rooms-retry" className={cn(styles.hitSlop, 'font-medium text-primary underline-offset-4 hover:underline')}>Retry</button>
                      )}{onRetry ? ' · ' : null}
                      <Link href="/chores" className="font-medium text-primary underline-offset-4 hover:underline">Open Chores</Link>
                    </p>
                  ) : roomsState === 'unauthorized' ? (
                    <p className="rounded-md bg-card/90 px-2 py-1 text-sm text-muted-foreground" data-testid="house-rooms-unauthorized">
                      Rooms are not shared with you.
                    </p>
                  ) : roomsState === 'loading' ? (
                    <p className="rounded-md bg-card/90 px-2 py-1 text-sm text-muted-foreground" data-testid="house-rooms-loading" aria-busy="true">{LOADING_LABEL}</p>
                  ) : (
                    <p className="rounded-md bg-card/90 px-2 py-1 text-sm text-muted-foreground">Welcome home.</p>
                  )}
                </div>
              )}
            </div>
          </div>
          {roomsState === 'rooms' && facts.chores && <RoomDetails rooms={shownRooms} />}
          {hiddenRooms > 0 && (
            // HP-28c: a real control with a D-2 hit area, not a tiny text link.
            <p className="mt-1 flex justify-center">
              <Link
                href="/chores"
                data-testid="house-more-rooms"
                className={cn(styles.hitSlop, 'inline-flex min-h-8 items-center rounded-md px-3 text-sm text-muted-foreground transition-ui hover:bg-muted hover:text-foreground')}
              >
                +{hiddenRooms} more {hiddenRooms === 1 ? 'room' : 'rooms'}
              </Link>
            </p>
          )}
        </div>

        <div className="mt-2 flex items-end gap-3 overflow-x-auto border-t border-border-subtle bg-secondary/40 px-4 pb-2 pt-3" aria-label="Yard" role="group">
          {pantry && (
            <YardObject
              href={PANTRY_HREF}
              testId="house-fridge"
              label={`Pantry: ${pantry.total} ${pantry.total === 1 ? 'item' : 'items'}${pantry.expiringSoon ? `, ${pantry.expiringSoon} expiring soon` : ''}`}
            >
              <span className="relative flex h-9 w-7 items-end overflow-hidden rounded-md border bg-card">
                <span aria-hidden className="absolute inset-x-0 bottom-0 bg-info/30" style={{ height: `${Math.round(fullness * 100)}%` }} />
                {/* HP-16a: pulses three times, and again when the expiring count changes. */}
                <Refrigerator key={attentionKey('pulse', pantry.expiringSoon)} aria-hidden className={cn('relative m-auto h-4 w-4', pantry.expiringSoon > 0 && !reduced && styles.pulse)} />
                {pantry.expiringSoon > 0 && <span aria-hidden className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-warning" />}
              </span>
              <span className={styles.yardLabel}>Pantry</span>
            </YardObject>
          )}
          {/* HP-8: only a home with a climate asset has an outdoor unit to report on. */}
          {maintenance && maintenance.climateAssets > 0 && (
            <YardObject
              href={climateItem?.href ?? MAINTENANCE_REMINDERS_HREF}
              testId="house-hvac"
              label={maintenance.climateDue ? `Heating and cooling: ${climateItem ? `${climateItem.label}, ${climateItem.statusLabel.toLowerCase()}` : 'needs attention'}` : 'Heating and cooling: no service due'}
            >
              <span className="relative flex h-9 w-9 items-center justify-center rounded-md border bg-card">
                <AirVent aria-hidden className="h-4 w-4" />
                {maintenance.climateDue && <WrenchBadge />}
              </span>
              <span className={styles.yardLabel}>HVAC</span>
            </YardObject>
          )}
          {maintenance && maintenance.vehicles > 0 && (
            <YardObject
              href={vehicleItem?.href ?? MAINTENANCE_REMINDERS_HREF}
              testId="house-car"
              label={maintenance.vehicleDue ? `Car: ${vehicleItem ? `${vehicleItem.label}, ${vehicleItem.statusLabel.toLowerCase()}` : 'needs attention'}` : 'Car: no service due'}
            >
              <span className="relative flex h-9 w-12 items-center justify-center rounded-md border bg-card">
                <Car aria-hidden className="h-5 w-5" />
                {maintenance.vehicleDue && <WrenchBadge />}
              </span>
              <span className={styles.yardLabel}>Driveway</span>
            </YardObject>
          )}
          <span className="flex-1" aria-hidden />
          {pets.map((pet) => (
            // HP-33a: a hungry pet's chip has "Fed" beside it (a sibling, never inside the link).
            <span key={pet.id} className="flex shrink-0 items-center gap-1">
              <PetChip pet={pet} describedBy="house-pet-sound-hint" onSound={onPetSound} />
              <PetFedButton pet={pet} className="text-xs" />
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
