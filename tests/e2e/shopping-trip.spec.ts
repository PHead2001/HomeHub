import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type CollectionReference } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';

// Shopping trip, pantry shelves and Barcode Library polish (audit section 3/4, D14, H07, H08, H30).
// Runs against the seeded emulator household; every test cleans up what it writes.

const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const adminApp = getApps().find((app) => app.name === 'shopping-trip-e2e')
  || initializeApp({ projectId }, 'shopping-trip-e2e');
const household = getFirestore(adminApp).collection('households').doc(householdId);
const lists = household.collection('shopping-lists');
const groceryItems = lists.doc('weekly-groceries').collection('items');
const pantry = household.collection('pantry-inventory');
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium', 'one browser is enough for data flows');

async function open(page: Page, path: string) {
  await page.clock.setFixedTime(fixedNow);
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Shopping Center', exact: true })).toBeVisible();
}

async function deleteWhere(collection: CollectionReference, name: string) {
  const snapshot = await collection.where('name', '==', name).get();
  await Promise.all(snapshot.docs.map((document) => document.ref.delete()));
}

test.describe('shopping trip', () => {
  test('ticking stays on the list, keeps the URL and offers undo', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const apples = groceryItems.doc('apples');
    await apples.update({ status: 'needed' });
    try {
      await open(page, '/shopping');
      await page.getByRole('button', { name: 'Open Weekly Groceries' }).click();
      await expect(page).toHaveURL(/[?&]list=weekly-groceries/);

      await page.locator('#item-needed-apples').click();
      await expect(page.locator('#item-needed-apples')).toHaveCount(0);
      // No tab switch and no pantry form.
      await expect(page.getByRole('tab', { name: 'Shopping Lists' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect.poll(async () => (await apples.get()).data()?.status).toBe('purchased');

      await page.getByRole('button', { name: 'Undo' }).click();
      await expect(page.locator('#item-needed-apples')).toBeVisible();
      await expect.poll(async () => (await apples.get()).data()?.status).toBe('needed');

      // Back returns to the overview, which shows counts on each card.
      await page.goBack();
      await expect(page.getByRole('button', { name: 'Open Weekly Groceries' })).toBeVisible();
      await expect(page.getByText(/\d+ to buy/).first()).toBeVisible();
    } finally {
      await apples.update({ status: 'needed' });
    }
  });

  test('quick-add takes several items and merges duplicates into one item', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const name = 'E2E quick bread';
    await deleteWhere(groceryItems, name);
    try {
      await open(page, '/shopping?list=weekly-groceries');
      const field = page.getByLabel('Items to add to Weekly Groceries');
      await field.fill('E2E quick bread, 2 e2e quick bread');
      await field.press('Enter');
      await expect(page.getByRole('checkbox', { name: /E2E quick bread/ })).toBeVisible();
      await expect(field).toHaveValue('');
      await expect(field).toBeFocused();

      await field.fill('e2e QUICK bread');
      await page.getByRole('button', { name: 'Add to Weekly Groceries' }).click();
      await expect.poll(async () => {
        const snapshot = await groceryItems.where('name', '==', name).get();
        return snapshot.docs.map((document) => document.data().quantity);
      }).toEqual([4]);
      // The add has finished once the field is cleared.
      await expect(field).toHaveValue('');

      // Empty input is an inline field error, not a toast.
      await field.fill(' , ');
      await field.press('Enter');
      await expect(page.getByRole('alert').filter({ hasText: 'Type an item, or several separated by commas.' })).toBeVisible();
      await expect(field).toHaveAttribute('aria-invalid', 'true');
    } finally {
      await deleteWhere(groceryItems, name);
    }
  });

  test('finishing a list prints the receipt and sends items to the pantry shelves', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const listId = 'e2e-trip-list';
    const listRef = lists.doc(listId);
    const itemName = 'E2E receipt yogurt';
    await listRef.set({ name: 'E2E Trip', description: '', icon: 'NotAnIcon', type: 'Grocery', color: '#ff0000' });
    await listRef.collection('items').doc('yogurt').set({
      name: itemName, quantity: 2, category: 'Dairy', status: 'needed', createdAt: fixedNow,
    });
    try {
      await open(page, `/shopping?list=${listId}`);
      await page.locator('#item-needed-yogurt').click();

      const receipt = page.getByRole('dialog', { name: 'Trip complete' });
      await expect(receipt).toBeVisible();
      await expect(receipt.getByRole('list', { name: 'Items bought' })).toContainText(itemName);
      await receipt.getByRole('button', { name: 'Add to pantry' }).click();

      const handoff = page.getByRole('dialog', { name: 'Add to pantry' });
      await expect(handoff.getByRole('combobox', { name: `Shelf for ${itemName}` })).toHaveText('Fridge');
      await handoff.getByRole('button', { name: /^Add to pantry \(1 item\)$/ }).click();
      await expect(handoff).toHaveCount(0);

      await expect.poll(async () => {
        const snapshot = await pantry.where('name', '==', itemName).get();
        return snapshot.docs.map((document) => ({ location: document.data().location, quantity: document.data().quantity, unit: document.data().unit }));
      }).toEqual([{ location: 'Fridge', quantity: 2, unit: 'items' }]);
    } finally {
      await deleteWhere(pantry, itemName);
      await listRef.collection('items').doc('yogurt').delete();
      await listRef.delete();
    }
  });

  test('switching tabs keeps the page width steady and lists use token tints', async ({ page }) => {
    await open(page, '/shopping');
    await expect(page.getByRole('button', { name: 'Open Weekly Groceries' })).toBeVisible();
    const before = await page.evaluate(() => document.documentElement.clientWidth);
    await page.getByRole('tab', { name: 'Inventory' }).click();
    await expect(page.getByRole('button', { name: 'Generate Recipe' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(before);
    await page.getByRole('tab', { name: 'Shopping Lists' }).click();
    // The seeded Hardware Run list stores an unknown icon and a hex color; neither leaks into the UI.
    const inlineColors = await page.locator('[style*="color"]').evaluateAll((elements) => elements
      .map((element) => element.getAttribute('style') || '')
      .filter((style) => /#[0-9a-f]{3,8}/i.test(style)));
    expect(inlineColors).toEqual([]);
  });
});

test.describe('pantry shelves', () => {
  test('shelves show tiles with expiry states and move by keyboard', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const yogurt = pantry.doc('yogurt');
    try {
      await open(page, '/shopping?tab=pantry');
      const shelves = page.getByTestId('pantry-shelves');
      await expect(shelves).toBeVisible();
      await expect(shelves.getByRole('region', { name: /Fridge/ })).toContainText('Greek yogurt');
      // Greek yogurt expires 2026-08-04, three days after the fixed clock: it glows as expiring soon.
      await expect(shelves.locator('[data-expiry="soon"]').filter({ hasText: 'Greek yogurt' })).toBeVisible();

      const handle = page.getByRole('button', { name: 'Move Greek yogurt' });
      await handle.focus();
      await page.keyboard.press('Enter');
      await expect(handle).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      await expect.poll(async () => (await yogurt.get()).data()?.location).toBe('Freezer');
      await expect(shelves.getByRole('region', { name: /Freezer/ })).toContainText('Greek yogurt');

      // The list view is still available and remembered.
      await page.getByRole('button', { name: 'List view' }).click();
      await expect(page.getByRole('cell', { name: 'Greek yogurt', exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByRole('cell', { name: 'Greek yogurt', exact: true })).toBeVisible();
    } finally {
      await yogurt.update({ location: 'Fridge' });
    }
  });
});

test.describe('barcode library', () => {
  test('photo-first cards, a real count and a placeholder for missing photos', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const library = household.collection('barcode-library');
    await library.doc('100000000099').set({ name: 'E2E photoless product', imageUrl: '', createdAt: fixedNow.toISOString() });
    try {
      await page.clock.setFixedTime(fixedNow);
      await page.goto('/library');
      await expect(page.getByRole('heading', { name: 'Barcode Library', exact: true })).toBeVisible();
      await expect(page.getByText(/^You have \d+ products? saved\.$/)).toBeVisible();
      await expect(page.getByText(/\b1 items\b/)).toHaveCount(0);
      await expect(page.getByRole('img', { name: 'Product image for E2E Oat Cereal' })).toBeVisible();
      await expect(page.getByRole('img', { name: 'No product image for E2E photoless product' })).toBeVisible();

      await page.getByLabel('Search the library').fill('photoless');
      await expect(page.getByRole('article')).toHaveCount(1);

      // A missing photo is an inline field error, not a toast.
      await page.getByRole('button', { name: 'Add Item' }).click();
      const dialog = page.getByRole('dialog', { name: 'Add New Library Item' });
      await dialog.getByLabel('Barcode (UPC)').fill('100000000098');
      await dialog.getByLabel('Product Name').fill('E2E needs a photo');
      await dialog.getByRole('button', { name: 'Save Item' }).click();
      await expect(dialog.getByRole('alert').filter({ hasText: 'Add a photo of the product.' })).toBeVisible();
      expect((await library.doc('100000000098').get()).exists).toBe(false);
    } finally {
      await library.doc('100000000099').delete();
      await library.doc('100000000098').delete();
    }
  });
});
