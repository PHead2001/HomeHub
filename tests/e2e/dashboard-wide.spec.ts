import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { fixedNow } from './test-helpers';

/*
 * H5 wide landscape layout (HP-12, HP-26a, HP-12e): on every wide landscape screen (D-5,
 * personal accounts included) the dashboard is two panes, house left, brief and tiles
 * right, and with the seeded four-room household it fits one screen at 100% text: no page
 * scroll, the house card reaching the bottom of its column, Home Wrapped on screen. The
 * real wall tablet (WT-23..WT-27) is 1263x818 as an installed web app, 1263x722 in Chrome
 * with its URL bar and up to 1264x843 with a fullscreen launcher; the other sizes are
 * common landscape tablets and windows, down to a 1024x600 window, which may scroll. At
 * 130% text the page may scroll vertically, but nothing overflows sideways or overlaps.
 */

const baseURL = 'http://127.0.0.1:9002';
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');

/** `fits`: the seeded dashboard must fit the screen with no page scroll at 100% text. */
const WALL_SIZES = [
  { width: 1263, height: 818, fits: true },
  { width: 1263, height: 722, fits: true },
  { width: 1264, height: 843, fits: true },
  { width: 1280, height: 800, fits: true },
  { width: 1366, height: 1024, fits: true },
  { width: 1200, height: 800, fits: true },
  { width: 1180, height: 820, fits: true },
  { width: 1340, height: 800, fits: true },
  { width: 1024, height: 768, fits: true },
  { width: 1024, height: 600, fits: false },
];

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;

async function openWide(browser: Browser, { width, height }: { width: number; height: number }) {
  // Wall tablets are touch screens: emulate touch like a mounted tablet would report it.
  const context = await browser.newContext({
    baseURL,
    viewport: { width, height },
    hasTouch: true,
    storageState: 'playwright/.auth/e2e-owner.json',
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(fixedNow);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome Home', level: 1 })).toBeAttached();
  // Settled: the rooms and every tile have loaded (no skeleton left in the grid).
  await expect(page.getByTestId('living-house').getByTestId('house-room-kitchen')).toBeVisible();
  await expect(page.getByTestId('dashboard-grid')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.getByTestId('dashboard-tile-notifications')).toBeVisible();
  await expect(page.getByTestId('dashboard-tile-streaks')).toBeVisible();
  return { context, page };
}

/** Sets the text scale the way Profile, Appearance does (and the plain root font size). */
async function setTextScale(page: Page, scale: 100 | 115 | 130) {
  await page.evaluate((value) => {
    const root = document.documentElement;
    root.dataset.textScale = String(value);
    root.style.fontSize = `${value}%`;
  }, scale);
}

/** Each room's name and its lamp window (decorative SVG) as screen boxes. */
async function roomNameAndWindow(page: Page) {
  return page.getByTestId('living-house').locator('[data-room-name]').evaluateAll((names) => names.map((name) => {
    const id = name.getAttribute('data-room-name') ?? '';
    const lamp = document.querySelector(`[data-room-window="${CSS.escape(id)}"]`);
    const box = (rect: DOMRect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    return { id, name: box(name.getBoundingClientRect()), lamp: lamp ? box(lamp.getBoundingClientRect()) : null };
  }));
}

async function tileBoxes(page: Page): Promise<Box[]> {
  return page.getByTestId('dashboard-grid').locator(':scope > [data-tile]').evaluateAll((cells) => cells.map((cell) => {
    const rect = cell.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }));
}

test.describe('H5: wide landscape dashboard (HP-12, HP-26a)', () => {
  for (const viewport of WALL_SIZES) {
    test(`${viewport.width}x${viewport.height}: two panes, ${viewport.fits ? 'one screen with no scrolling' : 'nothing clipped'} at 100% text`, async ({ browser }, testInfo) => {
      desktopOnly(testInfo);
      const { context, page } = await openWide(browser, viewport);
      try {
        const house = (await page.getByTestId('living-house').boundingBox())!;
        const grid = (await page.getByTestId('dashboard-grid').boundingBox())!;
        // HP-12a/b: the house on the left, the tiles on the right, side by side.
        expect(house.x + house.width).toBeLessThanOrEqual(grid.x + 1);
        expect(grid.y).toBeLessThan(house.y + house.height);
        // HP-12c: the heading is kept for screen readers only.
        const heading = (await page.getByRole('heading', { name: 'Welcome Home', level: 1 }).boundingBox())!;
        expect(heading.width).toBeLessThanOrEqual(1);
        // The subtitle carries the household name, date and time on one line (HP-15a, HP-20b).
        const subtitle = page.getByTestId('dashboard-household-line');
        await expect(subtitle).toContainText('The Foxy Residence E2E');
        await expect(page.getByTestId('dashboard-time')).toHaveText(/\d{1,2}:\d{2}/);
        // HP-12d/HP-12e: one screen, no vertical (or horizontal) scrolling.
        const size = await page.evaluate(() => ({
          scrollHeight: document.documentElement.scrollHeight,
          scrollWidth: document.documentElement.scrollWidth,
          innerHeight: window.innerHeight,
          innerWidth: window.innerWidth,
        }));
        if (viewport.fits) expect(size.scrollHeight, 'the dashboard fits the screen height').toBeLessThanOrEqual(size.innerHeight);
        expect(size.scrollWidth).toBeLessThanOrEqual(size.innerWidth);
        // HP-12e: Home Wrapped is whole, below the grid, and (when the page fits) on screen.
        const wrapped = (await page.getByTestId('home-wrapped-open').boundingBox())!;
        expect(wrapped.x).toBeGreaterThanOrEqual(0);
        expect(wrapped.x + wrapped.width).toBeLessThanOrEqual(size.innerWidth);
        expect(wrapped.y, 'Home Wrapped sits below the tiles').toBeGreaterThanOrEqual(grid.y + grid.height - 1);
        expect(wrapped.y + wrapped.height).toBeLessThanOrEqual((viewport.fits ? size.innerHeight : size.scrollHeight) + 0.5);
        // HP-12e: the house card grows to the bottom of its column, level with the right
        // pane's last row, so neither pane leaves an empty band under it.
        expect(Math.abs(house.y + house.height - (wrapped.y + wrapped.height)), 'house and right pane end together').toBeLessThanOrEqual(8);
        if (viewport.fits) expect(size.innerHeight - (house.y + house.height), 'the house reaches the screen bottom').toBeLessThanOrEqual(24);
        // HP-12e: a room's name never runs over its lamp window.
        const rooms = await roomNameAndWindow(page);
        expect(rooms.length).toBeGreaterThanOrEqual(4);
        for (const room of rooms) {
          expect(room.lamp, `${room.id} has a lamp`).not.toBeNull();
          expect(overlaps(room.name, room.lamp!), `${room.id}: name and lamp`).toBe(false);
        }
        // HP-13b beside the house: touch shows as many inline detail rows as the height leaves
        // room for: none below 800 px (50rem), one from 800 px, two from 864 px (54rem).
        const perTile = await page.getByTestId('dashboard-grid').locator('[data-testid$="-details"]')
          .evaluateAll((lists) => lists.map((list) => ({
            shown: Array.from(list.children).filter((row) => row.getBoundingClientRect().height > 0).length,
            total: list.children.length,
          })));
        expect(perTile.length, 'the seed gives some tiles inline details').toBeGreaterThanOrEqual(2);
        const allowed = viewport.height >= 864 ? 2 : viewport.height >= 800 ? 1 : 0;
        for (const tile of perTile) expect(tile.shown).toBe(Math.min(allowed, tile.total));
        // HP-26a: the last tile reaches the grid's right edge (no empty slot), and tiles never overlap.
        const tiles = await tileBoxes(page);
        expect(tiles.length).toBeGreaterThanOrEqual(6);
        const last = tiles[tiles.length - 1];
        expect(Math.abs(last.x + last.width - (grid.x + grid.width))).toBeLessThanOrEqual(1);
        for (let i = 0; i < tiles.length; i += 1) {
          for (let j = i + 1; j < tiles.length; j += 1) expect(overlaps(tiles[i], tiles[j]), `tiles ${i} and ${j}`).toBe(false);
        }
        // Nothing inside a tile is clipped by it.
        const clipped = await page.getByTestId('dashboard-grid').locator(':scope > [data-tile]').evaluateAll((cells) => cells
          .filter((cell) => cell.scrollHeight > cell.clientHeight + 1 || cell.scrollWidth > cell.clientWidth + 1)
          .map((cell) => cell.getAttribute('data-tile')));
        expect(clipped).toEqual([]);
      } finally {
        await context.close();
      }
    });

    test(`${viewport.width}x${viewport.height}: at 130% text it may scroll, but never sideways or with overlaps`, async ({ browser }, testInfo) => {
      desktopOnly(testInfo);
      const { context, page } = await openWide(browser, viewport);
      try {
        await setTextScale(page, 130);
        const size = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
        expect(size.scrollWidth, 'no horizontal overflow at 130% text').toBeLessThanOrEqual(size.innerWidth);
        const house = (await page.getByTestId('living-house').boundingBox())!;
        const grid = (await page.getByTestId('dashboard-grid').boundingBox())!;
        expect(overlaps(house, grid)).toBe(false);
        // HP-20c: the subtitle stays in the left pane; its fields wrap rather than overflow.
        const brief = (await page.getByTestId('morning-brief-block').boundingBox())!;
        const fields = await page.getByTestId('dashboard-household-line').locator(':scope > span').evaluateAll((spans) => spans.map((span) => span.getBoundingClientRect().right));
        for (const right of fields) expect(right, 'subtitle field ends before the brief').toBeLessThanOrEqual(Math.min(brief.x, grid.x) + 1);
        const tiles = await tileBoxes(page);
        for (let i = 0; i < tiles.length; i += 1) {
          for (let j = i + 1; j < tiles.length; j += 1) expect(overlaps(tiles[i], tiles[j]), `tiles ${i} and ${j}`).toBe(false);
        }
        // Nothing inside a tile is clipped by it: every tile's content fits its box.
        const clipped = await page.getByTestId('dashboard-grid').locator(':scope > [data-tile]').evaluateAll((cells) => cells
          .filter((cell) => cell.scrollHeight > cell.clientHeight + 1 || cell.scrollWidth > cell.clientWidth + 1)
          .map((cell) => cell.getAttribute('data-tile')));
        expect(clipped).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  test('portrait keeps the stacked order: subtitle, house, brief, tiles', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const { context, page } = await openWide(browser, { width: 1024, height: 1366 });
    try {
      const house = (await page.getByTestId('living-house').boundingBox())!;
      const brief = (await page.getByTestId('morning-brief-block').boundingBox())!;
      const grid = (await page.getByTestId('dashboard-grid').boundingBox())!;
      expect(brief.y).toBeGreaterThanOrEqual(house.y + house.height - 1);
      expect(grid.y).toBeGreaterThanOrEqual(brief.y + brief.height - 1);
      // The heading is visible again outside the wide layout.
      const heading = (await page.getByRole('heading', { name: 'Welcome Home', level: 1 }).boundingBox())!;
      expect(heading.width).toBeGreaterThan(1);
    } finally {
      await context.close();
    }
  });
});
