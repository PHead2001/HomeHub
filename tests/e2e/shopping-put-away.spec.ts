import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { Timestamp, getFirestore } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';

// S5 (SH-2a, SH-17a/b, SH-30, SH-3a/b, SH-2d): the receipt's two actions and the
// remembered choice, expiry chips while putting away, the trip's Undo after a
// reload, and no stray "Delete …?" prompt. Runs against the seeded emulator
// household; every test removes what it wrote.
const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const adminApp = getApps().find((app) => app.name === 'shopping-put-away-e2e')
  || initializeApp({ projectId }, 'shopping-put-away-e2e');
const household = getFirestore(adminApp).collection('households').doc(householdId);
const lists = household.collection('shopping-lists');
const pantry = household.collection('pantry-inventory');
const trips = household.collection('trips');
const preferences = household.collection('shopping-settings').doc('preferences');
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium', 'one browser is enough for data flows');

const LIST_ID = 'e2e-put-away-list';
const listRef = lists.doc(LIST_ID);
const YOGURT = 'E2E put-away yogurt';
const PEAS = 'E2E put-away peas';

// The seeded household has no time zone, so its day is America/Chicago: the fixed
// clock (2026-08-01T12:00Z) is Aug 1 there.
const PLUS_3_DAYS = '2026-08-04';

async function open(page: Page, path: string) {
  await page.clock.setFixedTime(fixedNow);
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Shopping Center', exact: true })).toBeVisible();
}

async function finishTrip(page: Page) {
  await open(page, `/shopping?list=${LIST_ID}`);
  await page.locator('#item-needed-yogurt').click();
  await page.locator('#item-needed-peas').click();
  const receipt = page.getByRole('dialog', { name: 'Trip complete' });
  await expect(receipt).toBeVisible();
  return receipt;
}

async function cleanup() {
  const [batches, tripDocs] = await Promise.all([
    pantry.where('name', 'in', [YOGURT, PEAS]).get(),
    trips.where('listId', '==', LIST_ID).get(),
  ]);
  await Promise.all([...batches.docs, ...tripDocs.docs].map((document) => document.ref.delete()));
  await Promise.all([YOGURT, PEAS].map((name) => household.collection('shopping-usuals').doc(encodeURIComponent(name.toLowerCase())).delete()));
  await getFirestore(adminApp).recursiveDelete(listRef);
  await preferences.delete();
}

test.describe('shopping: put away and clear', () => {
  test.beforeEach(async ({}, testInfo) => {
    if (testInfo.project.name !== 'desktop-chromium') return;
    await cleanup();
    await listRef.set({ name: 'E2E Put Away', description: '', icon: 'ShoppingCart', type: 'Grocery', color: 'tint-4' });
    await listRef.collection('items').doc('yogurt').set({ name: YOGURT, quantity: 2, category: 'Dairy', status: 'needed', createdAt: fixedNow });
    await listRef.collection('items').doc('peas').set({ name: PEAS, quantity: 1, category: 'Frozen', status: 'needed', createdAt: fixedNow });
  });
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.project.name === 'desktop-chromium') await cleanup();
  });

  test('the receipt offers Put away & clear and Done; expiry chips set the use-by; the list is cleared with no delete prompt', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const receipt = await finishTrip(page);
    await expect(receipt.getByRole('button', { name: 'Done' })).toBeVisible();
    const putAway = receipt.getByRole('button', { name: 'Put away & clear' });
    await expect(putAway).toHaveAttribute('data-primary', 'true');
    await putAway.click();

    const dialog = page.getByRole('dialog', { name: 'Put away' });
    await expect(dialog.getByRole('combobox', { name: `Shelf for ${YOGURT}` })).toHaveText('Fridge');
    await expect(dialog.getByRole('combobox', { name: `Shelf for ${PEAS}` })).toHaveText('Freezer');
    // Per-shelf defaults (SH-30a): Fridge +1 w, Freezer +3 mo.
    const yogurtChips = dialog.getByRole('group', { name: `Use by for ${YOGURT}` });
    await expect(yogurtChips.getByRole('button', { name: '+1 w' })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('group', { name: `Use by for ${PEAS}` }).getByRole('button', { name: '+3 mo' })).toHaveAttribute('aria-pressed', 'true');
    // +3 d (SH-30b).
    await yogurtChips.getByRole('button', { name: '+3 d' }).click();
    await expect(yogurtChips.getByRole('button', { name: '+3 d' })).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: /^Put away & clear \(2 items\)$/ }).click();
    await expect(dialog).toHaveCount(0);

    await expect.poll(async () => (await pantry.where('name', '==', YOGURT).get()).docs.map((document) => ({
      location: document.data().location, packages: document.data().packages, expiryDate: document.data().expiryDate,
    }))).toEqual([{ location: 'Fridge', packages: 2, expiryDate: PLUS_3_DAYS }]);
    expect((await pantry.where('name', '==', PEAS).get()).docs[0]?.data().location).toBe('Freezer');
    await expect.poll(async () => (await listRef.collection('items').get()).size).toBe(0);
    // One trip in history; the choice is remembered for the household.
    expect((await trips.where('listId', '==', LIST_ID).get()).size).toBe(1);
    await expect.poll(async () => (await preferences.get()).data()?.afterTrip).toBe('putAwayAndClear');
    // Grocery lists never offer "Delete empty list?" (SH-3a).
    await expect(page.getByRole('alertdialog', { name: 'Delete Empty List?' })).toHaveCount(0);
    await expect(page.getByTestId('undo-snackbar')).toContainText('E2E Put Away put away');

    // Receipt history (SH-32c): the trip, what went where, and its Undo for 15 minutes.
    await page.getByRole('button', { name: 'Trips' }).click();
    const history = page.getByRole('dialog', { name: 'Recent trips' });
    await expect(history.getByRole('list', { name: 'Recent trips' })).toContainText(YOGURT);
    await expect(history).toContainText(`Fridge · ${PLUS_3_DAYS}`);
    await expect(history.getByRole('button', { name: 'Undo this trip' })).toBeVisible();
  });

  test('usuals due show as quick-add chips and a tap adds the item (SH-32b)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const usual = household.collection('shopping-usuals').doc('e2e%20usual%20oat%20milk');
    await usual.set({
      name: 'E2E usual oat milk', nameKey: 'e2e usual oat milk', category: 'Dairy', count: 4, cadenceDays: 6,
      recent: [], lastBoughtAt: Timestamp.fromMillis(fixedNow.getTime() - 7 * 86_400_000),
    });
    try {
      await open(page, `/shopping?list=${LIST_ID}`);
      const chips = page.getByRole('group', { name: 'Usuals due' });
      await chips.getByRole('button', { name: 'E2E usual oat milk · every ~6 days' }).click();
      await expect(page.getByRole('checkbox', { name: /E2E usual oat milk/ })).toBeVisible();
      await expect(chips.getByRole('button', { name: /E2E usual oat milk/ })).toHaveCount(0);
    } finally {
      await usual.delete();
      const added = await listRef.collection('items').where('name', '==', 'E2E usual oat milk').get();
      await Promise.all(added.docs.map((document) => document.ref.delete()));
    }
  });

  test('the trip Undo is offered again after a reload and puts everything back', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const receipt = await finishTrip(page);
    await receipt.getByRole('button', { name: 'Put away & clear' }).click();
    const dialog = page.getByRole('dialog', { name: 'Put away' });
    await dialog.getByRole('button', { name: /^Put away & clear \(2 items\)$/ }).click();
    await expect.poll(async () => (await listRef.collection('items').get()).size).toBe(0);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'E2E Put Away', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Undo putting away E2E Put Away' }).click();

    await expect.poll(async () => (await listRef.collection('items').get()).docs.map((document) => document.id).sort()).toEqual(['peas', 'yogurt']);
    await expect.poll(async () => (await pantry.where('name', 'in', [YOGURT, PEAS]).get()).size).toBe(0);
    const [trip] = (await trips.where('listId', '==', LIST_ID).get()).docs;
    expect(trip.data().undoneAt).toBeTruthy();
    await expect(page.locator('#item-purchased-yogurt')).toBeAttached();
  });

  test('Done is remembered and becomes the primary action of the next receipt', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const receipt = await finishTrip(page);
    await receipt.getByRole('button', { name: 'Done' }).click();
    await expect(receipt).toHaveCount(0);
    await expect.poll(async () => (await preferences.get()).data()?.afterTrip).toBe('done');
    // Nothing was put away or cleared.
    expect((await listRef.collection('items').get()).size).toBe(2);

    // Next trip: un-tick one item and finish again.
    await page.locator('#item-purchased-peas').click();
    await page.locator('#item-needed-peas').click();
    const next = page.getByRole('dialog', { name: 'Trip complete' });
    await expect(next).toBeVisible();
    await expect(next.getByRole('button', { name: 'Done' })).toHaveAttribute('data-primary', 'true');
    await expect(next.getByRole('button', { name: 'Put away & clear' })).not.toHaveAttribute('data-primary', 'true');
  });

  test('offline, the receipt says put away needs a connection', async ({ page, context }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, `/shopping?list=${LIST_ID}`);
    await page.locator('#item-needed-yogurt').click();
    await expect.poll(async () => (await listRef.collection('items').doc('yogurt').get()).data()?.status).toBe('purchased');
    await context.setOffline(true);
    try {
      await page.locator('#item-needed-peas').click();
      const receipt = page.getByRole('dialog', { name: 'Trip complete' });
      await expect(receipt).toBeVisible();
      await expect(receipt.getByTestId('receipt-offline')).toContainText('You are offline');
      await expect(receipt.getByRole('button', { name: 'Put away & clear' })).toBeDisabled();
    } finally {
      await context.setOffline(false);
    }
  });

  test('closing "Delete empty list?" with Escape clears it: Back never asks to delete the list (SH-3b)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const otherId = 'e2e-put-away-hardware';
    const other = lists.doc(otherId);
    await other.set({ name: 'E2E Hardware Run', description: '', icon: 'Wrench', type: 'Hardware', color: 'tint-1' });
    await other.collection('items').doc('nails').set({ name: 'E2E nails', quantity: 1, category: 'Other', status: 'purchased', createdAt: fixedNow });
    try {
      await open(page, `/shopping?list=${otherId}`);
      await page.getByRole('button', { name: 'Clear', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Clear Purchased' }).click();
      const prompt = page.getByRole('alertdialog', { name: 'Delete Empty List?' });
      await expect(prompt).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(prompt).toHaveCount(0);
      await page.getByRole('button', { name: 'Back to all lists' }).click();
      await expect(page.getByRole('button', { name: 'Open List: E2E Hardware Run' })).toBeVisible();
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      expect((await other.get()).exists).toBe(true);
    } finally {
      await getFirestore(adminApp).recursiveDelete(other);
    }
  });
});
