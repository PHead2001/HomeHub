import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';

// SH-1 / SH-9: two sessions of the same household see each other's adds, ticks,
// deletes and a list deletion without a reload; deleting a list removes its
// items and categories, and the other session's open list says it was deleted
// and offers nothing to write with.
const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const adminApp = getApps().find((app) => app.name === 'shopping-live-e2e')
  || initializeApp({ projectId }, 'shopping-live-e2e');
const firestore = getFirestore(adminApp);
const lists = firestore.collection('households').doc(householdId).collection('shopping-lists');
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium', 'one browser is enough for data flows');

const LIST_ID = 'e2e-live-list';
const LIST_NAME = 'E2E Live';
const listRef = lists.doc(LIST_ID);

async function session(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: 'http://127.0.0.1:9002',
    colorScheme: 'dark',
    storageState: 'playwright/.auth/e2e-owner.json',
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(fixedNow);
  return { context, page };
}

async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Shopping Center', exact: true })).toBeVisible();
}

async function seedList() {
  await firestore.recursiveDelete(listRef);
  await listRef.set({ name: LIST_NAME, description: '', icon: 'ShoppingCart', type: 'Custom', color: 'tint-4' });
  await listRef.collection('items').doc('bread').set({ name: 'E2E live bread', quantity: 1, category: 'Other', status: 'needed', createdAt: fixedNow });
  await listRef.collection('config').doc('categories').set({ list: ['Bakery', 'Other'] });
}

test.describe('shopping: live across sessions', () => {
  test.beforeEach(async ({}, testInfo) => {
    if (testInfo.project.name === 'desktop-chromium') await seedList();
  });
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.project.name === 'desktop-chromium') await firestore.recursiveDelete(listRef);
  });

  test("adds, ticks, deletes and card counts reach the other session without a reload", async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const a = await session(browser);
    const b = await session(browser);
    try {
      await open(a.page, `/shopping?list=${LIST_ID}`);
      await open(b.page, `/shopping?list=${LIST_ID}`);
      await expect(a.page.locator('#item-needed-bread')).toBeVisible();
      await expect(b.page.locator('#item-needed-bread')).toBeVisible();

      // A adds an item: B sees it.
      const field = a.page.getByLabel(`Items to add to ${LIST_NAME}`);
      await field.fill('E2E live eggs');
      await field.press('Enter');
      await expect(a.page.getByRole('checkbox', { name: /E2E live eggs/ })).toBeVisible();
      await expect(b.page.getByRole('checkbox', { name: /E2E live eggs/ })).toBeVisible();

      // B ticks the bread: A sees it leave Needed and land in the cart.
      await b.page.locator('#item-needed-bread').click();
      await expect(a.page.locator('#item-needed-bread')).toHaveCount(0);
      await expect(a.page.getByText(/^Purchased \(1\)/)).toBeVisible();
      await expect.poll(async () => (await listRef.collection('items').doc('bread').get()).data()?.status).toBe('purchased');

      // A deletes the eggs: B sees them go.
      // Delete lives in the item's edit sheet (SH-13b).
      await a.page.getByRole('button', { name: 'Edit E2E live eggs', exact: true }).click();
      await a.page.getByRole('dialog', { name: 'Edit E2E live eggs' }).getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(b.page.getByRole('checkbox', { name: /E2E live eggs/ })).toHaveCount(0);

      // B on the overview: the card's counts follow A's writes.
      await b.page.getByRole('button', { name: 'Back to all lists' }).click();
      const card = b.page.getByTestId(`list-card-${LIST_ID}`);
      await expect(card).toContainText(/All 1 item in the cart/);
      await field.fill('E2E live jam');
      await field.press('Enter');
      await expect(card).toContainText(/1 to buy/);
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test('deleting a list removes its items and categories; the other session says it was deleted', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const a = await session(browser);
    const b = await session(browser);
    try {
      await open(a.page, '/shopping');
      await open(b.page, `/shopping?list=${LIST_ID}`);
      await expect(b.page.locator('#item-needed-bread')).toBeVisible();

      await a.page.getByRole('button', { name: `Open actions for ${LIST_NAME}` }).click();
      await a.page.getByRole('menuitem', { name: 'Delete' }).click();
      const confirm = a.page.getByRole('alertdialog', { name: `Delete ${LIST_NAME}?` });
      await expect(confirm).toContainText('its items and its categories');
      await confirm.getByRole('button', { name: 'Delete List' }).click();
      await expect(a.page.getByTestId(`list-card-${LIST_ID}`)).toHaveCount(0);

      // Everything under the list is gone, not only its document (SH-9a).
      await expect.poll(async () => (await listRef.get()).exists).toBe(false);
      // The parent goes first (it is the write barrier), then the descendants in pages, so
      // the subcollections empty a moment later: poll them rather than read once.
      await expect.poll(async () => (await listRef.collection('items').get()).size, { timeout: 15_000 }).toBe(0);
      await expect.poll(async () => (await listRef.collection('config').get()).size, { timeout: 15_000 }).toBe(0);

      // B's open list says so and offers no way to write (SH-1e).
      const openList = b.page.getByTestId('open-list');
      await expect(openList.getByRole('heading', { name: 'This list was deleted' })).toBeVisible();
      await expect(openList).toHaveAttribute('data-list-deleted', 'true');
      await expect(b.page.getByLabel(`Items to add to ${LIST_NAME}`)).toHaveCount(0);
      await expect(openList.getByRole('checkbox')).toHaveCount(0);
      await expect(openList.getByRole('button', { name: 'Add Item' })).toHaveCount(0);
      await expect(openList.getByRole('button', { name: /^Delete / })).toHaveCount(0);
      await expect(b.page).toHaveURL(new RegExp(`[?&]list=${LIST_ID}`));

      // The way back: the overview no longer shows the list.
      await openList.getByRole('button', { name: 'Back to all lists' }).click();
      await expect(b.page.getByRole('button', { name: 'Open List: Weekly Groceries' })).toBeVisible();
      await expect(b.page.getByTestId(`list-card-${LIST_ID}`)).toHaveCount(0);
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test('switching tabs keeps the lists mounted (no skeleton, no re-read)', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const a = await session(browser);
    try {
      await open(a.page, '/shopping');
      await expect(a.page.getByTestId(`list-card-${LIST_ID}`)).toBeVisible();
      await a.page.getByRole('tab', { name: 'Pantry Inventory' }).click();
      await a.page.getByRole('tab', { name: 'Shopping Lists' }).click();
      // Still the same mounted panel: the cards are there at once, never the skeleton.
      await expect(a.page.getByRole('status', { name: 'Loading shopping lists' })).toHaveCount(0);
      await expect(a.page.getByTestId(`list-card-${LIST_ID}`)).toBeVisible({ timeout: 1_000 });
    } finally {
      await a.context.close();
    }
  });
});
