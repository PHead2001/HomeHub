/**
 * The dashboard tile list (HP-26): one ordered descriptor list drives both the loading
 * skeleton and the real grid, so they show the same tiles in the same order and no row
 * grows after load. It is built only from what is known before any data arrives: the
 * member's permissions and their own weather opt-in. The one data-dependent exception is
 * the streaks tile, which leaves once the household's leaderboard setting is known to be
 * off (until then it is counted, so the skeleton never undercounts).
 *
 * Spans are computed per grid column count so the last row never leaves an empty slot:
 * the last tile (and any tile before a row break) stretches over the columns left.
 * Pure, so it is unit tested; the components only apply what this returns.
 */

export type TileId = 'chores' | 'shopping' | 'pets' | 'maintenance' | 'pantry' | 'notifications' | 'streaks' | 'weather';

/** Grid columns at each width (see `.tileGrid` in dashboard.module.css). */
export const TILE_COLUMNS = {
  /** Phones: one column. */
  base: 1,
  /** `sm` (640 px) and up, portrait or narrow. */
  sm: 2,
  /** `lg` (1024 px) and up in portrait. */
  lg: 4,
  /** The wide landscape layout (HP-12): two columns beside the house. */
  wide: 2,
} as const;

export type TileBreakpoint = keyof typeof TILE_COLUMNS;

type TileSpec = {
  id: TileId;
  /** Preferred span (before filling rows) at each breakpoint. */
  span: Record<TileBreakpoint, number>;
  /** Short on phones (HP-26d): its content is a line or two, so it takes no fixed height. */
  compactOnPhone: boolean;
};

const ONE = { base: 1, sm: 1, lg: 1, wide: 1 };
// Chores and shopping lead with two columns where the grid is wide enough; beside the
// house (wide layout) every tile is one column so the grid fits the screen (HP-12d).
const LEAD = { base: 1, sm: 2, lg: 2, wide: 1 };

const SPECS: Record<TileId, TileSpec> = {
  chores: { id: 'chores', span: LEAD, compactOnPhone: false },
  shopping: { id: 'shopping', span: LEAD, compactOnPhone: false },
  pets: { id: 'pets', span: ONE, compactOnPhone: true },
  maintenance: { id: 'maintenance', span: ONE, compactOnPhone: true },
  pantry: { id: 'pantry', span: ONE, compactOnPhone: false },
  notifications: { id: 'notifications', span: ONE, compactOnPhone: false },
  streaks: { id: 'streaks', span: ONE, compactOnPhone: false },
  weather: { id: 'weather', span: ONE, compactOnPhone: false },
};

export type TileAccess = {
  permissions: Partial<Record<string, boolean>>;
  /** The member turned live weather on and set a city (their profile, known before data). */
  weatherEnabled: boolean;
  /** True once the household's leaderboard is known to be off; unknown counts as shown. */
  streaksHidden?: boolean;
};

/** The tiles this member sees, in grid order. */
export function dashboardTileIds({ permissions, weatherEnabled, streaksHidden }: TileAccess): TileId[] {
  const ids: TileId[] = [];
  if (permissions['chores.view']) ids.push('chores');
  if (permissions['shopping.view']) ids.push('shopping');
  if (permissions['pets.view']) ids.push('pets');
  if (permissions['maintenance.view']) ids.push('maintenance');
  // The pantry is part of Shopping's data and permission.
  if (permissions['shopping.view']) ids.push('pantry');
  if (permissions['notifications.view']) ids.push('notifications');
  if (permissions['chores.view'] && streaksHidden !== true) ids.push('streaks');
  if (weatherEnabled) ids.push('weather');
  return ids;
}

/**
 * Final spans for one column count: tiles are placed in order; a tile that does not fit
 * the rest of a row starts the next one and the tile before it stretches over the gap,
 * and the last tile stretches over whatever its row has left.
 */
export function fillRowSpans(preferred: readonly number[], columns: number): number[] {
  const cols = Math.max(1, Math.floor(columns));
  const spans = preferred.map((span) => Math.max(1, Math.min(Math.floor(span) || 1, cols)));
  let used = 0;
  spans.forEach((span, index) => {
    if (used + span > cols) {
      spans[index - 1] += cols - used;
      used = 0;
    }
    used = (used + span) % cols;
  });
  if (used > 0 && spans.length > 0) spans[spans.length - 1] += cols - used;
  return spans;
}

export type TileDescriptor = {
  id: TileId;
  compactOnPhone: boolean;
  /** Columns spanned at each breakpoint, last row filled. */
  spans: Record<TileBreakpoint, number>;
};

/** Descriptors (order, compactness and filled spans) for a list of tile ids. */
export function layoutTiles(ids: readonly TileId[]): TileDescriptor[] {
  const breakpoints = Object.keys(TILE_COLUMNS) as TileBreakpoint[];
  const filled = Object.fromEntries(breakpoints.map((bp) => [
    bp,
    fillRowSpans(ids.map((id) => SPECS[id].span[bp]), TILE_COLUMNS[bp]),
  ])) as Record<TileBreakpoint, number[]>;
  return ids.map((id, index) => ({
    id,
    compactOnPhone: SPECS[id].compactOnPhone,
    spans: Object.fromEntries(breakpoints.map((bp) => [bp, filled[bp][index]])) as Record<TileBreakpoint, number>,
  }));
}

/** The descriptor list for a member: what both the skeleton and the grid render. */
export function dashboardTiles(access: TileAccess): TileDescriptor[] {
  return layoutTiles(dashboardTileIds(access));
}

/**
 * Before Firebase Auth restores the session no permissions are known: the server HTML
 * skeleton shows a full member's tiles without weather (the seeded and most common case).
 */
export const DEFAULT_SKELETON_TILES: readonly TileDescriptor[] = layoutTiles(
  ['chores', 'shopping', 'pets', 'maintenance', 'pantry', 'notifications', 'streaks'],
);

/** CSS custom properties read by `.tileCell` for each breakpoint's span. */
export function tileSpanStyle(tile: TileDescriptor): Record<string, number> {
  return {
    '--tile-span-sm': tile.spans.sm,
    '--tile-span-lg': tile.spans.lg,
    '--tile-span-wide': tile.spans.wide,
  };
}
