import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, type CollectionReference } from 'firebase-admin/firestore';
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
      await page.getByRole('button', { name: 'Open List: Weekly Groceries' }).click();
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
      await expect(page.getByRole('button', { name: 'Open List: Weekly Groceries' })).toBeVisible();
      await expect(page.getByText(/\d+ to buy/).first()).toBeVisible();
    } finally {
      await apples.update({ status: 'needed' });
    }
  });

  test('undo from a list that is no longer open keeps the open list on screen', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const apples = groceryItems.doc('apples');
    await apples.update({ status: 'needed' });
    try {
      await open(page, '/shopping');
      await page.getByRole('button', { name: 'Open List: Weekly Groceries' }).click();
      await page.locator('#item-needed-apples').click();
      await expect.poll(async () => (await apples.get()).data()?.status).toBe('purchased');

      // In-app switch (no reload), so the Undo toast from Weekly Groceries is still showing.
      await page.getByRole('button', { name: 'Back to all lists' }).click();
      await page.getByRole('button', { name: 'Open List: Hardware Run' }).click();
      await expect(page.getByRole('heading', { name: 'Hardware Run', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Undo' }).click();

      // The undo lands on Weekly Groceries ...
      await expect.poll(async () => (await apples.get()).data()?.status).toBe('needed');
      // ... and Hardware Run still shows its own items, not Weekly Groceries'.
      await expect(page.getByRole('heading', { name: 'Hardware Run', exact: true })).toBeVisible();
      await expect(page.getByRole('checkbox', { name: /HVAC filters/ })).toBeVisible();
      await expect(page.locator('#item-needed-apples, #item-purchased-apples')).toHaveCount(0);
      await expect(page.getByRole('checkbox', { name: /Whole milk/ })).toHaveCount(0);
    } finally {
      await apples.update({ status: 'needed' });
    }
  });

  test('undoing a delete from a list that is no longer open restores it there only', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const apples = groceryItems.doc('apples');
    const original = (await apples.get()).data()!;
    try {
      await open(page, '/shopping');
      await page.getByRole('button', { name: 'Open List: Weekly Groceries' }).click();
      // Delete lives in the item's edit sheet (SH-13b).
      await page.getByRole('button', { name: 'Edit Honeycrisp apples', exact: true }).click();
      await page.getByRole('dialog', { name: 'Edit Honeycrisp apples' }).getByRole('button', { name: 'Delete', exact: true }).click();
      await expect.poll(async () => (await apples.get()).exists).toBe(false);

      await page.getByRole('button', { name: 'Back to all lists' }).click();
      await page.getByRole('button', { name: 'Open List: Hardware Run' }).click();
      await expect(page.getByRole('heading', { name: 'Hardware Run', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Undo' }).click();

      await expect.poll(async () => (await apples.get()).exists).toBe(true);
      await expect(page.getByRole('checkbox', { name: /HVAC filters/ })).toBeVisible();
      await expect(page.locator('#item-needed-apples, #item-purchased-apples')).toHaveCount(0);
    } finally {
      await apples.set(original);
    }
  });

  test('clear purchased removes only the confirmed items and asks to delete the list only when it is really empty', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const listId = 'e2e-clear-list';
    const listRef = lists.doc(listId);
    await listRef.set({ name: 'E2E Clear', description: '', icon: 'ShoppingCart', type: 'Custom', color: 'tint-3' });
    await listRef.collection('items').doc('done').set({ name: 'E2E cleared item', quantity: 1, category: 'Other', status: 'purchased', createdAt: fixedNow });
    await listRef.collection('items').doc('late').set({ name: 'E2E late item', quantity: 1, category: 'Other', status: 'needed', createdAt: fixedNow });
    try {
      await open(page, `/shopping?list=${listId}`);
      await expect(page.locator('#item-needed-late')).toBeVisible();
      await page.getByRole('button', { name: 'Clear', exact: true }).click();
      const confirm = page.getByRole('alertdialog', { name: /Clear 1 purchased item/ });
      await expect(confirm).toBeVisible();
      // Another member ticks the remaining item while the dialog is open.
      await listRef.collection('items').doc('late').update({ status: 'purchased' });
      await confirm.getByRole('button', { name: 'Clear Purchased' }).click();

      await expect.poll(async () => (await listRef.collection('items').doc('done').get()).exists).toBe(false);
      // The item ticked meanwhile was not part of the confirmed clear: it stays, and the
      // list is not empty, so there is no "delete this list" prompt.
      expect((await listRef.collection('items').doc('late').get()).exists).toBe(true);
      await expect(page.getByRole('alertdialog', { name: 'Delete Empty List?' })).toHaveCount(0);
      await expect(page.getByText(/^Purchased \(1\)/)).toBeVisible();
    } finally {
      await Promise.all(['done', 'late'].map((id) => listRef.collection('items').doc(id).delete()));
      await listRef.delete();
    }
  });

  test('an addition never merges into an item another member already bought', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const name = 'E2E stale bread';
    await deleteWhere(groceryItems, name);
    try {
      await open(page, '/shopping?list=weekly-groceries');
      const field = page.getByLabel('Items to add to Weekly Groceries');
      await field.fill(name);
      await field.press('Enter');
      await expect(page.getByRole('checkbox', { name: /E2E stale bread/ })).toBeVisible();
      await expect(field).toHaveValue('');

      // Another member buys it; the live list moves it out of Needed (SH-1).
      const [created] = (await groceryItems.where('name', '==', name).get()).docs;
      await created.ref.update({ status: 'purchased' });
      await expect(page.locator(`#item-needed-${created.id}`)).toHaveCount(0);

      await field.fill(name);
      await field.press('Enter');
      await expect.poll(async () => {
        const snapshot = await groceryItems.where('name', '==', name).get();
        return snapshot.docs.map((document) => `${document.data().status}:${document.data().quantity}`).sort();
      }).toEqual(['needed:1', 'purchased:1']);
    } finally {
      await deleteWhere(groceryItems, name);
    }
  });

  test('a quick-add where one entry fails keeps only that entry for retry', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const mergeName = 'E2E fail merge';
    const freshName = 'E2E fresh item';
    await Promise.all([deleteWhere(groceryItems, mergeName), deleteWhere(groceryItems, freshName)]);
    const target = groceryItems.doc('e2e-fail-merge');
    await target.set({ name: mergeName, quantity: 1, category: 'Other', status: 'needed', createdAt: fixedNow });
    // Merges run as Firestore transactions (REST commit), plain creates use the write
    // stream: failing only transaction RPCs makes exactly the merge entry fail.
    const transactionRpc = /:(beginTransaction|commit|batchGet)\b/;
    try {
      await open(page, '/shopping?list=weekly-groceries');
      await expect(page.locator('#item-needed-e2e-fail-merge')).toBeVisible();
      await page.route(transactionRpc, (route) => route.abort('failed'));
      const field = page.getByLabel('Items to add to Weekly Groceries');
      await field.fill(`${mergeName}, ${freshName}`);
      await field.press('Enter');

      await expect(field).toHaveValue(mergeName, { timeout: 30_000 });
      await expect(page.getByRole('alert').filter({ hasText: `Couldn't add ${mergeName}` })).toBeVisible();
      await expect(page.getByRole('checkbox', { name: new RegExp(freshName) })).toBeVisible();
      expect((await target.get()).data()?.quantity).toBe(1);

      // Retry adds only the failed entry: the saved one is not duplicated.
      await page.unroute(transactionRpc);
      await field.press('Enter');
      await expect(field).toHaveValue('');
      await expect.poll(async () => (await target.get()).data()?.quantity).toBe(2);
      expect((await groceryItems.where('name', '==', freshName).get()).size).toBe(1);
    } finally {
      await page.unroute(transactionRpc).catch(() => undefined);
      await Promise.all([deleteWhere(groceryItems, mergeName), deleteWhere(groceryItems, freshName)]);
    }
  });

  test('add to pantry, then clear credits only items still purchased when it commits', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const listId = 'e2e-handoff-list';
    const listRef = lists.doc(listId);
    const kept = 'E2E handoff cheese';
    const unticked = 'E2E handoff crackers';
    await listRef.set({ name: 'E2E Handoff', description: '', icon: 'ShoppingCart', type: 'Grocery', color: 'tint-2' });
    await listRef.collection('items').doc('cheese').set({ name: kept, quantity: 2, category: 'Dairy', status: 'purchased', createdAt: fixedNow });
    await listRef.collection('items').doc('crackers').set({ name: unticked, quantity: 1, category: 'Snacks', status: 'purchased', createdAt: fixedNow });
    try {
      await open(page, `/shopping?list=${listId}`);
      await page.getByRole('button', { name: 'Clear', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Add to pantry, then clear' }).click();
      const handoff = page.getByRole('dialog', { name: 'Add to pantry' });
      await expect(handoff.getByText(unticked)).toBeVisible();

      // Another member un-ticks one item while the dialog is open.
      await listRef.collection('items').doc('crackers').update({ status: 'needed' });
      await handoff.getByRole('button', { name: /^Add and clear \(2 items\)$/ }).click();
      await expect(handoff).toHaveCount(0);

      await expect.poll(async () => (await pantry.where('name', '==', kept).get()).docs.map((d) => d.data().quantity)).toEqual([2]);
      expect((await pantry.where('name', '==', unticked).get()).size).toBe(0);
      expect((await listRef.collection('items').doc('cheese').get()).exists).toBe(false);
      expect((await listRef.collection('items').doc('crackers').get()).data()?.status).toBe('needed');
      await expect(page.locator('#item-needed-crackers')).toBeVisible();
    } finally {
      await Promise.all([deleteWhere(pantry, kept), deleteWhere(pantry, unticked)]);
      await Promise.all(['cheese', 'crackers'].map((id) => listRef.collection('items').doc(id).delete()));
      await listRef.delete();
    }
  });

  test('text typed while a quick-add is saving is new input and nothing is added twice', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const slow = 'E2E slow merge';
    const later = 'E2E typed later';
    await Promise.all([deleteWhere(groceryItems, slow), deleteWhere(groceryItems, later)]);
    const target = groceryItems.doc('e2e-slow-merge');
    await target.set({ name: slow, quantity: 1, category: 'Other', status: 'needed', createdAt: fixedNow });
    // The merge is a transaction (REST RPCs): hold those for a moment so the save stays pending.
    const transactionRpc = /:(beginTransaction|commit|batchGet)\b/;
    try {
      await open(page, '/shopping?list=weekly-groceries');
      await expect(page.locator('#item-needed-e2e-slow-merge')).toBeVisible();
      await page.route(transactionRpc, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.continue();
      });
      const field = page.getByLabel('Items to add to Weekly Groceries');
      await field.fill(slow);
      await field.press('Enter');
      // Cleared at once; the save is still running.
      await expect(field).toHaveValue('');
      await expect(page.getByRole('form', { name: 'Quick add to Weekly Groceries' })).toHaveAttribute('aria-busy', 'true');

      // Typing while it saves, and pressing Enter, neither re-adds nor loses anything.
      await field.pressSequentially(`, ${later}`);
      await field.press('Enter');
      await expect(page.getByRole('form', { name: 'Quick add to Weekly Groceries' })).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
      await expect(field).toHaveValue(`, ${later}`);
      await expect(field).toBeFocused();
      await expect.poll(async () => (await target.get()).data()?.quantity).toBe(2);

      await page.unroute(transactionRpc);
      await field.press('Enter');
      await expect(field).toHaveValue('');
      await expect.poll(async () => (await groceryItems.where('name', '==', later).get()).size).toBe(1);
      expect((await target.get()).data()?.quantity).toBe(2);
    } finally {
      await page.unroute(transactionRpc).catch(() => undefined);
      await Promise.all([deleteWhere(groceryItems, slow), deleteWhere(groceryItems, later)]);
    }
  });

  test('header navigation to /shopping resets the open tab and list to match the URL', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/shopping?tab=pantry');
    await expect(page.getByRole('tab', { name: 'Pantry Inventory' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('banner').getByRole('link', { name: 'Shopping', exact: true }).click();
    await expect(page).toHaveURL(/\/shopping$/);
    await expect(page.getByRole('tab', { name: 'Shopping Lists' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Open List: Weekly Groceries' })).toBeVisible();

    await page.getByRole('button', { name: 'Open List: Weekly Groceries' }).click();
    await expect(page).toHaveURL(/[?&]list=weekly-groceries/);
    await page.getByRole('banner').getByRole('link', { name: 'Shopping', exact: true }).click();
    await expect(page).toHaveURL(/\/shopping$/);
    await expect(page.getByRole('button', { name: 'Open List: Weekly Groceries' })).toBeVisible();
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

  test('H12/H28: a list card morphs into the open list and back; Add Item shows its shortcut', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/shopping');
    // Record the shared-element names present when each view transition starts.
    await page.evaluate(() => {
      const w = window as unknown as { __morphs: string[] };
      w.__morphs = [];
      const start = document.startViewTransition?.bind(document);
      if (!start) return;
      document.startViewTransition = ((update: () => void) => {
        w.__morphs.push([...document.querySelectorAll<HTMLElement>('*')].map((el) => el.style.viewTransitionName).filter(Boolean).join(','));
        return start(update);
      }) as typeof document.startViewTransition;
    });
    const morphs = () => page.evaluate(() => (window as unknown as { __morphs: string[] }).__morphs);

    await page.getByRole('button', { name: 'Open List: Weekly Groceries' }).click();
    await expect(page).toHaveURL(/[?&]list=weekly-groceries/);
    await expect(page.getByTestId('open-list')).toBeVisible();
    expect(await morphs()).toEqual(['list-weekly-groceries-card']);
    const addItem = page.getByRole('button', { name: 'Add Item' });
    await expect(addItem).toHaveAttribute('aria-keyshortcuts', 'A');
    await addItem.hover();
    await expect(page.getByTestId('shortcut-hint-add-item')).toContainText('Add an item from anywhere');
    await page.mouse.move(0, 0);

    await page.getByRole('button', { name: 'Back to all lists' }).click();
    await expect(page.getByRole('button', { name: 'Open List: Weekly Groceries' })).toBeVisible();
    expect(await morphs()).toEqual(['list-weekly-groceries-card', 'list-weekly-groceries-card']);
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('*')].filter((el) => el.style.viewTransitionName).length)).toBe(0);
  });

  test('H12: reduced motion opens a list with no view transition', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, '/shopping');
    await page.evaluate(() => {
      const w = window as unknown as { __morphCount: number };
      w.__morphCount = 0;
      const start = document.startViewTransition?.bind(document);
      if (!start) return;
      document.startViewTransition = ((update: () => void) => {
        w.__morphCount += 1;
        return start(update);
      }) as typeof document.startViewTransition;
    });
    await page.getByRole('button', { name: 'Open List: Weekly Groceries' }).click();
    await expect(page.getByTestId('open-list')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __morphCount: number }).__morphCount)).toBe(0);
  });

  test('switching tabs keeps the page width steady and lists use token tints', async ({ page }) => {
    await open(page, '/shopping');
    await expect(page.getByRole('button', { name: 'Open List: Weekly Groceries' })).toBeVisible();
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
  test('H08: the recipe lifts its tiles in view first, then the card flips in', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/shopping?tab=pantry');
    await expect(page.getByTestId('pantry-shelves')).toBeVisible();
    // Watch the order: tiles lift while the dialog and its scrim are transparent, then the card appears.
    await page.evaluate(() => {
      const w = window as unknown as { __recipe: Array<{ event: string; at: number; scrim?: string }> };
      w.__recipe = [];
      const observer = new MutationObserver(() => {
        const has = (event: string) => w.__recipe.some((entry) => entry.event === event);
        if (!has('lifted') && document.querySelector('[data-lifted="true"]')) {
          const content = document.querySelector('[data-recipe-phase]');
          const scrim = content?.previousElementSibling as HTMLElement | null;
          w.__recipe.push({ event: 'lifted', at: performance.now(), scrim: content?.getAttribute('data-recipe-phase') + ':' + (scrim ? scrim.className.includes('opacity-0') : 'none') });
        }
        if (!has('card') && document.querySelector('[data-testid="recipe-card"]')) w.__recipe.push({ event: 'card', at: performance.now() });
      });
      observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    });
    await page.getByRole('button', { name: 'Generate Recipe' }).click();
    const dialog = page.getByRole('dialog', { name: 'AI Recipe Idea' });
    await expect(dialog.getByTestId('recipe-card')).toBeVisible();
    await expect(page.locator('[data-lifted="true"]').first()).toBeVisible();
    const events = await page.evaluate(() => (window as unknown as { __recipe: Array<{ event: string; at: number; scrim?: string }> }).__recipe);
    expect(events.map((entry) => entry.event)).toEqual(['lifted', 'card']);
    expect(events[0].scrim).toBe('lifting:true');
    expect(events[1].at - events[0].at).toBeGreaterThanOrEqual(300);
    await page.keyboard.press('Escape');
  });

  test('H08: under reduced motion the recipe card shows at once', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, '/shopping?tab=pantry');
    await page.getByRole('button', { name: 'Generate Recipe' }).click();
    const dialog = page.getByRole('dialog', { name: 'AI Recipe Idea' });
    await expect(dialog.getByTestId('recipe-card')).toBeVisible();
    await expect(dialog).toHaveAttribute('data-recipe-phase', 'shown');
    await page.keyboard.press('Escape');
  });

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

test.describe('list templates and peeks', () => {
  test('list-template tiles have accessible names', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/shopping');
    await page.getByRole('button', { name: 'Create New List' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create New List' });
    await expect(dialog).toBeVisible();
    for (const name of ['Groceries', 'Auto', 'Hardware', 'Pet Supplies']) {
      await expect(dialog.getByRole('button', { name: `Create a ${name} list`, exact: true })).toBeVisible();
    }
    await expect(dialog.getByRole('button', { name: 'Custom list', exact: true })).toBeVisible();
    // Nothing is created by looking: close without choosing.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('H26: Open List and a saved item link show peek cards on hover', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const apples = groceryItems.doc('apples');
    await apples.update({ status: 'needed', sourceUrl: 'https://www.example.com/honeycrisp' });
    try {
      await open(page, '/shopping');
      const peek = page.locator('[data-peek-card]');
      const openList = page.getByRole('button', { name: 'Open List: Weekly Groceries' });
      await openList.hover();
      await expect(peek).toBeVisible();
      await expect(peek).toContainText('Weekly Groceries');
      await expect(peek).toContainText('Grocery list');

      // Pressing closes the card; the list opens.
      await openList.click();
      await expect(page).toHaveURL(/[?&]list=weekly-groceries/);
      await expect(peek).toHaveCount(0);

      const link = page.getByRole('link', { name: 'Open saved link for Honeycrisp apples' });
      await link.hover();
      await expect(peek).toBeVisible();
      await expect(peek).toContainText('Honeycrisp apples');
      await expect(peek).toContainText('Produce');
      await expect(peek).toContainText('Opens example.com');
    } finally {
      await apples.update({ status: 'needed', sourceUrl: FieldValue.delete() });
    }
  });
});
