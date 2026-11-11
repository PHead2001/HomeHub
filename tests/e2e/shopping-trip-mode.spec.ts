import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';
import { watchReactConsole } from './react-console-guard';

// S8b trip mode on an open list (SH-12, SH-14, SH-18, SH-19b, SH-27c, SH-33):
// a compact sticky header with "n left", the page header, tabs and the tab bar's
// floating "+" out of the way, one actions menu, sticky aisle headings and aisle
// chips, "type to find or add", the Undo above the quick-add dock, a screen wake
// lock on phones, and two or three aisle columns on the wall tablet.
// Phone cases run in the mobile project (390 × 844, touch), the tablet case in the
// desktop project (1263 × 818, touch). Each project has its own list.
const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const adminApp = getApps().find((app) => app.name === 'shopping-trip-mode-e2e')
  || initializeApp({ projectId }, 'shopping-trip-mode-e2e');
const firestore = getFirestore(adminApp);
const lists = firestore.collection('households').doc(householdId).collection('shopping-lists');

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 1263, height: 818 };
const phoneOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'mobile-chromium', 'phone cases run in the mobile project');
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium', 'tablet and desktop cases run in the desktop project');

const listIdFor = (testInfo: TestInfo) => `e2e-trip-mode-${testInfo.project.name}`;
const LIST_NAME = 'E2E Trip';

// Five aisles, enough rows that the list scrolls on a phone.
const SEED: Array<{ id: string; name: string; category: string }> = [
  ...['apples', 'bananas', 'carrots', 'lettuce'].map((name) => ({ id: `tm-${name}`, name: `E2E tm ${name}`, category: 'Produce' })),
  ...['bread', 'bagels', 'muffins'].map((name) => ({ id: `tm-${name}`, name: `E2E tm ${name}`, category: 'Bakery' })),
  ...['milk', 'oat milk', 'cheese', 'yogurt'].map((name) => ({ id: `tm-${name.replace(' ', '-')}`, name: `E2E tm ${name}`, category: 'Dairy' })),
  ...['chips', 'crackers', 'nuts'].map((name) => ({ id: `tm-${name}`, name: `E2E tm ${name}`, category: 'Snacks' })),
  ...['soap', 'sponges', 'foil'].map((name) => ({ id: `tm-${name}`, name: `E2E tm ${name}`, category: 'Household' })),
];

async function seed(testInfo: TestInfo) {
  const listRef = lists.doc(listIdFor(testInfo));
  await firestore.recursiveDelete(listRef);
  await listRef.set({ name: LIST_NAME, description: '', icon: 'ShoppingCart', type: 'Grocery', color: 'tint-2' });
  await listRef.collection('config').doc('categories').set({ list: ['Produce', 'Bakery', 'Dairy', 'Snacks', 'Household', 'Other'] });
  for (const item of SEED) {
    await listRef.collection('items').doc(item.id).set({ name: item.name, quantity: 1, category: item.category, status: 'needed', createdAt: fixedNow });
  }
  return listRef;
}

/**
 * A stub Screen Wake Lock: counts requests and the locks still held, and can hide
 * and show the page (hiding drops every held lock, as the browser does). Counts,
 * not an exact call log: React's development Strict Mode mounts effects twice.
 */
const WAKE_LOCK_STUB = () => {
  const held = new Set<{ released: boolean; release: () => Promise<void> }>();
  const stats = { requests: 0 };
  let hidden = false;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      request: async () => {
        if (hidden) throw new DOMException('The page is not visible', 'NotAllowedError');
        stats.requests += 1;
        let released = false;
        const listeners: Array<() => void> = [];
        const sentinel = {
          get released() { return released; },
          release: async () => {
            if (released) return;
            released = true;
            held.delete(sentinel);
            listeners.forEach((fn) => fn());
          },
          addEventListener: (_type: string, fn: () => void) => listeners.push(fn),
        };
        held.add(sentinel);
        return sentinel;
      },
    },
  });
  Object.assign(window, {
    __wake: () => ({ requests: stats.requests, held: held.size }),
    __setHidden: (next: boolean) => {
      hidden = next;
      if (next) [...held].forEach((sentinel) => void sentinel.release());
      document.dispatchEvent(new Event('visibilitychange'));
    },
  });
};

// Every page this spec opens is watched for React key and hydration errors
// (siblings sharing a key, hydration mismatches); each test fails on any.
let consoleGuards: Array<ReturnType<typeof watchReactConsole>> = [];

async function session(browser: Browser, viewport: { width: number; height: number }, { mobile = false } = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: 'http://127.0.0.1:9002',
    colorScheme: 'dark',
    storageState: 'playwright/.auth/e2e-owner.json',
    viewport,
    hasTouch: true,
    ...(mobile ? { isMobile: true } : {}),
  });
  await context.addInitScript(WAKE_LOCK_STUB);
  const page = await context.newPage();
  consoleGuards.push(watchReactConsole(page));
  return { context, page };
}

async function openList(page: Page, testInfo: TestInfo) {
  await page.goto(`/shopping?list=${listIdFor(testInfo)}`);
  const list = page.getByTestId('open-list');
  await expect(list.getByRole('heading', { name: LIST_NAME, level: 2 })).toBeVisible();
  await expect(list.locator('#item-needed-tm-apples')).toBeAttached();
  return list;
}

/** Whether the centre of `selector`'s first match hit-tests to that element (nothing covers it). */
const uncovered = (page: Page, selector: string) => page.evaluate((target) => {
  const element = document.querySelector(target);
  if (!element) return false;
  const box = element.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return Boolean(hit && (hit === element || element.contains(hit)));
}, selector);

const noHorizontalOverflow = async (page: Page) => {
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
};

/**
 * Activates a control from the keyboard. Toasts sit over the top of the screen,
 * where the list's header is (the headless camera's "Scan Error" among them), and
 * would intercept a pointer click there; the keyboard path is the same control.
 */
async function press(page: Page, control: ReturnType<Page['locator']>) {
  await control.focus();
  await page.keyboard.press('Enter');
}

const wake = (page: Page) => page.evaluate(() => (window as unknown as { __wake: () => { requests: number; held: number } }).__wake());
const setHidden = (page: Page, hidden: boolean) => page.evaluate((next) => (window as unknown as { __setHidden: (value: boolean) => void }).__setHidden(next), hidden);

test.describe('shopping trip mode: the open list in the store', () => {
  test.beforeEach(() => {
    consoleGuards = [];
  });
  test.afterEach(() => {
    for (const guard of consoleGuards) guard.expectClean('the open list');
  });

  test('phone: compact sticky header with "n left", page header, tabs and the floating "+" out of the way, first item near the top', async ({ browser }, testInfo) => {
    phoneOnly(testInfo);
    const listRef = await seed(testInfo);
    const a = await session(browser, PHONE, { mobile: true });
    try {
      const list = await openList(a.page, testInfo);
      const header = list.getByTestId('trip-header');
      await expect(header.getByTestId('trip-left')).toHaveText(`${SEED.length} left`);
      // The page header keeps only a hidden h1; tabs and the tab bar's raised "+" are gone.
      await expect(a.page.getByTestId('shopping-page-header')).toHaveAttribute('data-compact', 'true');
      await expect(a.page.getByRole('heading', { name: 'Shopping Center', level: 1 })).toBeAttached();
      await expect(a.page.getByText('Lists in the order you walk the store')).toHaveCount(0);
      await expect(a.page.getByRole('tab', { name: 'Pantry Inventory' })).toHaveCount(0);
      await expect(a.page.getByTestId('tabbar-quick-add')).toBeHidden();
      await expect(a.page.getByRole('link', { name: 'Chores' })).toBeVisible();
      // Back, cart, Add Item and the menu in the header; nothing scrolls sideways.
      for (const name of ['Back to all lists', 'Add Item', 'More list actions']) await expect(header.getByRole('button', { name })).toBeVisible();
      await expect(header.getByTestId('cart-indicator')).toBeVisible();
      await noHorizontalOverflow(a.page);
      // The first needed item is in the top 40% of the screen when the list opens.
      const firstRow = (await list.locator('[data-row-section="needed"]').first().boundingBox())!;
      expect(firstRow.y).toBeLessThan(PHONE.height * 0.4);
      // Rows are at least 48 px tall on touch, aisle chips too.
      expect(firstRow.height).toBeGreaterThanOrEqual(48);
      const chip = (await list.getByTestId('aisle-chips').getByRole('button').first().boundingBox())!;
      expect(chip.height).toBeGreaterThanOrEqual(48);

      // A tick updates "n left" at once.
      await list.getByText('E2E tm bread', { exact: true }).click();
      await expect(header.getByTestId('trip-left')).toHaveText(`${SEED.length - 1} left`);
      await expect.poll(async () => (await listRef.collection('items').doc('tm-bread').get()).data()?.status).toBe('purchased');

      // Leaving the list brings the page header, the tabs and the "+" back.
      await header.getByRole('button', { name: 'Back to all lists' }).click();
      await expect(a.page.getByRole('tab', { name: 'Pantry Inventory' })).toBeVisible();
      await expect(a.page.getByTestId('tabbar-quick-add')).toBeVisible();
      await expect(a.page.getByTestId('shopping-page-header')).toHaveAttribute('data-compact', 'false');
    } finally {
      await a.context.close();
    }
  });

  test('phone: every row reachable above the dock; the field, Add and the bottom Undo uncovered', async ({ browser }, testInfo) => {
    phoneOnly(testInfo);
    await seed(testInfo);
    const a = await session(browser, PHONE, { mobile: true });
    try {
      const list = await openList(a.page, testInfo);
      const form = a.page.getByRole('form', { name: `Quick add to ${LIST_NAME}` });
      const formSelector = `form[aria-label="Quick add to ${LIST_NAME}"]`;
      await expect(form).toBeVisible();
      const viewport = a.page.viewportSize()!;
      const dockAtStart = (await form.boundingBox())!;
      expect(dockAtStart.y + dockAtStart.height).toBeLessThanOrEqual(viewport.height);
      expect(await uncovered(a.page, `${formSelector} input`)).toBe(true);
      expect(await uncovered(a.page, `${formSelector} button[type="submit"]`)).toBe(true);

      const ids = await list.locator('[data-row-section="needed"]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row-id')!));
      expect(ids).toHaveLength(SEED.length);
      for (const id of [ids[0], ids[Math.floor(ids.length / 2)], ids[ids.length - 1]]) {
        const rowSelector = `[data-testid="open-list"] [data-row-id="${id}"]`;
        await a.page.locator(rowSelector).evaluate((row) => row.scrollIntoView({ block: 'end' }));
        const rowBox = (await a.page.locator(rowSelector).boundingBox())!;
        const dockBox = (await form.boundingBox())!;
        const headerBox = (await list.getByTestId('trip-header').boundingBox())!;
        expect(rowBox.y, id).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 1);
        expect(rowBox.y + rowBox.height, id).toBeLessThanOrEqual(dockBox.y + 1);
        expect(await uncovered(a.page, `${rowSelector} label`), id).toBe(true);
      }

      // The tick's Undo sits in the dock above the field: within reach, uncovered, never under the tab bar.
      const last = ids[ids.length - 1];
      await list.locator(`[data-row-id="${last}"]`).evaluate((row) => row.scrollIntoView({ block: 'end' }));
      await list.locator(`[data-row-id="${last}"] label`).click();
      const undo = a.page.getByRole('button', { name: /^Undo ticking E2E tm/ });
      await expect(undo).toBeVisible();
      const undoBox = (await undo.boundingBox())!;
      const dockBox = (await form.boundingBox())!;
      expect(undoBox.y + undoBox.height).toBeLessThanOrEqual(dockBox.y + 1);
      expect(undoBox.y).toBeGreaterThan(viewport.height / 2);
      expect(await uncovered(a.page, '[data-testid="undo-snackbar"] button[aria-label^="Undo ticking"]')).toBe(true);
      expect(await uncovered(a.page, `${formSelector} input`)).toBe(true);
      expect(dockBox.y + dockBox.height).toBeLessThanOrEqual(viewport.height);
      await undo.click();
      await expect(a.page.locator(`#item-needed-${last}`)).toBeAttached();
    } finally {
      await a.context.close();
    }
  });

  test('phone: one actions menu holds Scan to tick, Trips, Manage Categories and the Barcode Library; dialogs are bottom sheets', async ({ browser }, testInfo) => {
    phoneOnly(testInfo);
    await seed(testInfo);
    const a = await session(browser, PHONE, { mobile: true });
    try {
      const list = await openList(a.page, testInfo);
      // None of them is a full-width button on the screen any more.
      for (const name of ['Manage Categories', 'Scan to tick', 'Trips']) await expect(a.page.getByRole('button', { name, exact: true })).toHaveCount(0);
      const menuButton = list.getByRole('button', { name: 'More list actions' });
      await menuButton.click();
      const menu = a.page.getByRole('menu');
      for (const name of ['Scan to tick', 'Trips', 'Manage Categories']) await expect(menu.getByRole('menuitem', { name })).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: 'Barcode Library' })).toHaveAttribute('href', '/library');
      await menu.getByRole('menuitem', { name: 'Manage Categories' }).click();
      const dialog = a.page.getByRole('dialog', { name: 'Manage Categories' });
      await expect(dialog).toBeVisible();
      // A bottom sheet: full width, on the bottom edge.
      await expect.poll(async () => {
        const box = (await dialog.boundingBox())!;
        return [Math.round(box.x), Math.round(box.width), Math.round(box.y + box.height)];
      }).toEqual([0, PHONE.width, PHONE.height]);
      await a.page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(menuButton).toBeFocused();

      // Scan to tick is still one tap from the menu (SH-33f).
      await menuButton.click();
      await a.page.getByRole('menu').getByRole('menuitem', { name: 'Scan to tick' }).click();
      await expect(a.page.getByRole('dialog', { name: 'Scan to tick' })).toBeVisible();
      await a.page.keyboard.press('Escape');
      await expect(a.page.getByRole('dialog', { name: 'Scan to tick' })).toHaveCount(0);
      await expect(menuButton).toBeFocused();

      // Add Item and the edit sheet are bottom sheets too.
      await press(a.page, list.getByRole('button', { name: 'Add Item' }));
      const add = a.page.getByRole('dialog', { name: 'Add Item to List' });
      await expect(add).toBeVisible();
      await expect.poll(async () => Math.round((await add.boundingBox())!.width)).toBe(PHONE.width);
      await a.page.keyboard.press('Escape');
      await press(a.page, list.getByRole('button', { name: 'Edit E2E tm milk' }));
      const sheet = a.page.getByTestId('item-edit-sheet');
      await expect(sheet).toBeVisible();
      await expect.poll(async () => { const box = (await sheet.boundingBox())!; return Math.round(box.y + box.height); }).toBe(PHONE.height);
    } finally {
      await a.context.close();
    }
  });

  test('phone: aisle headings stick under the header; an aisle chip jumps to its aisle', async ({ browser }, testInfo) => {
    phoneOnly(testInfo);
    await seed(testInfo);
    const a = await session(browser, PHONE, { mobile: true });
    try {
      const list = await openList(a.page, testInfo);
      const header = list.getByTestId('trip-header');
      // Aisles are h4, one level below the "Needed" section heading (h3).
      await expect(list.getByRole('heading', { level: 3, name: /Needed/ })).toBeVisible();
      const aisles = list.getByTestId('trip-aisle');
      await expect(aisles.locator('h4')).toHaveCount(5);

      // Scroll partway into the Dairy aisle: its heading sits right under the sticky header.
      const dairy = aisles.filter({ has: a.page.getByRole('heading', { name: 'Dairy', level: 4 }) });
      // Scroll so the aisle's top is 60 px above the stuck header's bottom (the site
      // header is 3.5rem, the trip header sticks right under it).
      const headerHeight = (await header.boundingBox())!.height;
      await dairy.evaluate((section, height) => {
        const siteHeader = parseFloat(getComputedStyle(document.documentElement).fontSize) * 3.5;
        window.scrollTo(0, section.getBoundingClientRect().top + window.scrollY - (siteHeader + height) + 60);
      }, headerHeight);
      await expect.poll(async () => {
        const headerBox = (await header.boundingBox())!;
        const headingBox = (await dairy.locator('h4').boundingBox())!;
        return Math.abs(headingBox.y - (headerBox.y + headerBox.height)) <= 2 && headerBox.y >= 0 && headerBox.y <= 60;
      }).toBe(true);
      expect(await a.page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

      // Back to the top, then the "Dairy" chip brings that aisle up under the header
      // (the last aisle cannot reach the top: the page ends first).
      await a.page.evaluate(() => window.scrollTo(0, 0));
      await header.getByTestId('aisle-chips').getByRole('button', { name: 'Dairy, 4 needed' }).click();
      const jumped = list.getByRole('heading', { name: 'Dairy', level: 4 });
      await expect.poll(async () => {
        const headerBox = (await header.boundingBox())!;
        const headingBox = (await jumped.boundingBox())!;
        return Math.abs(headingBox.y - (headerBox.y + headerBox.height)) <= 4;
      }).toBe(true);
      await noHorizontalOverflow(a.page);
    } finally {
      await a.context.close();
    }
  });

  test('phone: typing filters the needed items and Enter adds what was typed', async ({ browser }, testInfo) => {
    phoneOnly(testInfo);
    const listRef = await seed(testInfo);
    const a = await session(browser, PHONE, { mobile: true });
    try {
      const list = await openList(a.page, testInfo);
      const field = a.page.getByLabel(`Items to add to ${LIST_NAME}`);
      await expect(field).toHaveAttribute('placeholder', 'Type to find or add');
      await field.fill('milk');
      await expect(list.locator('[data-row-section="needed"]')).toHaveCount(2);
      await expect(a.page.getByTestId('quick-add-hint')).toHaveText('2 needed items match. Press Enter to add milk.');
      await expect(list.getByTestId('aisle-chips')).toHaveCount(0);
      await field.fill('E2E tm kiwi');
      await expect(list.getByTestId('trip-no-match')).toBeVisible();
      await field.press('Enter');
      // Saved through the normal quick-add path; the field clears and every needed item shows again.
      await expect(field).toHaveValue('');
      await expect(list.locator('[data-row-section="needed"]')).toHaveCount(SEED.length + 1);
      await expect(list.getByText('E2E tm kiwi', { exact: true })).toBeVisible();
      await expect(list.getByTestId('trip-left')).toHaveText(`${SEED.length + 1} left`);
      await expect.poll(async () => (await listRef.collection('items').where('name', '==', 'E2E tm kiwi').get()).size).toBe(1);
    } finally {
      await a.context.close();
    }
  });

  test('phone: the screen stays on while a list is open, and lets go when it is left or hidden', async ({ browser }, testInfo) => {
    phoneOnly(testInfo);
    await seed(testInfo);
    const a = await session(browser, PHONE, { mobile: true });
    try {
      const list = await openList(a.page, testInfo);
      // One lock held while the list is open.
      await expect.poll(async () => (await wake(a.page)).held).toBe(1);
      // Hidden: the browser drops it and nothing asks again while hidden.
      await setHidden(a.page, true);
      await expect.poll(async () => (await wake(a.page)).held).toBe(0);
      const before = (await wake(a.page)).requests;
      // Shown again: asked for again.
      await setHidden(a.page, false);
      await expect.poll(async () => wake(a.page)).toEqual({ requests: before + 1, held: 1 });
      // Leaving the list lets go.
      await list.getByRole('button', { name: 'Back to all lists' }).click();
      await expect.poll(async () => (await wake(a.page)).held).toBe(0);
      await expect(a.page.getByRole('tab', { name: 'Pantry Inventory' })).toBeVisible();
      expect((await wake(a.page)).held).toBe(0);
    } finally {
      await a.context.close();
    }
  });

  test('phone: 115% and 130% text never clip the header or scroll sideways', async ({ browser }, testInfo) => {
    phoneOnly(testInfo);
    await seed(testInfo);
    const a = await session(browser, PHONE, { mobile: true });
    try {
      const list = await openList(a.page, testInfo);
      for (const scale of ['115', '130']) {
        await a.page.evaluate((value) => document.documentElement.setAttribute('data-text-scale', value), scale);
        await noHorizontalOverflow(a.page);
        const header = (await list.getByTestId('trip-header').boundingBox())!;
        for (const name of ['Back to all lists', 'Add Item', 'More list actions']) {
          const box = (await list.getByRole('button', { name }).boundingBox())!;
          expect(box.x, `${scale}% ${name}`).toBeGreaterThanOrEqual(header.x - 1);
          expect(box.x + box.width, `${scale}% ${name}`).toBeLessThanOrEqual(header.x + header.width + 1);
        }
        const title = list.getByRole('heading', { name: LIST_NAME, level: 2 });
        expect(await title.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      }
    } finally {
      await a.context.close();
    }
  });

  test('wall tablet (1263 × 818 touch): aisles in three columns, nothing sideways, no wake lock; two columns at 1024 × 768', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    await seed(testInfo);
    const a = await session(browser, TABLET);
    try {
      const list = await openList(a.page, testInfo);
      const columns = () => list.getByTestId('trip-aisle').evaluateAll((groups) => new Set(groups.map((group) => Math.round(group.getBoundingClientRect().left))).size);
      await expect.poll(columns).toBe(3);
      await noHorizontalOverflow(a.page);
      // Touch: rows are taller and one text step larger.
      const row = (await list.locator('[data-row-section="needed"]').first().boundingBox())!;
      expect(row.height).toBeGreaterThanOrEqual(48);
      const fontSize = await list.locator('[data-row-section="needed"] [data-item-name]').first().evaluate((node) => parseFloat(getComputedStyle(node.parentElement!).fontSize));
      expect(fontSize).toBeGreaterThanOrEqual(16);
      // A wide screen never keeps itself awake.
      expect(await wake(a.page)).toEqual({ requests: 0, held: 0 });

      await a.page.setViewportSize({ width: 1024, height: 768 });
      await expect.poll(columns).toBe(2);
      await noHorizontalOverflow(a.page);
      await a.page.setViewportSize({ width: 1440, height: 1000 });
      await expect.poll(columns).toBe(3);
      await noHorizontalOverflow(a.page);
    } finally {
      await a.context.close();
    }
  });
});
