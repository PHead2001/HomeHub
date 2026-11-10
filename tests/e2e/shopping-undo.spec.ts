import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';

// S3 (SH-15a/b, UNDO-10s, SH-8a/b, WT-20): the tick Undo survives a reload, is
// refused when another session ticked the item again meanwhile (it never
// overwrites a newer change), and an item can be edited with the keyboard alone.
const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const adminApp = getApps().find((app) => app.name === 'shopping-undo-e2e')
  || initializeApp({ projectId }, 'shopping-undo-e2e');
const firestore = getFirestore(adminApp);
const lists = firestore.collection('households').doc(householdId).collection('shopping-lists');
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium', 'one browser is enough for data flows');

const LIST_ID = 'e2e-undo-list';
const LIST_NAME = 'E2E Undo';
const listRef = lists.doc(LIST_ID);
const itemRef = listRef.collection('items').doc('jam');

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

const status = async () => (await itemRef.get()).data()?.status;

test.describe('shopping: tick, edit and Undo', () => {
  test.beforeEach(async ({}, testInfo) => {
    if (testInfo.project.name !== 'desktop-chromium') return;
    await firestore.recursiveDelete(listRef);
    await listRef.set({ name: LIST_NAME, description: '', icon: 'ShoppingCart', type: 'Custom', color: 'tint-2' });
    await listRef.collection('config').doc('categories').set({ list: ['Pantry', 'Snacks', 'Other'] });
    await itemRef.set({ name: 'E2E jam', quantity: 1, category: 'Pantry', status: 'needed', createdAt: fixedNow });
    await listRef.collection('items').doc('tea').set({ name: 'E2E tea', quantity: 1, category: 'Pantry', status: 'needed', createdAt: fixedNow });
  });
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.project.name === 'desktop-chromium') await firestore.recursiveDelete(listRef);
  });

  test('a tick writes who and a purchase id; its Undo is offered again after a reload', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const a = await session(browser);
    try {
      await open(a.page, `/shopping?list=${LIST_ID}`);
      await a.page.locator('#item-needed-jam').click();
      await expect(a.page.locator('#item-needed-jam')).toHaveCount(0);
      // Focus moved to the next row, not to <body> (SH-26a).
      await expect(a.page.locator('#item-needed-tea')).toBeFocused();
      await expect.poll(status).toBe('purchased');
      const ticked = (await itemRef.get()).data()!;
      expect(typeof ticked.purchaseOpId).toBe('string');
      expect(ticked.purchasedByUid).toBeTruthy();
      expect(ticked.purchasedAt).toBeTruthy();

      // The snackbar sits above the quick-add field.
      const snackbar = a.page.getByTestId('undo-snackbar');
      await expect(snackbar).toContainText('E2E jam is in the cart');
      const snackBox = await snackbar.boundingBox();
      const fieldBox = await a.page.getByRole('form', { name: `Quick add to ${LIST_NAME}` }).boundingBox();
      expect(snackBox!.y + snackBox!.height).toBeLessThanOrEqual(fieldBox!.y + 1);

      // A reload re-offers what is left of the 10 s window (the clock is fixed).
      await a.page.reload();
      await expect(a.page.getByRole('heading', { name: LIST_NAME, exact: true })).toBeVisible();
      await a.page.getByRole('button', { name: 'Undo ticking E2E jam' }).click();
      await expect(a.page.locator('#item-needed-jam')).toBeVisible();
      await expect.poll(status).toBe('needed');
      const undone = (await itemRef.get()).data()!;
      expect(undone.undoOpId).toBe(ticked.purchaseOpId);
      expect(undone.purchasedByUid ?? null).toBeNull();
      await expect(a.page.getByRole('button', { name: /^Undo ticking/ })).toHaveCount(0);
    } finally {
      await a.context.close();
    }
  });

  test('an Undo is refused once another session ticked the item again', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const a = await session(browser);
    const b = await session(browser);
    try {
      await open(a.page, `/shopping?list=${LIST_ID}`);
      await open(b.page, `/shopping?list=${LIST_ID}`);
      await a.page.locator('#item-needed-jam').click();
      await expect.poll(status).toBe('purchased');
      const first = (await itemRef.get()).data()!.purchaseOpId;

      // A leaves the list, so its Undo cannot be judged from the screen: the rules decide.
      await a.page.getByRole('button', { name: 'Back to all lists' }).click();
      await expect(a.page.getByRole('button', { name: `Open List: ${LIST_NAME}` })).toBeVisible();

      // B un-ticks and ticks it again: a new purchase.
      await b.page.getByText(/^Purchased \(1\)/).click();
      await b.page.locator('#item-purchased-jam').click();
      await expect(b.page.locator('#item-needed-jam')).toBeVisible();
      await b.page.locator('#item-needed-jam').click();
      await expect.poll(async () => (await itemRef.get()).data()?.purchaseOpId).not.toBe(first);
      await expect.poll(status).toBe('purchased');
      const second = (await itemRef.get()).data()!.purchaseOpId;

      // A reloads (the journal re-offers its Undo) and presses it: refused by the
      // rules, and it says so; B's tick stays.
      await a.page.reload();
      await a.page.getByRole('button', { name: 'Undo ticking E2E jam' }).click();
      await expect(a.page.getByText('Changed by someone else — not undone').first()).toBeVisible({ timeout: 15_000 });
      expect(await status()).toBe('purchased');
      expect((await itemRef.get()).data()!.purchaseOpId).toBe(second);

      // With the list open, a stale Undo is refused without writing at all.
      await a.page.getByRole('button', { name: `Open List: ${LIST_NAME}` }).click();
      await a.page.getByText(/^Purchased \(1\)/).click();
      await a.page.locator('#item-purchased-jam').click();
      await a.page.locator('#item-needed-jam').click();
      await expect.poll(async () => (await itemRef.get()).data()?.purchaseOpId).not.toBe(second);
      const third = (await itemRef.get()).data()!.purchaseOpId;
      await b.page.locator('#item-purchased-jam').click();
      await b.page.locator('#item-needed-jam').click();
      await expect.poll(async () => (await itemRef.get()).data()?.purchaseOpId).not.toBe(third);
      const fourth = (await itemRef.get()).data()!.purchaseOpId;
      // After a reload, once A's listener shows the item (B's purchase), the stale
      // Undo is refused on screen.
      await a.page.reload();
      await expect(a.page.getByText(/^Purchased \(1\)/)).toBeVisible();
      await a.page.getByRole('button', { name: 'Undo ticking E2E jam' }).click();
      await expect(a.page.getByText('Changed by someone else — not undone').first()).toBeVisible();
      expect((await itemRef.get()).data()!.purchaseOpId).toBe(fourth);
      expect(await status()).toBe('purchased');
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test('an item is edited with the keyboard alone, signed by the editor', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const a = await session(browser);
    try {
      await open(a.page, `/shopping?list=${LIST_ID}`);
      const tick = a.page.locator('#item-needed-jam');
      await tick.focus();
      // The Edit control is the next stop after the row's tick target.
      await a.page.keyboard.press('Tab');
      const edit = a.page.getByRole('button', { name: 'Edit E2E jam', exact: true });
      await expect(edit).toBeFocused();
      await a.page.keyboard.press('Enter');
      const sheet = a.page.getByRole('dialog', { name: 'Edit E2E jam' });
      await expect(sheet).toBeVisible();
      const nameField = sheet.getByLabel('Item name', { exact: true });
      await expect(nameField).toBeFocused();
      await a.page.keyboard.press('ControlOrMeta+a');
      await a.page.keyboard.type('E2E apricot jam');

      // Tab to "Increase quantity" and press it twice.
      const increase = sheet.getByRole('button', { name: 'Increase quantity' });
      for (let step = 0; step < 6 && !(await increase.evaluate((node) => node === document.activeElement)); step += 1) {
        await a.page.keyboard.press('Tab');
      }
      await expect(increase).toBeFocused();
      await a.page.keyboard.press('Enter');
      await a.page.keyboard.press('Space');
      await expect(sheet.getByLabel('Quantity', { exact: true })).toHaveValue('3');

      // Tab to Save and press Enter.
      const save = sheet.getByRole('button', { name: 'Save', exact: true });
      for (let step = 0; step < 6 && !(await save.evaluate((node) => node === document.activeElement)); step += 1) {
        await a.page.keyboard.press('Tab');
      }
      await expect(save).toBeFocused();
      await a.page.keyboard.press('Enter');
      await expect(sheet).toHaveCount(0);

      await expect.poll(async () => (await itemRef.get()).data()?.name).toBe('E2E apricot jam');
      const edited = (await itemRef.get()).data()!;
      expect(edited.quantity).toBe(3);
      expect(edited.nameKey).toBe('e2e apricot jam');
      expect(edited.editedByUid).toBeTruthy();
      expect(edited.editedAt).toBeTruthy();
      // Focus returns to the row's Edit control.
      const renamedEdit = a.page.getByRole('button', { name: 'Edit E2E apricot jam', exact: true });
      await expect(renamedEdit).toBeFocused();
      // ... and also after Escape.
      await a.page.keyboard.press('Enter');
      await expect(a.page.getByRole('dialog', { name: 'Edit E2E apricot jam' })).toBeVisible();
      await a.page.keyboard.press('Escape');
      await expect(a.page.getByRole('dialog', { name: 'Edit E2E apricot jam' })).toHaveCount(0);
      await expect(renamedEdit).toBeFocused();
    } finally {
      await a.context.close();
    }
  });
});
