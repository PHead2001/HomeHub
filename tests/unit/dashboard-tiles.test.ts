import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_SKELETON_TILES,
  TILE_COLUMNS,
  dashboardTileIds,
  dashboardTiles,
  fillRowSpans,
  layoutTiles,
  tileSpanStyle,
  type TileBreakpoint,
} from '../../src/lib/dashboard/tiles';

const ALL = {
  'chores.view': true,
  'shopping.view': true,
  'pets.view': true,
  'maintenance.view': true,
  'notifications.view': true,
};

/** Every row is full: the spans of each row add up to the column count. */
function rowsAreFull(spans: readonly number[], columns: number): boolean {
  let used = 0;
  for (const span of spans) {
    if (span < 1 || span > columns) return false;
    if (used + span > columns) return false;
    used = (used + span) % columns;
  }
  return used === 0;
}

describe('dashboard tile descriptors (HP-26)', () => {
  it('lists every tile a full member can view, in grid order', () => {
    assert.deepEqual(
      dashboardTileIds({ permissions: ALL, weatherEnabled: true }),
      ['chores', 'shopping', 'pets', 'maintenance', 'pantry', 'notifications', 'streaks', 'weather'],
    );
  });

  it('leaves out tiles the member cannot view, keeping the order of the rest', () => {
    assert.deepEqual(
      dashboardTileIds({ permissions: { 'pets.view': true, 'notifications.view': true, 'chores.view': false }, weatherEnabled: false }),
      ['pets', 'notifications'],
    );
    // The pantry comes with Shopping's permission.
    assert.deepEqual(dashboardTileIds({ permissions: { 'shopping.view': true }, weatherEnabled: false }), ['shopping', 'pantry']);
    assert.deepEqual(dashboardTileIds({ permissions: {}, weatherEnabled: false }), []);
  });

  it('counts the streaks tile until the leaderboard is known to be off', () => {
    assert.ok(dashboardTileIds({ permissions: ALL, weatherEnabled: false }).includes('streaks'));
    assert.ok(dashboardTileIds({ permissions: ALL, weatherEnabled: false, streaksHidden: false }).includes('streaks'));
    assert.ok(!dashboardTileIds({ permissions: ALL, weatherEnabled: false, streaksHidden: true }).includes('streaks'));
  });

  it('includes weather only when the member opted in', () => {
    assert.ok(!dashboardTileIds({ permissions: ALL, weatherEnabled: false }).includes('weather'));
    assert.deepEqual(dashboardTileIds({ permissions: {}, weatherEnabled: true }), ['weather']);
  });

  it('gives the skeleton the same count and order as the grid for the same permissions', () => {
    const before = dashboardTiles({ permissions: ALL, weatherEnabled: false });
    const after = dashboardTiles({ permissions: ALL, weatherEnabled: false, streaksHidden: false });
    assert.deepEqual(before, after);
    assert.deepEqual(DEFAULT_SKELETON_TILES, before);
    assert.equal(DEFAULT_SKELETON_TILES.length, 7);
  });

  it('marks pets and next maintenance compact on phones (HP-26d)', () => {
    const compact = dashboardTiles({ permissions: ALL, weatherEnabled: true }).filter((tile) => tile.compactOnPhone).map((tile) => tile.id);
    assert.deepEqual(compact, ['pets', 'maintenance']);
  });
});

describe('tile spans fill the last row (HP-26a)', () => {
  it('stretches the last tile over the columns its row has left', () => {
    assert.deepEqual(fillRowSpans([1, 1, 1], 2), [1, 1, 2]);
    assert.deepEqual(fillRowSpans([2, 2, 1, 1, 1, 1, 1], 4), [2, 2, 1, 1, 1, 1, 4]);
    assert.deepEqual(fillRowSpans([1, 1, 1, 1, 1], 4), [1, 1, 1, 1, 4]);
    assert.deepEqual(fillRowSpans([1, 1, 1, 1], 2), [1, 1, 1, 1]);
  });

  it('stretches the tile before a row break instead of leaving a gap mid-grid', () => {
    // A two-column tile cannot follow one tile on a two-column row: the first one widens.
    assert.deepEqual(fillRowSpans([1, 2, 1], 2), [2, 2, 2]);
    assert.deepEqual(fillRowSpans([1, 1, 1, 2], 4), [1, 1, 2, 4]);
  });

  it('clamps spans to the column count and handles one column and no tiles', () => {
    assert.deepEqual(fillRowSpans([2, 2, 1], 1), [1, 1, 1]);
    assert.deepEqual(fillRowSpans([5], 4), [4]);
    assert.deepEqual(fillRowSpans([], 4), []);
  });

  it('fills every row at every breakpoint for every permission combination', () => {
    const keys = Object.keys(ALL);
    for (let mask = 0; mask < 1 << keys.length; mask += 1) {
      const permissions = Object.fromEntries(keys.map((key, index) => [key, Boolean(mask & (1 << index))]));
      for (const weatherEnabled of [false, true]) {
        for (const streaksHidden of [undefined, true]) {
          const tiles = dashboardTiles({ permissions, weatherEnabled, streaksHidden });
          for (const bp of Object.keys(TILE_COLUMNS) as TileBreakpoint[]) {
            const spans = tiles.map((tile) => tile.spans[bp]);
            assert.ok(tiles.length === 0 || rowsAreFull(spans, TILE_COLUMNS[bp]), `${bp} ${JSON.stringify(permissions)} ${weatherEnabled} → ${spans}`);
          }
        }
      }
    }
  });

  it('lays a full member out as chores and shopping leading, beside the house one column each', () => {
    const tiles = dashboardTiles({ permissions: ALL, weatherEnabled: true });
    const by = (bp: TileBreakpoint) => tiles.map((tile) => tile.spans[bp]);
    assert.deepEqual(by('base'), [1, 1, 1, 1, 1, 1, 1, 1]);
    assert.deepEqual(by('sm'), [2, 2, 1, 1, 1, 1, 1, 1]);
    assert.deepEqual(by('lg'), [2, 2, 1, 1, 1, 1, 1, 3]);
    // Wide landscape (HP-12b): a 2 x 4 stack beside the house.
    assert.deepEqual(by('wide'), [1, 1, 1, 1, 1, 1, 1, 1]);
    // Seven tiles (no weather): the last one takes the whole last row.
    const seven = layoutTiles(['chores', 'shopping', 'pets', 'maintenance', 'pantry', 'notifications', 'streaks']);
    assert.deepEqual(seven.map((tile) => tile.spans.wide), [1, 1, 1, 1, 1, 1, 2]);
    assert.deepEqual(seven.map((tile) => tile.spans.lg), [2, 2, 1, 1, 1, 1, 4]);
  });

  it('exposes the spans as the CSS variables the grid cells read', () => {
    const [chores] = dashboardTiles({ permissions: ALL, weatherEnabled: false });
    assert.deepEqual(tileSpanStyle(chores), { '--tile-span-sm': 2, '--tile-span-lg': 2, '--tile-span-wide': 1 });
  });
});
