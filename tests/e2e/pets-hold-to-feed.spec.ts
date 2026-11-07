import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';

// H09 hold to feed: pressing and holding a pet's photo logs one feeding at the
// planned portion through the same writer as the Feed button; releasing early,
// leaving the photo and Escape cancel without writing or navigating.
const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const ownerUid = 'e2e-owner-uid';
const adminApp = getApps().find((app) => app.name === 'pets-hold-to-feed')
  || initializeApp({ projectId }, 'pets-hold-to-feed');
const household = getFirestore(adminApp).collection('households').doc(householdId);
const pixelLogs = household.collection('pets').doc('pixel').collection('feeding-logs');
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');

/** Pixel has no seeded feedings; remove anything these tests wrote. */
async function clearPixelFeedings() {
  const logs = await pixelLogs.get();
  await Promise.all(logs.docs.map((entry) => entry.ref.delete()));
}

async function openPets(page: Page) {
  await page.clock.setFixedTime(fixedNow);
  await page.goto('/pets');
  await expect(page.getByRole('heading', { name: 'Your Pets', exact: true })).toBeVisible();
  const card = page.getByTestId('pet-card-pixel');
  await expect(card).toContainText('No feedings logged yet');
  return card;
}

async function pressPhoto(page: Page) {
  const box = await page.getByTestId('pet-photo-pixel').boundingBox();
  expect(box).toBeTruthy();
  const centre = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  return { centre, box: box! };
}

test.describe('pets: hold to feed (H09)', () => {
  test.beforeEach(async ({}, testInfo) => { if (testInfo.project.name === 'desktop-chromium') await clearPixelFeedings(); });
  test.afterEach(async ({}, testInfo) => { if (testInfo.project.name === 'desktop-chromium') await clearPixelFeedings(); });

  test('holding the photo logs exactly one feeding and stays on the page', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const card = await openPets(page);
    // The Feed button stays as the accessible alternative and describes the gesture.
    const feedButton = card.getByRole('button', { name: 'Feed Pixel, 1 can' });
    await expect(feedButton).toHaveAccessibleDescription('Or press and hold the photo of Pixel to log 1 can.');

    await pressPhoto(page);
    await expect(page.getByTestId('hold-to-feed-ring')).toBeVisible();
    await expect(page.getByTestId('pet-photo-pixel')).toHaveAttribute('data-hold-phase', 'complete', { timeout: 3000 });
    // Keep holding past the end: still one feeding.
    await page.waitForTimeout(400);
    await page.mouse.up();

    await expect(page.getByText('Pixel fed', { exact: true })).toBeVisible();
    await expect(card).toContainText('Fed just now by Alex');
    await expect(page).toHaveURL(/\/pets$/);
    await expect.poll(async () => {
      const logs = await pixelLogs.get();
      return logs.docs.map((entry) => entry.data()).map(({ cups, foodAmountType, loggedByUid }) => ({ cups, foodAmountType, loggedByUid }));
    }).toEqual([{ cups: 1, foodAmountType: 'Cans', loggedByUid: ownerUid }]);
    // Nothing else arrives later.
    await page.waitForTimeout(500);
    expect((await pixelLogs.get()).size).toBe(1);
  });

  test('releasing early, leaving the photo or Escape writes nothing', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openPets(page);

    // Release early.
    await pressPhoto(page);
    await expect(page.getByTestId('hold-to-feed-ring')).toBeVisible();
    await page.waitForTimeout(300);
    await page.mouse.up();
    await expect(page.getByTestId('pet-photo-pixel')).toHaveAttribute('data-hold-phase', 'idle');
    await expect(page).toHaveURL(/\/pets$/);

    // Leave the photo while holding.
    const { box } = await pressPhoto(page);
    await page.waitForTimeout(200);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height + 60);
    await expect(page.getByTestId('pet-photo-pixel')).toHaveAttribute('data-hold-phase', 'idle');
    await page.waitForTimeout(900);
    await page.mouse.up();

    // Escape mid-press.
    await pressPhoto(page);
    await page.waitForTimeout(250);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pet-photo-pixel')).toHaveAttribute('data-hold-phase', 'idle');
    await page.waitForTimeout(900);
    await page.mouse.up();

    await expect(page).toHaveURL(/\/pets$/);
    await expect(page.getByText('Pixel fed', { exact: true })).toHaveCount(0);
    expect((await pixelLogs.get()).size).toBe(0);
  });

  test('a quick tap on the photo still opens the pet', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openPets(page);
    // The photo sits under the card's stretched name link, so click by position.
    const box = await page.getByTestId('pet-photo-pixel').boundingBox();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(page).toHaveURL(/\/pets\/pixel$/);
    expect((await pixelLogs.get()).size).toBe(0);
  });

  test('hold to feed works under reduced motion, without the paw burst', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const context = await browser.newContext({
      baseURL: 'http://127.0.0.1:9002', colorScheme: 'dark', reducedMotion: 'reduce', storageState: 'playwright/.auth/e2e-owner.json',
    });
    const page = await context.newPage();
    try {
      await openPets(page);
      await pressPhoto(page);
      await expect(page.getByTestId('pet-photo-pixel')).toHaveAttribute('data-hold-phase', 'complete', { timeout: 3000 });
      await page.mouse.up();
      await expect(page.getByText('Pixel fed', { exact: true })).toBeVisible();
      await expect(page.getByTestId('paw-burst')).toHaveCount(0);
      await expect.poll(async () => (await pixelLogs.get()).size).toBe(1);
    } finally {
      await context.close();
    }
  });

  test('members without pets.addLogs get no hold', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:9002', colorScheme: 'dark' });
    const page = await context.newPage();
    try {
      await page.clock.setFixedTime(fixedNow);
      await page.goto('/e2e-login?uid=e2e-limited-uid');
      await expect(page).toHaveURL('/');
      await page.goto('/pets');
      await expect(page.getByTestId('pet-card-pixel')).toBeVisible();
      await pressPhoto(page);
      await page.waitForTimeout(1100);
      await expect(page.getByTestId('hold-to-feed-ring')).toHaveCount(0);
      await page.mouse.up();
      expect((await pixelLogs.get()).size).toBe(0);
    } finally {
      await context.close();
    }
  });
});
