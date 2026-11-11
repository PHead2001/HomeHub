import { expect, test, type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type CollectionReference } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';

// S6: creating a list with a type and description opens it (SH-5a, SH-20a/c),
// categories are reordered by keyboard and pointer (SH-34a, SH-10c), a list
// follows its store's aisle order (SH-34b), and both reach a second session live.
const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const OWNER_UID = 'e2e-owner-uid';
const adminApp = getApps().find((app) => app.name === 'shopping-lists-stores-e2e')
  || initializeApp({ projectId }, 'shopping-lists-stores-e2e');
const firestore = getFirestore(adminApp);
const household = firestore.collection('households').doc(householdId);
const lists = household.collection('shopping-lists');
const stores = household.collection('stores');
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium', 'one browser is enough for data flows');

const LIST_ID = 'e2e-aisles-list';
const LIST_NAME = 'E2E Aisles';
const STORE_ID = 'e2e-aisles-store';
const STORE_NAME = 'E2E Corner Shop';
const CREATED_NAME = 'E2E Saturday Shop';
const NEW_STORE_NAME = 'E2E Big Box';
const SECOND_LIST_ID = 'e2e-aisles-list-2';
const OTHER_STORE_ID = 'e2e-aisles-other-store';
const RENAMED_NAME = 'E2E Corner Market';
const listRef = lists.doc(LIST_ID);
const secondListRef = lists.doc(SECOND_LIST_ID);
const configRef = listRef.collection('config').doc('categories');

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

/** The aisle headings of the open list's Needed section, in screen order. */
async function aisles(page: Page): Promise<string[]> {
  return page.getByTestId('open-list').locator('h3.uppercase').allInnerTexts()
    .then((texts) => texts.map((text) => text.trim().toLowerCase()));
}

async function expectAisleOrder(page: Page, first: string, second: string) {
  await expect.poll(async () => {
    const order = await aisles(page);
    return order.indexOf(first.toLowerCase()) >= 0 && order.indexOf(first.toLowerCase()) < order.indexOf(second.toLowerCase());
  }).toBe(true);
}

/**
 * A control is at least 44 px tall in its own box once the dialog has finished
 * entering: the dialog zooms in from 95 %, and a box read during that animation
 * is scaled with it.
 */
async function expectTarget(dialog: Locator, control: Locator) {
  await dialog.evaluate((element) => Promise.all(element.getAnimations({ subtree: true })
    .filter((animation) => Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)))
    .map((animation) => animation.finished.catch(() => undefined))));
  const box = await control.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
}

async function deleteByName(collection: CollectionReference, name: string) {
  const found = await collection.where('name', '==', name).get();
  await Promise.all(found.docs.map((entry) => firestore.recursiveDelete(entry.ref)));
}

async function seed() {
  await firestore.recursiveDelete(listRef);
  await firestore.recursiveDelete(secondListRef);
  await stores.doc(STORE_ID).delete();
  await stores.doc(OTHER_STORE_ID).delete();
  await deleteByName(lists, CREATED_NAME);
  await deleteByName(stores, NEW_STORE_NAME);
  await listRef.set({ name: LIST_NAME, description: '', icon: 'ShoppingCart', type: 'Grocery', color: 'tint-2' });
  await listRef.collection('items').doc('bread').set({ name: 'E2E aisle bread', quantity: 1, category: 'Bakery', status: 'needed', createdAt: fixedNow });
  await listRef.collection('items').doc('milk').set({ name: 'E2E aisle milk', quantity: 1, category: 'Dairy', status: 'needed', createdAt: fixedNow });
  await listRef.collection('items').doc('cake').set({ name: 'E2E aisle cake', quantity: 1, category: 'Party', status: 'needed', createdAt: fixedNow });
  await configRef.set({ list: ['Bakery', 'Dairy', 'Other', 'Party'], ordered: ['Bakery', 'Dairy', 'Party', 'Other'] });
  await stores.doc(STORE_ID).set({ name: STORE_NAME, aisleOrder: ['Party', 'Dairy', 'Bakery'], createdByUid: OWNER_UID, updatedAt: fixedNow });
}

async function cleanup() {
  await firestore.recursiveDelete(listRef);
  await firestore.recursiveDelete(secondListRef);
  await stores.doc(STORE_ID).delete();
  await stores.doc(OTHER_STORE_ID).delete();
  await deleteByName(lists, CREATED_NAME);
  await deleteByName(stores, NEW_STORE_NAME);
}

test.describe('shopping: list types, category order and store aisles', () => {
  test.beforeEach(async ({}, testInfo) => {
    if (testInfo.project.name === 'desktop-chromium') await seed();
  });
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.project.name === 'desktop-chromium') await cleanup();
  });

  test('a custom list gets a type and a description, and creating it opens it', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/shopping');
    await page.getByRole('button', { name: 'Create New List' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create New List' });
    await dialog.getByRole('button', { name: 'Custom list', exact: true }).click();

    // The custom form leads back to the templates (SH-20c).
    await dialog.getByRole('button', { name: 'Back to templates' }).click();
    await expect(dialog.getByRole('button', { name: 'Create a Groceries list', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Custom list', exact: true }).click();

    // A name that is already a list warns, without blocking (SH-20b).
    const name = dialog.getByLabel('List Name');
    await name.fill(LIST_NAME.toLowerCase());
    await expect(dialog.getByRole('status').filter({ hasText: `You already have a list called ${LIST_NAME}` })).toBeVisible();
    await name.fill(CREATED_NAME);
    await expect(dialog.getByRole('status').filter({ hasText: 'You already have a list' })).toHaveCount(0);

    await dialog.getByRole('radio', { name: 'Grocery', exact: true }).click();
    await expect(dialog.getByRole('radio', { name: 'Grocery', exact: true })).toHaveAttribute('aria-checked', 'true');
    await dialog.getByLabel('Description (optional)').fill('The weekend run');
    await dialog.getByRole('button', { name: 'Save List' }).click();

    // Creating it opens it (SH-20a).
    await expect(page).toHaveURL(/[?&]list=e2e-saturday-shop/);
    await expect(page.getByTestId('open-list').getByRole('heading', { name: CREATED_NAME })).toBeVisible();
    await expect.poll(async () => {
      const found = await lists.where('name', '==', CREATED_NAME).get();
      const data = found.docs[0]?.data();
      return data ? { type: data.type, description: data.description, createdByUid: data.createdByUid } : null;
    }).toEqual({ type: 'Grocery', description: 'The weekend run', createdByUid: OWNER_UID });
  });

  test('categories move with the keyboard and the pointer, and the list follows', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, `/shopping?list=${LIST_ID}`);
    await expectAisleOrder(page, 'Bakery', 'Dairy');

    await page.getByRole('button', { name: 'Manage Categories' }).click();
    const dialog = page.getByRole('dialog', { name: 'Manage Categories' });
    const status = dialog.getByTestId('categories-save-status');

    // Keyboard: focus Move Dairy up and press Enter.
    const up = dialog.getByRole('button', { name: 'Move Dairy up' });
    await up.focus();
    await page.keyboard.press('Enter');
    await expect(status).toHaveText('Dairy moved up · Saved');
    await expect(up).toBeFocused();
    await expect.poll(async () => (await configRef.get()).data()).toEqual({ list: ['Bakery', 'Dairy', 'Other', 'Party'], ordered: ['Dairy', 'Bakery', 'Party', 'Other'] });

    // Pointer: Party down is refused at the end (Other stays last), Party up works.
    await expect(dialog.getByRole('button', { name: 'Move Party down' })).toHaveAttribute('aria-disabled', 'true');
    await dialog.getByRole('button', { name: 'Move Party up' }).click();
    await expect(status).toHaveText('Party moved up · Saved');
    await expect.poll(async () => (await configRef.get()).data()?.ordered).toEqual(['Dairy', 'Party', 'Bakery', 'Other']);

    // Adds are arrayUnion writes and keep the order.
    await dialog.getByLabel('New category name').fill('dairy');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog.getByRole('alert').filter({ hasText: 'Dairy is already a category.' })).toBeVisible();
    await dialog.getByLabel('New category name').fill('Garden');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(status).toHaveText('Garden added · Saved');
    await expect.poll(async () => (await configRef.get()).data()).toEqual({ list: ['Bakery', 'Dairy', 'Other', 'Party', 'Garden'], ordered: ['Dairy', 'Party', 'Bakery', 'Other', 'Garden'] });

    // Every move control is a 44 px target (48 px on touch).
    const box = await dialog.getByRole('button', { name: 'Move Bakery up' }).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);

    await dialog.getByRole('button', { name: 'Done' }).click();
    await expectAisleOrder(page, 'Dairy', 'Party');
    await expectAisleOrder(page, 'Party', 'Bakery');
  });

  test("a list at a store follows the store's aisle order; a new store starts from the order on screen", async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, `/shopping?list=${LIST_ID}`);
    await expectAisleOrder(page, 'Bakery', 'Party');

    await page.getByRole('button', { name: 'Manage Categories' }).click();
    const dialog = page.getByRole('dialog', { name: 'Manage Categories' });
    await dialog.getByRole('combobox', { name: 'Store for this list' }).click();
    await page.getByRole('option', { name: STORE_NAME }).click();
    await expect(dialog.getByTestId('categories-save-status')).toHaveText(`Sorted for ${STORE_NAME} · Saved`);
    await expect.poll(async () => (await listRef.get()).data()?.storeId).toBe(STORE_ID);
    await expect(dialog.getByRole('heading', { name: `Aisle order at ${STORE_NAME}` })).toBeVisible();

    // Moving here changes the store's order, not the list's.
    await dialog.getByRole('button', { name: 'Move Bakery up' }).click();
    await expect(dialog.getByTestId('categories-save-status')).toHaveText('Bakery moved up · Saved');
    await expect.poll(async () => (await stores.doc(STORE_ID).get()).data()?.aisleOrder).toEqual(['Party', 'Bakery', 'Dairy']);
    expect((await configRef.get()).data()?.ordered).toEqual(['Bakery', 'Dairy', 'Party', 'Other']);
    await dialog.getByRole('button', { name: 'Done' }).click();

    await expect(page.getByTestId('list-store')).toHaveText(`Sorted for ${STORE_NAME}`);
    await expectAisleOrder(page, 'Party', 'Bakery');
    await expectAisleOrder(page, 'Bakery', 'Dairy');

    // A new store starts with the order the dialog shows (here the Corner Shop's
    // aisle order, not the list's own Bakery, Dairy, Party) and is the list's store at once.
    await page.getByRole('button', { name: 'Manage Categories' }).click();
    await dialog.getByRole('combobox', { name: 'Store for this list' }).click();
    await page.getByRole('option', { name: 'New store…' }).click();
    await dialog.getByLabel('New store name').fill(NEW_STORE_NAME);
    await dialog.getByRole('button', { name: 'Create store' }).click();
    await expect(dialog.getByTestId('categories-save-status')).toHaveText(`${NEW_STORE_NAME} created · Saved`);
    const created = await stores.where('name', '==', NEW_STORE_NAME).get();
    expect(created.size).toBe(1);
    expect(created.docs[0].data()).toMatchObject({ aisleOrder: ['Party', 'Bakery', 'Dairy'], createdByUid: OWNER_UID });
    await expect.poll(async () => (await listRef.get()).data()?.storeId).toBe(created.docs[0].id);
    await expect(dialog.getByRole('heading', { name: `Aisle order at ${NEW_STORE_NAME}` })).toBeVisible();

    // Back to the list's own order.
    await dialog.getByRole('combobox', { name: 'Store for this list' }).click();
    await page.getByRole('option', { name: /No store/ }).click();
    await expect.poll(async () => (await listRef.get()).data()?.storeId).toBeNull();
  });

  test('the store is renamed from Manage Categories and every list shows the new name', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await listRef.update({ storeId: STORE_ID });
    await stores.doc(OTHER_STORE_ID).set({ name: NEW_STORE_NAME, aisleOrder: [], createdByUid: OWNER_UID, updatedAt: fixedNow });
    await open(page, `/shopping?list=${LIST_ID}`);
    await expect(page.getByTestId('list-store')).toHaveText(`Sorted for ${STORE_NAME}`);
    await page.getByRole('button', { name: 'Manage Categories' }).click();
    const dialog = page.getByRole('dialog', { name: 'Manage Categories' });
    await expectTarget(dialog, dialog.getByRole('button', { name: 'Rename store' }));
    await dialog.getByRole('button', { name: 'Rename store' }).click();
    const field = dialog.getByLabel('Store name');
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(STORE_NAME);
    await expectTarget(dialog, dialog.getByRole('button', { name: 'Save name' }));
    await expectTarget(dialog, dialog.getByRole('button', { name: 'Cancel' }));

    // Another store's name (case ignored) is explained inline.
    await field.fill(NEW_STORE_NAME.toUpperCase());
    await dialog.getByRole('button', { name: 'Save name' }).click();
    await expect(dialog.getByRole('alert').filter({ hasText: `You already have a store called ${NEW_STORE_NAME}` })).toBeVisible();

    await field.fill(`  ${RENAMED_NAME} `);
    await page.keyboard.press('Enter');
    await expect(dialog.getByTestId('categories-save-status')).toHaveText(`${STORE_NAME} renamed to ${RENAMED_NAME} · Saved`);
    const stored = (await stores.doc(STORE_ID).get()).data();
    expect(stored).toMatchObject({ name: RENAMED_NAME, createdByUid: OWNER_UID, aisleOrder: ['Party', 'Dairy', 'Bakery'] });
    expect(stored?.updatedAt).not.toEqual(fixedNow);
    await expect(dialog.getByRole('heading', { name: `Aisle order at ${RENAMED_NAME}` })).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Store for this list' })).toHaveText(RENAMED_NAME);
    await dialog.getByRole('combobox', { name: 'Store for this list' }).click();
    await expect(page.getByRole('option', { name: RENAMED_NAME })).toBeVisible();
    await expect(page.getByRole('option', { name: STORE_NAME, exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('list-store')).toHaveText(`Sorted for ${RENAMED_NAME}`);
  });

  test('deleting a store asks first, unassigns its lists, and Undo brings both back', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await listRef.update({ storeId: STORE_ID });
    await secondListRef.set({ name: 'E2E Aisles Two', description: '', icon: 'ShoppingCart', type: 'Grocery', color: 'tint-3', storeId: STORE_ID });
    await open(page, `/shopping?list=${LIST_ID}`);
    await expectAisleOrder(page, 'Party', 'Bakery');
    await page.getByRole('button', { name: 'Manage Categories' }).click();
    const dialog = page.getByRole('dialog', { name: 'Manage Categories' });
    const status = dialog.getByTestId('categories-save-status');

    // The confirmation names the store and how many lists use it; Cancel deletes nothing.
    await expectTarget(dialog, dialog.getByRole('button', { name: 'Delete store' }));
    await dialog.getByRole('button', { name: 'Delete store' }).click();
    const confirm = dialog.getByTestId('delete-store-confirm');
    await expect(confirm).toContainText(`Delete ${STORE_NAME}?`);
    await expect(confirm).toContainText('2 lists use it');
    await expectTarget(dialog, confirm.getByRole('button', { name: `Delete ${STORE_NAME}` }));
    await expectTarget(dialog, confirm.getByRole('button', { name: 'Cancel' }));
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    expect((await stores.doc(STORE_ID).get()).exists).toBe(true);

    await dialog.getByRole('button', { name: 'Delete store' }).click();
    await confirm.getByRole('button', { name: `Delete ${STORE_NAME}` }).click();
    await expect(status).toHaveText(`${STORE_NAME} deleted, 2 lists back to their own order · Saved`);
    expect((await stores.doc(STORE_ID).get()).exists).toBe(false);
    expect((await listRef.get()).data()?.storeId).toBeNull();
    expect((await secondListRef.get()).data()?.storeId).toBeNull();
    await expect(dialog.getByRole('heading', { name: 'Category order' })).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Store for this list' }).click();
    await expect(page.getByRole('option', { name: STORE_NAME })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Undo (the shared 10 s window) re-creates the store with the same id and points both lists back.
    await expectTarget(dialog, dialog.getByRole('button', { name: `Undo deleting ${STORE_NAME}` }));
    await dialog.getByRole('button', { name: `Undo deleting ${STORE_NAME}` }).click();
    await expect(status).toHaveText(`${STORE_NAME} restored · Saved`);
    expect((await stores.doc(STORE_ID).get()).data()).toMatchObject({ name: STORE_NAME, aisleOrder: ['Party', 'Dairy', 'Bakery'], createdByUid: OWNER_UID });
    expect((await listRef.get()).data()?.storeId).toBe(STORE_ID);
    expect((await secondListRef.get()).data()?.storeId).toBe(STORE_ID);
    await expect(dialog.getByRole('heading', { name: `Aisle order at ${STORE_NAME}` })).toBeVisible();

    // Delete again without Undo: the open list falls back to its own order.
    await dialog.getByRole('button', { name: 'Delete store' }).click();
    await confirm.getByRole('button', { name: `Delete ${STORE_NAME}` }).click();
    await expect(status).toHaveText(`${STORE_NAME} deleted, 2 lists back to their own order · Saved`);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('list-store')).toHaveCount(0);
    await expectAisleOrder(page, 'Bakery', 'Party');

    // A device that still pointed a list at the deleted store leaves a dangling id:
    // the list follows its own order, as before.
    await listRef.update({ storeId: STORE_ID });
    await expect(page.getByTestId('list-store')).toHaveCount(0);
    await expectAisleOrder(page, 'Bakery', 'Party');
  });

  test('a reorder and a store change reach the other session without a reload', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const a = await session(browser);
    const b = await session(browser);
    try {
      await open(a.page, `/shopping?list=${LIST_ID}`);
      await open(b.page, `/shopping?list=${LIST_ID}`);
      await expectAisleOrder(b.page, 'Bakery', 'Dairy');

      await a.page.getByRole('button', { name: 'Manage Categories' }).click();
      const dialog = a.page.getByRole('dialog', { name: 'Manage Categories' });
      await dialog.getByRole('button', { name: 'Move Dairy up' }).click();
      await expect(dialog.getByTestId('categories-save-status')).toHaveText('Dairy moved up · Saved');
      await expectAisleOrder(b.page, 'Dairy', 'Bakery');

      await dialog.getByRole('combobox', { name: 'Store for this list' }).click();
      await a.page.getByRole('option', { name: STORE_NAME }).click();
      await expect(b.page.getByTestId('list-store')).toHaveText(`Sorted for ${STORE_NAME}`);
      await expectAisleOrder(b.page, 'Party', 'Dairy');

      // B's own dialog shows the store's order A is editing, live.
      await b.page.getByRole('button', { name: 'Manage Categories' }).click();
      const other = b.page.getByRole('dialog', { name: 'Manage Categories' });
      await expect(other.getByRole('heading', { name: `Aisle order at ${STORE_NAME}` })).toBeVisible();
      await dialog.getByRole('button', { name: 'Move Bakery up' }).click();
      await expect.poll(async () => other.locator('li[data-category]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-category'))))
        .toEqual(['Party', 'Bakery', 'Dairy', 'Other']);
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });
});
