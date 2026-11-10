/**
 * Touch helpers for the dashboard (HP-13, HP-16a, HP-19b, HP-28b). Pure, so the
 * selection and counting rules are unit tested and the components only render them.
 */
import type { Point } from './house-layout';
import type { RoomState } from './facts';

/**
 * How many of a room's chores show inline on coarse pointers (HP-13a): two lines on
 * phones, three on wider screens, five beside the tiles in the wide landscape layout.
 * The CSS (`dashboard.module.css` `.roomChores`) hides the lines past each limit, so
 * the component renders `INLINE_CHORES.wide` and the screen decides how many fit.
 */
export const INLINE_CHORES = { narrow: 2, regular: 3, wide: 5 } as const;

/** Chores a room peek card lists (fine pointers): the first three. */
export const PEEK_ROOM_CHORES = 3;

type RoomChore = RoomState['chores'][number];

/**
 * The room's chores in display order (facts already sorted them overdue, today, then
 * soonest, HP-10), at most `limit`. A loading room has none.
 */
export function inlineRoomChores(room: Pick<RoomState, 'chores'>, limit: number, loading = false): RoomChore[] {
  if (loading || limit <= 0) return [];
  return room.chores.slice(0, Math.floor(limit));
}

/** "Mop floor, due 2 days ago": one inline chore line, as read aloud. */
export const choreLine = (chore: Pick<RoomChore, 'task' | 'dueLabel'>) => `${chore.task}, ${chore.dueLabel}`;

/**
 * The room link's accessible name (HP-28b): the room, its summary, then the chores the
 * widest layout can show inline, on every pointer, so a screen reader hears the
 * titles a touch screen shows and a peek card repeats.
 * "Kitchen: 1 overdue, 1 due today. Mop floor, due 2 days ago; Dishes, due today."
 */
export function roomLinkName(room: Pick<RoomState, 'name' | 'chores'>, summary: string, loading = false): string {
  const chores = inlineRoomChores(room, INLINE_CHORES.wide, loading);
  return `${room.name}: ${summary}${chores.length ? `. ${chores.map(choreLine).join('; ')}.` : ''}`;
}

/**
 * The touch easter egg (HP-19b): `count` taps within `windowMs` complete it. Returns
 * the taps still inside the window and whether this tap completed the run; a
 * completed run starts over from zero.
 */
export function registerTap(
  taps: readonly number[],
  now: number,
  { count = 5, windowMs = 2_000 }: { count?: number; windowMs?: number } = {},
): { taps: number[]; done: boolean } {
  const recent = [...taps.filter((at) => now - at < windowMs && at <= now), now];
  if (recent.length >= count) return { taps: [], done: true };
  return { taps: recent, done: false };
}

/** Ray-casting point-in-polygon test, in the polygon's own units. */
export function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Whether a point in house units lies on the roof (its front or receding side). */
export const onRoof = (point: Point, layout: { roofFront: readonly Point[]; roofSide: readonly Point[] }) =>
  pointInPolygon(point, layout.roofFront) || pointInPolygon(point, layout.roofSide);

/**
 * Attention animations (HP-16a) run a few cycles, then hold. Each animated element is
 * keyed by the state it reports, so a change remounts it and the animation runs again:
 * a new overdue chore, another feeding, more food about to expire.
 */
export const attentionKey = (...parts: Array<string | number | boolean | null | undefined>) =>
  parts.map((part) => (part === null || part === undefined ? '' : String(part))).join('|');
