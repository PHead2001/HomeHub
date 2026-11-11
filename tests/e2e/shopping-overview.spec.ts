import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';

// S8a (SH-11a–c, SH-28c, SH-10g/h): the Shopping overview shows the household's
// Grocery list inline, grouped by aisle and tickable with Undo, with a large
// quick-add field, the pantry's expiring chips and "… is shopping · n left" when
// another session ticks; laid out for the wall tablet (1263 × 818 touch).
// No fixed clock here: "is shopping" compares the server's purchasedAt with now.
const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const adminApp = getApps().find((app) => app.name === 'shopping-overview-e2e')
  || initializeApp({ projectId }, 'shopping-overview-e2e');
const firestore = getFirestore(adminApp);
const household = firestore.collection('households').doc(householdId);
const lists = household.collection('shopping-lists');
const preferences = household.collection('shopping-settings').doc('preferences');
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium', 'one browser is enough for data flows');

const LIST_ID = 'e2e-overview-groceries';
const LIST_NAME = 'E2E Overview';
const listRef = lists.doc(LIST_ID);
const items = listRef.collection('items');
const PANTRY_ID = 'e2e-overview-spinach';

const SEED = [
  { id: 'ov-milk', name: 'E2E ov milk', category: 'Dairy' },
  { id: 'ov-bread', name: 'E2E ov bread', category: 'Bakery' },
  { id: 'ov-apples', name: 'E2E ov apples', category: 'Produce' },
  { id: 'ov-chips', name: 'E2E ov chips', category: 'Snacks' },
  { id: 'ov-cheese', name: 'E2E ov cheese', category: 'Dairy' },
];

/** A date-only day `days` from now (UTC): tomorrow is within the three-day horizon in any household zone. */
const dayFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
/** A Pantry v2 batch as the app writes it (`pantryBatchFields`). */
const pantryBatch = (packages: number, expiryDate: string) => ({
  name: 'E2E ov spinach', nameKey: 'e2e ov spinach', location: 'Fridge', unit: 'items',
  packages, packageSize: null, expiryDate, quantity: packages, schemaVersion: 2,
});
// One product, three batches: the chip names the soonest batch with packages left.
const PANTRY_BATCHES: Array<[string, ReturnType<typeof pantryBatch>]> = [
  [PANTRY_ID, pantryBatch(1, dayFromNow(1))],
  [`${PANTRY_ID}-used-up`, pantryBatch(0, dayFromNow(-1))],
  [`${PANTRY_ID}-later`, pantryBatch(1, dayFromNow(12))],
];

async function seed() {
  await firestore.recursiveDelete(listRef);
  await listRef.set({ name: LIST_NAME, description: '', icon: 'ShoppingCart', type: 'Grocery', color: 'tint-2' });
  await listRef.collection('config').doc('categories').set({ list: ['Produce', 'Bakery', 'Dairy', 'Snacks', 'Other'] });
  for (const item of SEED) {
    await items.doc(item.id).set({ name: item.name, quantity: 1, category: item.category, status: 'needed', createdAt: fixedNow });
  }
  // The overview shows this list whatever other Grocery lists exist.
  await preferences.set({ defaultGroceryListId: LIST_ID, updatedAt: FieldValue.serverTimestamp() });
  for (const [id, data] of PANTRY_BATCHES) await household.collection('pantry-inventory').doc(id).set(data);
}

async function cleanup() {
  await firestore.recursiveDelete(listRef);
  await preferences.delete();
  for (const [id] of PANTRY_BATCHES) await household.collection('pantry-inventory').doc(id).delete();
}

async function session(browser: Browser, options: { viewport?: { width: number; height: number }; hasTouch?: boolean } = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: 'http://127.0.0.1:9002',
    colorScheme: 'dark',
    storageState: 'playwright/.auth/e2e-owner.json',
    ...(options.viewport ? { viewport: options.viewport } : {}),
    ...(options.hasTouch ? { hasTouch: true } : {}),
  });
  return { context, page: await context.newPage() };
}

async function openOverview(page: Page) {
  await page.goto('/shopping');
  await expect(page.getByRole('heading', { name: 'Shopping Center', exact: true })).toBeVisible();
  const section = page.getByTestId('grocery-overview');
  await expect(section).toHaveAttribute('data-list-id', LIST_ID);
  await expect(section.locator('#item-needed-ov-milk')).toBeAttached();
  return section;
}

/** The page has no horizontal overflow, and `locator` lies inside the viewport without scrolling. */
async function expectFitsWithoutScrolling(page: Page, locators: Parameters<Page['locator']>[0][]) {
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, y: window.scrollY }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  expect(widths.y).toBe(0);
  const viewport = page.viewportSize()!;
  for (const selector of locators) {
    const box = await page.locator(selector).first().boundingBox();
    expect(box, selector).not.toBeNull();
    expect(box!.y, selector).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height, selector).toBeLessThanOrEqual(viewport.height);
    expect(box!.x + box!.width, selector).toBeLessThanOrEqual(viewport.width);
  }
}

test.describe('shopping overview: the Grocery list on the overview', () => {
  test.beforeEach(async ({}, testInfo) => {
    if (testInfo.project.name === 'desktop-chromium') await seed();
  });
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.project.name === 'desktop-chromium') await cleanup();
  });

  test('needed items inline by aisle; tick with Undo; quick-add adds to the Grocery list', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const a = await session(browser);
    try {
      const section = await openOverview(a.page);
      // Grouped by aisle in the supermarket walk (the list has no edited order).
      await expect(section.getByTestId('overview-aisle').locator('h3')).toHaveText(['Produce', 'Bakery', 'Dairy', 'Snacks']);
      await expect(section.getByTestId('overview-aisle').filter({ hasText: 'Dairy' }).getByRole('checkbox')).toHaveCount(2);
      // Every list is still a card (nothing left the overview).
      await expect(a.page.getByRole('button', { name: `Open List: ${LIST_NAME}` })).toBeVisible();
      await expect(a.page.getByRole('button', { name: 'Open List: Weekly Groceries' })).toBeVisible();
      await expect(a.page.getByRole('button', { name: 'Create New List' })).toBeVisible();
      // The field never takes focus by itself (no keyboard on a touch screen until tapped).
      await expect(a.page.getByLabel(`Items to add to ${LIST_NAME}`)).not.toBeFocused();

      // Tick from the overview: the whole row, the same write and Undo as in the list.
      await section.getByText('E2E ov bread').click();
      await expect(section.locator('#item-needed-ov-bread')).toHaveCount(0);
      await expect.poll(async () => (await items.doc('ov-bread').get()).data()?.status).toBe('purchased');
      const ticked = (await items.doc('ov-bread').get()).data()!;
      expect(typeof ticked.purchaseOpId).toBe('string');
      await expect(a.page.getByTestId('undo-snackbar')).toContainText('E2E ov bread is in the cart');
      await a.page.getByRole('button', { name: 'Undo ticking E2E ov bread' }).click();
      await expect(section.locator('#item-needed-ov-bread')).toBeVisible();
      await expect.poll(async () => (await items.doc('ov-bread').get()).data()?.status).toBe('needed');
      // This device's own ticks never read as "someone is shopping".
      await expect(a.page.getByTestId('shopping-activity')).toHaveCount(0);

      // Quick add: the S2 save path into this Grocery list.
      const field = a.page.getByLabel(`Items to add to ${LIST_NAME}`);
      await field.fill('E2E ov jam, 2 E2E ov limes');
      await field.press('Enter');
      await expect(section.getByRole('checkbox', { name: /E2E ov jam/ })).toBeVisible();
      await expect(section.getByRole('checkbox', { name: /E2E ov limes/ })).toBeVisible();
      await expect(field).toHaveValue('');
      await expect.poll(async () => (await items.where('name', '==', 'E2E ov limes').get()).docs.map((doc) => doc.data().quantity)).toEqual([2]);

      // Opening the list from the overview shows the same list.
      await section.getByRole('button', { name: `Open ${LIST_NAME}` }).click();
      await expect(a.page).toHaveURL(new RegExp(`[?&]list=${LIST_ID}`));
      await expect(a.page.getByTestId('open-list').getByRole('heading', { name: LIST_NAME, exact: true })).toBeVisible();
    } finally {
      await a.context.close();
    }
  });

  test('another session ticking shows "… is shopping · n left" live', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const a = await session(browser);
    const b = await session(browser);
    try {
      await openOverview(a.page);
      await b.page.goto(`/shopping?list=${LIST_ID}`);
      await expect(b.page.locator('#item-needed-ov-milk')).toBeVisible();
      await b.page.locator('#item-needed-ov-milk').click();
      await expect(b.page.locator('#item-needed-ov-milk')).toHaveCount(0);
      await b.page.locator('#item-needed-ov-apples').click();
      // Same member, another device: "You", with what is left (5 seeded, 2 ticked).
      const activity = a.page.getByTestId('shopping-activity');
      await expect(activity).toHaveText('You are shopping on another device · 3 left', { timeout: 15_000 });
      // Ticked elsewhere: gone from A's overview without a reload.
      await expect(a.page.locator('#item-needed-ov-milk')).toHaveCount(0);

      // Another member's ticks name them (written as that member would: own uid, server time).
      for (const id of ['ov-chips', 'ov-cheese']) {
        await items.doc(id).update({ status: 'purchased', purchasedByUid: 'e2e-admin-uid', purchasedAt: FieldValue.serverTimestamp(), purchaseOpId: `admin-${id}` });
      }
      // Most recent shopper first (Morgan Admin's display name, first name only).
      await expect(activity).toHaveText('Morgan and You are shopping · 1 left', { timeout: 15_000 });
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test("this device's own ticks are still its own after a reload (never \"another device\")", async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const a = await session(browser);
    try {
      const section = await openOverview(a.page);
      await section.locator('#item-needed-ov-milk').click();
      await expect.poll(async () => (await items.doc('ov-milk').get()).data()?.purchasedAt).toBeTruthy();
      await section.locator('#item-needed-ov-apples').click();
      await expect.poll(async () => (await items.doc('ov-apples').get()).data()?.purchasedAt).toBeTruthy();
      await a.page.reload();
      await expect(a.page.getByTestId('grocery-overview').locator('#item-needed-ov-bread')).toBeVisible();
      await expect(a.page.getByTestId('shopping-activity')).toHaveCount(0);
    } finally {
      await a.context.close();
    }
  });

  test('an expiring chip opens the pantry on that item', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const a = await session(browser);
    try {
      await openOverview(a.page);
      // One chip for the product (not the used-up or later batch), not "expired".
      const chip = a.page.getByTestId('expiring-chips').getByRole('button', { name: /^E2E ov spinach, / });
      await expect(chip).toHaveCount(1);
      await expect(chip).not.toContainText('expired');
      await chip.click();
      await expect(a.page).toHaveURL(/[?&]tab=pantry/);
      // The soonest batch's edit dialog (as a tile tap opens it). While this modal is open
      // the page behind it is aria-hidden, so the tabs are checked once it is closed.
      const dialog = a.page.getByRole('dialog', { name: 'Edit Item' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('Item Name')).toHaveValue('E2E ov spinach');
      await a.page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(a.page.getByRole('tab', { name: 'Pantry Inventory' })).toHaveAttribute('aria-selected', 'true');
      await expect(a.page.getByRole('tabpanel', { name: 'Pantry Inventory' })).toBeVisible();
      // The chip was a step forward: Back returns to the overview, and the dialog stays closed.
      await a.page.goBack();
      await expect(a.page).not.toHaveURL(/[?&]tab=pantry/);
      await expect(a.page.getByRole('tab', { name: 'Shopping Lists' })).toHaveAttribute('aria-selected', 'true');
      await expect(a.page.getByTestId('grocery-overview')).toBeVisible();
      await expect(dialog).toHaveCount(0);
    } finally {
      await a.context.close();
    }
  });

  test('wall tablet (1263 × 818, touch): uses the width, nothing overflows, field and items visible without scrolling', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const a = await session(browser, { viewport: { width: 1263, height: 818 }, hasTouch: true });
    try {
      const section = await openOverview(a.page);
      await expectFitsWithoutScrolling(a.page, [
        `form[aria-label="Quick add to ${LIST_NAME}"]`,
        '[data-testid="grocery-overview"] [data-row-id]',
      ]);
      // The items flow in more than one column, and the lists sit beside them.
      const groupXs = await section.getByTestId('overview-aisle').evaluateAll((groups) => [...new Set(groups.map((group) => Math.round(group.getBoundingClientRect().left)))]);
      expect(groupXs.length).toBeGreaterThanOrEqual(2);
      const sectionBox = (await section.boundingBox())!;
      const cardBox = (await a.page.getByTestId(`list-card-${LIST_ID}`).boundingBox())!;
      expect(cardBox.x).toBeGreaterThanOrEqual(sectionBox.x + sectionBox.width - 1);
      // Rows are at least 44 px, 48 px on a coarse pointer. Whether Chromium reports
      // `(pointer: coarse)` under `hasTouch` is recorded, so a run shows which check ran.
      const coarse = await a.page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
      testInfo.annotations.push({ type: 'pointer', description: coarse ? 'coarse: 48 px row check ran' : 'fine: only the 44 px row check ran' });
      const row = (await section.locator('label[for="item-needed-ov-milk"]').boundingBox())!;
      expect(row.height).toBeGreaterThanOrEqual(coarse ? 48 : 44);
      // The other tablet sizes: Chrome with its URL bar, and the fullscreen upper bound.
      for (const size of [{ width: 1263, height: 722 }, { width: 1264, height: 843 }, { width: 1024, height: 768 }]) {
        await a.page.setViewportSize(size);
        await expectFitsWithoutScrolling(a.page, [`form[aria-label="Quick add to ${LIST_NAME}"]`, '[data-testid="grocery-overview"] [data-row-id]']);
      }
    } finally {
      await a.context.close();
    }
  });

  test('phone (390 × 844): one column, no overflow, every row reachable above the dock, the dock and Undo uncovered', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const a = await session(browser, { viewport: { width: 390, height: 844 }, hasTouch: true });
    try {
      // More rows than fit, so the dock is pinned above the tab bar while rows pass under it.
      for (let index = 0; index < 8; index += 1) {
        await items.doc(`ov-extra-${index}`).set({ name: `E2E ov extra ${index}`, quantity: 1, category: 'Snacks', status: 'needed', createdAt: fixedNow });
      }
      const section = await openOverview(a.page);
      await expect(section.locator('[data-row-id]')).toHaveCount(SEED.length + 8);
      const widths = await a.page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(widths.scroll).toBeLessThanOrEqual(widths.client);
      const groupXs = await section.getByTestId('overview-aisle').evaluateAll((groups) => [...new Set(groups.map((group) => Math.round(group.getBoundingClientRect().left)))]);
      expect(groupXs).toHaveLength(1);

      const form = a.page.getByRole('form', { name: `Quick add to ${LIST_NAME}` });
      const field = a.page.getByLabel(`Items to add to ${LIST_NAME}`);
      const viewport = a.page.viewportSize()!;
      /** Whether the centre of `selector`'s first match hit-tests to that element (nothing covers it). */
      const uncovered = (selector: string) => a.page.evaluate((target) => {
        const element = document.querySelector(target);
        if (!element) return false;
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return Boolean(hit && (hit === element || element.contains(hit)));
      }, selector);

      // Without scrolling, the dock is on screen, inside the viewport, and the tab bar's
      // raised button does not cover its field or its Add button.
      const dockAtStart = (await form.boundingBox())!;
      expect(dockAtStart.y + dockAtStart.height).toBeLessThanOrEqual(viewport.height);
      expect(await uncovered(`form[aria-label="Quick add to ${LIST_NAME}"] input`)).toBe(true);
      expect(await uncovered(`form[aria-label="Quick add to ${LIST_NAME}"] button[type="submit"]`)).toBe(true);

      // Every row, the last one included, can be brought fully into view above the dock.
      const ids = await section.locator('[data-row-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row-id')!));
      for (const id of [ids[0], ids[Math.floor(ids.length / 2)], ids[ids.length - 1]]) {
        const rowSelector = `[data-testid="grocery-overview"] [data-row-id="${id}"]`;
        // As far as scrolling to the row allows (`block: 'end'` honours the rows' scroll margin).
        await a.page.locator(rowSelector).evaluate((row) => row.scrollIntoView({ block: 'end' }));
        const rowBox = (await a.page.locator(rowSelector).boundingBox())!;
        const dockBox = (await form.boundingBox())!;
        expect(rowBox.y, id).toBeGreaterThanOrEqual(0);
        expect(rowBox.y + rowBox.height, id).toBeLessThanOrEqual(dockBox.y + 1);
        expect(await uncovered(`${rowSelector} label`), id).toBe(true);
      }

      // A tick's Undo sits in the dock above the field, uncovered, and the dock stays in view.
      const last = ids[ids.length - 1];
      await section.locator(`[data-row-id="${last}"]`).evaluate((row) => row.scrollIntoView({ block: 'end' }));
      await section.locator(`[data-row-id="${last}"] label`).click();
      const undo = a.page.getByRole('button', { name: /^Undo ticking E2E ov/ });
      await expect(undo).toBeVisible();
      const undoBox = (await undo.boundingBox())!;
      const dockBox = (await form.boundingBox())!;
      expect(undoBox.y + undoBox.height).toBeLessThanOrEqual(dockBox.y + 1);
      expect(undoBox.y).toBeGreaterThanOrEqual(0);
      expect(await uncovered('[data-testid="undo-snackbar"] button[aria-label^="Undo ticking"]')).toBe(true);
      expect(dockBox.y + dockBox.height).toBeLessThanOrEqual(viewport.height);
      await undo.click();
      await expect(a.page.locator(`#item-needed-${last}`)).toBeAttached();
      await expect(field).toBeVisible();
    } finally {
      await a.context.close();
    }
  });
});
