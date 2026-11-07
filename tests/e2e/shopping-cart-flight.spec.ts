import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';

// H07 into the cart: a ticked item's name flies into the cart icon as a
// non-interactive copy, then the cart counts up; skipped under reduced motion.
const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const adminApp = getApps().find((app) => app.name === 'shopping-cart-flight')
  || initializeApp({ projectId }, 'shopping-cart-flight');
const apples = getFirestore(adminApp).collection('households').doc(householdId)
  .collection('shopping-lists').doc('weekly-groceries').collection('items').doc('apples');
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');

async function openList(page: Page) {
  await page.clock.setFixedTime(fixedNow);
  await page.goto('/shopping?list=weekly-groceries');
  await expect(page.locator('#item-needed-apples')).toBeVisible();
}

const cartCount = async (page: Page) => Number(await page.getByTestId('cart-indicator').getAttribute('data-count'));

test.describe('shopping: into the cart (H07)', () => {
  test.beforeEach(async ({}, testInfo) => { if (testInfo.project.name === 'desktop-chromium') await apples.update({ status: 'needed' }); });
  test.afterEach(async ({}, testInfo) => { if (testInfo.project.name === 'desktop-chromium') await apples.update({ status: 'needed' }); });

  test('a ticked item flies into the cart, which then counts up', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openList(page);
    const before = await cartCount(page);
    await page.locator('#item-needed-apples').click();
    const flight = page.getByTestId('cart-flight');
    await expect(flight).toBeVisible();
    await expect(flight).toHaveCSS('pointer-events', 'none');
    // The accessible count is updated at once; the badge catches up when the copy lands.
    await expect(page.getByTestId('cart-indicator')).toHaveAccessibleName(before + 1 === 1 ? 'Show the 1 item in the cart' : `Show the ${before + 1} items in the cart`);
    await expect(flight).toHaveCount(0);
    await expect.poll(() => cartCount(page)).toBe(before + 1);
    await expect.poll(async () => (await apples.get()).data()?.status).toBe('purchased');
  });

  test('reduced motion skips the flight and counts at once', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const context = await browser.newContext({
      baseURL: 'http://127.0.0.1:9002', colorScheme: 'dark', reducedMotion: 'reduce', storageState: 'playwright/.auth/e2e-owner.json',
    });
    const page = await context.newPage();
    try {
      await openList(page);
      const before = await cartCount(page);
      await page.locator('#item-needed-apples').click();
      await expect.poll(() => cartCount(page)).toBe(before + 1);
      await expect(page.getByTestId('cart-flight')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
