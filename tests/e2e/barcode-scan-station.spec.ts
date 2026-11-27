import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';

// BL-20, BL-21 (audit 17.3, D-8): the kitchen scan station on a personal account.
// The camera is driven through the scanner's "Barcode number" field (no camera in
// the test browser); the station keeps scanning after each code.
const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const ownerUid = 'e2e-owner-uid';
const adminApp = getApps().find((app) => app.name === 'barcode-scan-station-e2e')
  || initializeApp({ projectId }, 'barcode-scan-station-e2e');
const firestore = getFirestore(adminApp);
const household = firestore.collection('households').doc(householdId);
const library = household.collection('barcode-library');
const pantry = household.collection('pantry-inventory');
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium', 'one browser is enough for data flows');

const CODE = '000000000404';
const NAME = 'E2E Station Beans';

async function scan(page: Page, code: string) {
  const station = page.getByTestId('scan-station');
  await station.getByLabel('Barcode number').fill(code);
  await station.getByRole('button', { name: 'Use barcode' }).click();
}

const batches = async () => (await pantry.where('barcode', '==', CODE).get()).docs.map((entry) => entry.data().packages as number);

test.describe('kitchen scan station', () => {
  test.beforeEach(async ({}, testInfo) => {
    if (testInfo.project.name !== 'desktop-chromium') return;
    for (const entry of (await pantry.where('barcode', '==', CODE).get()).docs) await entry.ref.delete();
    await library.doc(CODE).set({ name: NAME, imageUrl: '', createdAt: fixedNow.toISOString(), createdByUid: ownerUid });
  });
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.project.name !== 'desktop-chromium') return;
    for (const entry of (await pantry.where('barcode', '==', CODE).get()).docs) await entry.ref.delete();
    for (const entry of (await firestore.collectionGroup('items').where('name', '==', NAME).get()).docs) {
      if (entry.ref.path.startsWith(`households/${householdId}/`)) await entry.ref.delete();
    }
    await library.doc(CODE).delete();
  });

  test('restock, then used up one package at a time; the last one asks "Add to list?" and adds only on Add', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await page.clock.setFixedTime(fixedNow);
    await page.goto('/library/scan?mode=restock');
    await expect(page.getByRole('heading', { name: 'Kitchen scan station' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Restock' })).toHaveAttribute('aria-checked', 'true');

    await scan(page, CODE);
    await expect(page.getByTestId('scan-station-line')).toContainText(`${NAME} is in the pantry (1).`);
    await expect.poll(batches, { timeout: 10_000 }).toEqual([1]);
    // The same code again right away is a repeat of the camera's read, but a typed code always counts.
    await scan(page, CODE);
    await expect.poll(batches, { timeout: 10_000 }).toEqual([2]);
    // The scan counted toward the product's favourites (BL-23).
    await expect.poll(async () => (await library.doc(CODE).get()).data()?.scanCount ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

    await page.getByRole('radio', { name: 'Used up' }).click();
    await scan(page, CODE);
    await expect(page.getByTestId('scan-station-line')).toContainText(`Used one ${NAME}. 1 left.`);
    await expect.poll(batches, { timeout: 10_000 }).toEqual([1]);
    await scan(page, CODE);
    await expect(page.getByTestId('scan-station-line')).toContainText(`Used the last ${NAME}.`);
    await expect.poll(batches, { timeout: 10_000 }).toEqual([0]);

    // D-8: nothing is on a list until Add is pressed.
    const ask = page.getByTestId('scan-station-ask');
    await expect(ask).toContainText('Add to list?');
    const onLists = async () => (await firestore.collectionGroup('items').where('name', '==', NAME).get()).docs
      .filter((entry) => entry.ref.path.startsWith(`households/${householdId}/`)).length;
    expect(await onLists()).toBe(0);
    await ask.getByRole('button', { name: 'Add', exact: true }).click();
    // One Grocery list (the seed's Weekly Groceries) adds at once; with several the station asks which.
    await expect(async () => {
      const which = page.getByText(`Which list for ${NAME}?`);
      if (await which.isVisible()) await page.getByTestId('scan-station').getByRole('button', { name: 'Weekly Groceries' }).click();
      expect(await onLists()).toBe(1);
    }).toPass({ timeout: 15_000 });
  });

  test('an unknown code says so and offers Save to library; nothing changes', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await library.doc(CODE).delete();
    await page.clock.setFixedTime(fixedNow);
    await page.goto('/library/scan');
    await scan(page, CODE);
    await expect(page.getByRole('alert').filter({ hasText: 'Product not found' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Save to library' })).toHaveAttribute('href', `/library?add=${CODE}`);
    expect(await batches()).toEqual([]);
  });
});
