import { expect, test, type Page } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';

const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const adminApp = getApps().find((app) => app.name === 'ai-openai-e2e')
  || initializeApp({ projectId }, 'ai-openai-e2e');
const adminDb = getFirestore(adminApp);
const household = adminDb.collection('households').doc(householdId);
const groceryItems = household.collection('shopping-lists').doc('weekly-groceries').collection('items');

const originalPantry = {
  rice: { name: 'Jasmine rice', quantity: 4, unit: 'lbs', location: 'Pantry', expiryDate: '2027-02-01' },
  yogurt: { name: 'Greek yogurt', quantity: 3, unit: 'items', location: 'Fridge', expiryDate: '2026-08-04' },
  berries: { name: 'Frozen berries', quantity: 2, unit: 'bags', location: 'Freezer', expiryDate: '2026-12-15' },
};
const originalMaintenanceNotes = 'System operational; filter replacement due soon.';

async function openAuthenticated(page: Page, path: string, heading: string) {
  await page.clock.setFixedTime(fixedNow);
  await page.goto(path);
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  await expect(page.getByText('Sign in with Google', { exact: false })).toHaveCount(0);
}

async function cleanupShoppingItems() {
  for (const name of [
    'E2E AI milk',
    'E2E AI zorblax',
    'AI-TEST:provider-error mystery tin',
    'AI-TEST:timeout mystery meal',
    'AI-TEST:provider-error manual category',
    'E2E Yogurt Multipack',
    // The deterministic recipe's missing ingredients (SH-22c/d).
    'Salt',
    'Pepper',
    'Cooking oil',
    'Fresh basil',
  ]) {
    const snapshot = await groceryItems.where('name', '==', name).get();
    await Promise.all(snapshot.docs.map(document => document.ref.delete()));
  }
}

async function restoreAiFixtures() {
  await Promise.all([
    ...Object.entries(originalPantry).map(([id, data]) => household.collection('pantry-inventory').doc(id).set(data)),
    household.collection('maintenance').doc('hvac-inspection').update({ notes: originalMaintenanceNotes }),
    cleanupShoppingItems(),
  ]);
}

async function addShoppingItem(page: Page, name: string, category?: string) {
  await page.getByRole('button', { name: 'Add Item' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Item to List' });
  await dialog.getByLabel('Item Name').fill(name);
  if (category) {
    await dialog.getByLabel('Category').click();
    await page.getByRole('option', { name: category, exact: true }).click();
  }
  await dialog.getByRole('button', { name: 'Add to List' }).click();
  await expect(page.getByRole('checkbox', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })).toBeVisible();
}

test.describe('OpenAI migration workflows', () => {
  test.beforeEach(async () => restoreAiFixtures());
  test.afterEach(async () => restoreAiFixtures());

  test('shopping categorization succeeds and all fallback paths save exactly once', async ({ page }) => {
    await openAuthenticated(page, '/shopping', 'Shopping Center');
    await page.getByRole('button', { name: 'Open List: Weekly Groceries' }).click();

    // QA-6: items save at once; "milk" is known locally, an unknown name waits for
    // one batched AI call, and a failed or timed-out call leaves it under Other.
    await addShoppingItem(page, 'E2E AI milk');
    await addShoppingItem(page, 'E2E AI zorblax');
    await addShoppingItem(page, 'AI-TEST:provider-error mystery tin');
    await expect(page.getByText('Item saved to Other', { exact: true })).toBeVisible();
    await addShoppingItem(page, 'AI-TEST:timeout mystery meal');
    await addShoppingItem(page, 'AI-TEST:provider-error manual category', 'Dairy');

    const expected = [
      ['E2E AI milk', 'Dairy', 'local'],
      // The deterministic model picks the list's first non-Other category.
      ['E2E AI zorblax', 'Produce', 'ai'],
      ['AI-TEST:provider-error mystery tin', 'Other', 'pending'],
      ['AI-TEST:timeout mystery meal', 'Other', 'pending'],
      ['AI-TEST:provider-error manual category', 'Dairy', 'manual'],
    ];
    for (const [name, category, source] of expected) {
      await expect.poll(async () => {
        const snapshot = await groceryItems.where('name', '==', name).get();
        return snapshot.docs.map((document) => `${document.data().category}/${document.data().categorySource}`);
      }, { timeout: 15_000 }).toEqual([`${category}/${source}`]);
      const [document] = (await groceryItems.where('name', '==', name).get()).docs;
      expect(typeof document.data().addedByUid).toBe('string');
      expect(document.data().nameKey).toBe(name.toLowerCase());
    }

    // The open list is in the URL (?list=weekly-groceries), so a reload keeps it open.
    await page.reload();
    await expect(page).toHaveURL(/[?&]list=weekly-groceries(&|$)/);
    await expect(page.getByRole('checkbox', { name: /E2E AI milk/ })).toBeVisible();
  });

  test('a barcode scan adds one package with its size as a note, and a second scan adds 1 (BL-1)', async ({ page }) => {
    await openAuthenticated(page, '/shopping', 'Shopping Center');
    await page.getByRole('button', { name: 'Open List: Weekly Groceries' }).click();
    const scanInto = async () => {
      await page.getByRole('button', { name: 'Add Item' }).click();
      const dialog = page.getByRole('dialog', { name: 'Add Item to List' });
      await dialog.getByRole('button', { name: 'Scan Barcode' }).click();
      const scanner = page.getByRole('dialog', { name: 'Scan Barcode' });
      await scanner.getByLabel('Barcode number').fill('009900045000');
      await scanner.getByRole('button', { name: 'Use barcode' }).click();
    };
    await scanInto();
    await expect.poll(async () => (await groceryItems.where('name', '==', 'E2E Yogurt Multipack').get()).docs
      .map((document) => [document.data().quantity, document.data().size, document.data().sizeUnit]), { timeout: 15_000 })
      .toEqual([[1, 450, 'g']]);
    await expect(page.getByText('450 g')).toBeVisible();
    await scanInto();
    await expect.poll(async () => (await groceryItems.where('name', '==', 'E2E Yogurt Multipack').get()).docs
      .map((document) => document.data().quantity), { timeout: 15_000 })
      .toEqual([2]);
  });

  test('recipe generation renders structured output and retryable sanitized failures', async ({ page }) => {
    await openAuthenticated(page, '/shopping', 'Shopping Center');
    await page.getByRole('tab', { name: 'Inventory' }).click();
    await page.getByRole('button', { name: 'Generate Recipe' }).click();
    let dialog = page.getByRole('dialog', { name: 'AI Recipe Idea' });
    await expect(dialog.getByRole('heading', { name: / Skillet$/ })).toBeVisible();
    await expect(dialog.getByText('Instructions')).toBeVisible();
    await page.keyboard.press('Escape');

    for (const [scenario, expectedMessage] of [
      ['timeout', 'AI took too long to respond.'],
      ['rate-limit', 'AI is receiving too many requests.'],
      ['malformed', 'AI returned an invalid response.'],
      ['provider-error', 'AI is temporarily unavailable.'],
    ]) {
      await Promise.all(Object.keys(originalPantry).map(id => household.collection('pantry-inventory').doc(id).update({
        name: `AI-TEST:${scenario} ${originalPantry[id as keyof typeof originalPantry].name}`,
      })));
      await page.reload();
      await page.getByRole('tab', { name: 'Inventory' }).click();
      // The recipe is requested once, from the pantry as it is when the dialog
      // opens: wait for the renamed stock before opening it.
      await expect(page.getByText(`AI-TEST:${scenario} Jasmine rice`).first()).toBeVisible();
      await page.getByRole('button', { name: 'Generate Recipe' }).click();
      dialog = page.getByRole('dialog', { name: 'AI Recipe Idea' });
      await expect(dialog.getByRole('alert')).toContainText(expectedMessage);
      await expect(dialog.getByRole('button', { name: 'Try Again' })).toBeVisible();
      await page.keyboard.press('Escape');
    }

    await household.collection('pantry-inventory').doc('rice').set(originalPantry.rice);
    await Promise.all([
      household.collection('pantry-inventory').doc('yogurt').delete(),
      household.collection('pantry-inventory').doc('berries').delete(),
    ]);
    await page.reload();
    await page.getByRole('tab', { name: 'Inventory' }).click();
    // One usable item: the server rejects fewer than two, so the button is disabled
    // (Pantry v2) instead of sending a request that can only fail.
    await expect(page.getByText('Jasmine rice', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Greek yogurt|Frozen berries/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Generate Recipe' })).toBeDisabled();
  });

  test('the recipe uses what goes off first and adds missing ingredients to the Grocery list (SH-31, SH-22c/d)', async ({ page }) => {
    // Salt is already needed on the only Grocery list: its "+" raises it instead of adding a second Salt.
    await groceryItems.doc('e2e-recipe-salt').set({
      name: 'Salt', nameKey: 'salt', quantity: 1, category: 'Pantry', status: 'needed', createdAt: fixedNow,
    });
    const quantities = async (name: string) => (await groceryItems.where('name', '==', name).get()).docs
      .map((document) => [document.data().quantity, document.data().status]);

    await openAuthenticated(page, '/shopping', 'Shopping Center');
    await page.getByRole('tab', { name: 'Inventory' }).click();
    await page.getByRole('button', { name: 'Generate Recipe' }).click();
    const dialog = page.getByRole('dialog', { name: 'AI Recipe Idea' });
    // SH-31a: stock is sent soonest expiry first (yogurt in 3 days, berries in December,
    // rice next year); the stand-in model builds the recipe from the first two.
    await expect(dialog.getByRole('heading', { name: 'Greek yogurt and Frozen berries Skillet' })).toBeVisible();
    // Amounts on hand come from HomeHub's pantry, not the model.
    const fromPantry = dialog.getByRole('list', { name: 'From your pantry' });
    await expect(fromPantry).toContainText('You have 3 items · Tue (Fridge)');
    await expect(fromPantry).not.toContainText('Fresh basil');

    // The model's "Fresh basil" pantry claim is not stock, so it is listed as missing.
    const missing = dialog.getByTestId('recipe-missing');
    await expect(missing).toContainText('Adds to Weekly Groceries.');
    await expect(missing.getByRole('button', { name: 'Add Fresh basil to the list' })).toBeVisible();

    // SH-22c: one "+" merges into the needed Salt.
    await missing.getByRole('button', { name: 'Add Salt to the list' }).click();
    await expect(missing.getByRole('button', { name: 'Salt added' })).toBeDisabled();
    await expect.poll(() => quantities('Salt'), { timeout: 15_000 }).toEqual([[2, 'needed']]);

    // A live pantry change neither clears the recipe nor re-requests it.
    await household.collection('pantry-inventory').doc('rice').update({ quantity: 5 });
    await expect(dialog.getByRole('heading', { name: 'Greek yogurt and Frozen berries Skillet' })).toBeVisible();
    await expect(missing.getByRole('button', { name: 'Salt added' })).toBeVisible();

    // SH-22d / SH-31b: "Add all missing" adds the rest in one action; Salt is not added again.
    await missing.getByRole('button', { name: 'Add all missing' }).click();
    for (const name of ['Fresh basil', 'Pepper', 'Cooking oil']) {
      await expect(missing.getByRole('button', { name: `${name} added` })).toBeVisible();
      await expect.poll(() => quantities(name), { timeout: 15_000 }).toEqual([[1, 'needed']]);
    }
    expect(await quantities('Salt')).toEqual([[2, 'needed']]);
    await expect(missing.getByRole('button', { name: 'Add all missing' })).toBeDisabled();
    await page.keyboard.press('Escape');
  });

  test('maintenance summaries are transient and provider failures remain retryable', async ({ page }) => {
    await openAuthenticated(page, '/maintenance?log=hvac-inspection', 'Maintenance Center');
    let logCard = page.getByTestId('maintenance-log-hvac-inspection');
    await logCard.getByRole('button', { name: 'Summarize with AI' }).click();
    await expect(logCard.getByText('AI Summary')).toBeVisible();
    await expect(logCard.getByText(/Maintenance summary:/)).toBeVisible();
    expect((await household.collection('maintenance').doc('hvac-inspection').get()).data()?.notes)
      .toBe(originalMaintenanceNotes);

    await page.reload();
    logCard = page.getByTestId('maintenance-log-hvac-inspection');
    await expect(logCard.getByText('AI Summary')).toHaveCount(0);

    for (const [scenario, expectedMessage] of [
      ['timeout', 'AI took too long to respond. Please try again.'],
      ['malformed', 'AI returned an invalid response. Please try again.'],
      ['rate-limit', 'AI is receiving too many requests. Please wait a moment and retry.'],
      ['provider-error', 'AI is temporarily unavailable. Please try again later.'],
    ]) {
      await household.collection('maintenance').doc('hvac-inspection').update({
        notes: `AI-TEST:${scenario} ${originalMaintenanceNotes}`,
      });
      await page.reload();
      logCard = page.getByTestId('maintenance-log-hvac-inspection');
      await logCard.getByRole('button', { name: 'Summarize with AI' }).click();
      await expect(page.getByText('Summary unavailable', { exact: true })).toBeVisible();
      await expect(page.getByText(expectedMessage, { exact: true })).toBeVisible();
    }
  });

  test('barcode library remains usable without an OpenAI key', async ({ page }) => {
    await openAuthenticated(page, '/library', 'Barcode Library');
    await expect(page.getByText('E2E Oat Cereal')).toBeVisible();
    await expect(page.getByText('012345678905')).toBeVisible();
  });
});
