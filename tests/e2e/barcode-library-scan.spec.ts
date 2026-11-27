import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';

// S7 (BL-3, BL-9, BL-10, SH-33f): an unknown barcode keeps its code into a
// working "Save to library", Add never replaces an existing product, the photo
// is optional, a lookup outage is not "not found", and scanning a needed product
// on an open list ticks it with the list's Undo. The scanner is driven through
// its manual "Barcode number" field (the deterministic lookup fixtures).
const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const ownerUid = 'e2e-owner-uid';
const adminApp = getApps().find((app) => app.name === 'barcode-library-scan-e2e')
  || initializeApp({ projectId }, 'barcode-library-scan-e2e');
const firestore = getFirestore(adminApp);
const household = firestore.collection('households').doc(householdId);
const library = household.collection('barcode-library');
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium', 'one browser is enough for data flows');

const LIST_ID = 'e2e-scan-list';
const listRef = household.collection('shopping-lists').doc(LIST_ID);
const UNKNOWN = '000000000404';
const TIMEOUT = '000000000408';
const JUICE = '008500001280';
const YOGURT = '009900045000';

async function open(page: Page, path: string, heading: string) {
  await page.clock.setFixedTime(fixedNow);
  await page.goto(path);
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
}

async function scanWith(page: Page, opener: string, scannerName: string, barcode: string) {
  if (opener === 'Scan to tick') {
    // Scan to tick is in the open list's actions menu (S8b), top right, where the
    // top-right toasts of the previous scan may still sit over it: open the menu and
    // choose the item from the keyboard, which no toast can intercept.
    const menuButton = page.getByTestId('open-list').getByRole('button', { name: 'More list actions' });
    const item = page.getByRole('menu').getByRole('menuitem', { name: opener, exact: true });
    // Right after the previous scanner closes, focus is still being handed back to the menu
    // button, and an Enter pressed in that moment can be lost: press again until the menu is open.
    await expect(async () => {
      if (!(await item.isVisible())) {
        await menuButton.focus();
        await page.keyboard.press('Enter');
      }
      await expect(item).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    await item.focus();
    await page.keyboard.press('Enter');
  } else {
    await page.getByRole('button', { name: opener, exact: true }).click();
  }
  const scanner = page.getByRole('dialog', { name: scannerName });
  await scanner.getByLabel('Barcode number').fill(barcode);
  await scanner.getByRole('button', { name: 'Use barcode' }).click();
}

async function scanIntoAddItem(page: Page, barcode: string) {
  await page.getByRole('button', { name: 'Add Item' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Item to List' });
  await dialog.getByRole('button', { name: 'Scan Barcode' }).click();
  const scanner = page.getByRole('dialog', { name: 'Scan Barcode' });
  await scanner.getByLabel('Barcode number').fill(barcode);
  await scanner.getByRole('button', { name: 'Use barcode' }).click();
}

test.describe('barcode library: save from a scan and scan to tick', () => {
  test.beforeEach(async ({}, testInfo) => {
    if (testInfo.project.name !== 'desktop-chromium') return;
    await firestore.recursiveDelete(listRef);
    await listRef.set({ name: 'E2E Scan', description: '', icon: 'ShoppingCart', type: 'Custom', color: 'tint-3' });
    await listRef.collection('config').doc('categories').set({ list: ['Drinks', 'Dairy', 'Other'] });
    await library.doc(UNKNOWN).delete();
  });
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.project.name !== 'desktop-chromium') return;
    await firestore.recursiveDelete(listRef);
    await library.doc(UNKNOWN).delete();
  });

  test('an unknown code opens Add with the code filled in, saves without a photo, and the next scan knows it (BL-9, BL-10)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, `/shopping?list=${LIST_ID}`, 'Shopping Center');
    await scanIntoAddItem(page, UNKNOWN);
    // Shown inside Add Item (a toast's action would be unreachable behind the modal).
    const addDialog = page.getByRole('dialog', { name: 'Add Item to List' });
    await expect(addDialog.getByRole('alert').filter({ hasText: 'Product not found' })).toBeVisible();
    await addDialog.getByRole('link', { name: 'Save to library' }).click();

    await expect(page).toHaveURL(/\/library$/);
    const dialog = page.getByRole('dialog', { name: 'Add New Library Item' });
    await expect(dialog.getByLabel('Barcode (UPC)')).toHaveValue(UNKNOWN);
    // A name is required; a photo is not.
    await dialog.getByRole('button', { name: 'Save Item' }).click();
    await expect(dialog.getByText('Product name is required.')).toBeVisible();
    await dialog.getByLabel('Product Name').fill('E2E Mystery Tin');
    await dialog.getByRole('button', { name: 'Save Item' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => {
      const data = (await library.doc(UNKNOWN).get()).data();
      return data && [data.name, data.imageUrl, data.createdByUid, typeof data.createdAt];
    }, { timeout: 10_000 }).toEqual(['E2E Mystery Tin', '', ownerUid, 'string']);
    await expect(page.getByRole('img', { name: 'No product image for E2E Mystery Tin' })).toBeVisible();

    // The household library now answers the scan: one package of that name.
    await open(page, `/shopping?list=${LIST_ID}`, 'Shopping Center');
    await scanIntoAddItem(page, UNKNOWN);
    await expect.poll(async () => (await listRef.collection('items').where('name', '==', 'E2E Mystery Tin').get()).docs
      .map((document) => [document.data().quantity, document.data().barcode]), { timeout: 15_000 })
      .toEqual([[1, UNKNOWN]]);
  });

  test('Add never replaces an existing product: it offers to edit it (BL-3)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await library.doc(UNKNOWN).set({ name: 'E2E Saved First', imageUrl: '', createdAt: fixedNow.toISOString() });
    // `?add=` opens the Add dialog at once, and a modal dialog hides the page heading from the
    // accessibility tree: wait for the dialog, not the heading.
    await page.clock.setFixedTime(fixedNow);
    await page.goto(`/library?add=${UNKNOWN}`);
    const dialog = page.getByRole('dialog', { name: 'Add New Library Item' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Product Name').fill('E2E Overwrite Attempt');
    await dialog.getByRole('button', { name: 'Save Item' }).click();
    await expect(dialog.getByRole('alert').filter({ hasText: 'already saved as E2E Saved First' })).toBeVisible();
    expect((await library.doc(UNKNOWN).get()).data()?.name).toBe('E2E Saved First');

    await dialog.getByRole('button', { name: 'Edit E2E Saved First' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit Library Item' });
    await edit.getByLabel('Product Name').fill('E2E Renamed');
    await edit.getByRole('button', { name: 'Save Item' }).click();
    await expect.poll(async () => (await library.doc(UNKNOWN).get()).data(), { timeout: 10_000 })
      .toMatchObject({ name: 'E2E Renamed', createdAt: fixedNow.toISOString() });
  });

  test('a deleted product can be restored with Undo (BL-4)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await library.doc(UNKNOWN).set({ name: 'E2E Undo Me', imageUrl: '', createdAt: fixedNow.toISOString(), createdByUid: ownerUid });
    await open(page, '/library', 'Barcode Library');
    await page.getByRole('button', { name: 'Delete E2E Undo Me' }).click();
    await expect.poll(async () => (await library.doc(UNKNOWN).get()).exists, { timeout: 5_000 }).toBe(false);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await library.doc(UNKNOWN).get()).data()?.name, { timeout: 5_000 }).toBe('E2E Undo Me');
    await expect(page.getByRole('article', { name: 'E2E Undo Me' })).toBeVisible();
  });

  test('a lookup that cannot answer says so, not "not found" (BL-9)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, `/shopping?list=${LIST_ID}`, 'Shopping Center');
    await scanIntoAddItem(page, TIMEOUT);
    const addDialog = page.getByRole('dialog', { name: 'Add Item to List' });
    await expect(addDialog.getByRole('alert').filter({ hasText: 'Lookup unavailable' })).toBeVisible();
    await expect(page.getByText('Product not found')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Save to library' })).toHaveCount(0);
  });

  test('scanning a needed product ticks it with Undo; a product not on the list is offered as an Add (SH-33f)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const juice = listRef.collection('items').doc('juice');
    await juice.set({ name: 'E2E Family Juice', quantity: 1, category: 'Drinks', status: 'needed', createdAt: fixedNow });
    // A second needed item, so ticking the juice does not complete the trip (that
    // opens the trip receipt over the list, as any last tick does).
    await listRef.collection('items').doc('tea').set({ name: 'E2E tea', quantity: 1, category: 'Other', status: 'needed', createdAt: fixedNow });
    await open(page, `/shopping?list=${LIST_ID}`, 'Shopping Center');
    await expect(page.getByRole('checkbox', { name: /E2E Family Juice/ })).toBeVisible();

    await scanWith(page, 'Scan to tick', 'Scan to tick', JUICE);
    await expect.poll(async () => (await juice.get()).data()?.status, { timeout: 10_000 }).toBe('purchased');
    expect((await juice.get()).data()?.purchasedByUid).toBe(ownerUid);
    await expect(page.getByTestId('undo-snackbar')).toContainText('E2E Family Juice is in the cart');
    await page.getByRole('button', { name: 'Undo ticking E2E Family Juice' }).click();
    await expect.poll(async () => (await juice.get()).data()?.status, { timeout: 10_000 }).toBe('needed');

    await scanWith(page, 'Scan to tick', 'Scan to tick', YOGURT);
    await expect(page.getByText('Not on this list', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect.poll(async () => (await listRef.collection('items').where('name', '==', 'E2E Yogurt Multipack').get()).docs
      .map((document) => [document.data().quantity, document.data().size, document.data().sizeUnit, document.data().status]), { timeout: 15_000 })
      .toEqual([[1, 450, 'g', 'needed']]);

    // An item added by scanning ticks on the next scan of the same code.
    await scanWith(page, 'Scan to tick', 'Scan to tick', YOGURT);
    await expect.poll(async () => (await listRef.collection('items').where('name', '==', 'E2E Yogurt Multipack').get()).docs
      .map((document) => document.data().status), { timeout: 10_000 })
      .toEqual(['purchased']);
  });

  test('a camera that cannot start says why over the camera area and moves focus to the number field (BL-6, BL-18)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    // The test browser has no camera (or no permission): the denial or no-camera path.
    await page.clock.setFixedTime(fixedNow);
    await page.goto(`/library?add=${TIMEOUT}`);
    await page.getByRole('dialog', { name: 'Add New Library Item' }).getByRole('button', { name: 'Scan product barcode' }).click();
    const scanner = page.getByRole('dialog', { name: 'Scan Barcode' });
    await expect(scanner.getByTestId('scanner-camera-error')).toBeVisible({ timeout: 15_000 });
    // No aiming frame over an error, and the way on is the typed number.
    await expect(scanner.getByTestId('scanner-frame')).toHaveCount(0);
    await expect(scanner.getByLabel('Barcode number')).toBeFocused();
    await expect(scanner.getByTestId('scanner-status')).toHaveText(/Type the barcode number instead/);
    // A typed code fills the form and focus moves on to the product name (BL-18).
    await scanner.getByLabel('Barcode number').fill(UNKNOWN);
    await scanner.getByRole('button', { name: 'Use barcode' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add New Library Item' });
    await expect(dialog.getByLabel('Barcode (UPC)')).toHaveValue(UNKNOWN);
    await expect(dialog.getByLabel('Product Name')).toBeFocused();
  });

  test('Add saves one normalised ID and refuses what is not a barcode (BL-12)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const NORMALISED = '0036000291452';
    await library.doc(NORMALISED).delete();
    try {
      await page.clock.setFixedTime(fixedNow);
      await page.goto(`/library?add=${UNKNOWN}`);
      const dialog = page.getByRole('dialog', { name: 'Add New Library Item' });
      await dialog.getByLabel('Product Name').fill('E2E Normalised Beans');
      await dialog.getByLabel('Barcode (UPC)').fill('12345');
      await dialog.getByRole('button', { name: 'Save Item' }).click();
      await expect(dialog.getByText('Enter 6 to 32 digits.')).toBeVisible();
      // A UPC-A typed with spaces and hyphens is saved under its 13-digit form.
      await dialog.getByLabel('Barcode (UPC)').fill('0-36000 29145-2');
      await dialog.getByRole('button', { name: 'Save Item' }).click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(async () => (await library.doc(NORMALISED).get()).data()?.name, { timeout: 10_000 }).toBe('E2E Normalised Beans');
    } finally {
      await library.doc(NORMALISED).delete();
    }
  });

  test('a product saved verbatim with spaces and hyphens (before BL-12) is found by Add, not duplicated', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const LEGACY = '0-42100 00526-4';
    await library.doc(LEGACY).set({ name: 'E2E Legacy Spaced', imageUrl: '', createdAt: fixedNow.toISOString() });
    try {
      await page.clock.setFixedTime(fixedNow);
      await page.goto(`/library?add=${UNKNOWN}`);
      const dialog = page.getByRole('dialog', { name: 'Add New Library Item' });
      await dialog.getByLabel('Barcode (UPC)').fill(LEGACY);
      await dialog.getByLabel('Product Name').fill('E2E Duplicate Attempt');
      await dialog.getByRole('button', { name: 'Save Item' }).click();
      await expect(dialog.getByRole('alert').filter({ hasText: 'already saved as E2E Legacy Spaced' })).toBeVisible();
      expect((await library.doc('0042100005264').get()).exists).toBe(false);
    } finally {
      await library.doc(LEGACY).delete();
      await library.doc('0042100005264').delete();
    }
  });
});
