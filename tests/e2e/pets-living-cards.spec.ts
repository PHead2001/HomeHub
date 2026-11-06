import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';

const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const ownerUid = 'e2e-owner-uid';
const adminApp = getApps().find((app) => app.name === 'pets-living-cards')
  || initializeApp({ projectId }, 'pets-living-cards');
const household = getFirestore(adminApp).collection('households').doc(householdId);

const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');
const SEEDED_FEEDING = 'morning-feed';
const TEST_PET = 'e2e-tweety';

async function openPets(page: Page) {
  await page.clock.setFixedTime(fixedNow);
  await page.goto('/pets');
  await expect(page.getByRole('heading', { name: 'Your Pets', exact: true })).toBeVisible();
}

/** Removes anything these tests wrote, leaving the seeded pet data as it was. */
async function restorePetsSeed() {
  for (const petId of ['maple', 'pixel']) {
    const logs = await household.collection('pets').doc(petId).collection('feeding-logs').get();
    await Promise.all(logs.docs.filter((entry) => entry.id !== SEEDED_FEEDING).map((entry) => entry.ref.delete()));
  }
  await household.collection('pets').doc('pixel').collection('medication-logs').doc('flea-prevention')
    .update({ nextDueDate: FieldValue.delete() }).catch(() => undefined);
  await household.collection('pets').doc(TEST_PET).delete();
}

test.describe('pets: living cards (H09, D17, section 3)', () => {
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.project.name === 'desktop-chromium') await restorePetsSeed();
  });

  test('Add Pet sits in the header row', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openPets(page);
    const heading = page.getByRole('heading', { name: 'Your Pets', exact: true });
    // The header row holds the title block (heading + subtitle) and the actions.
    const row = await heading.locator('xpath=../..').boundingBox();
    const title = await heading.boundingBox();
    const add = await page.getByRole('button', { name: 'Add Pet' }).boundingBox();
    expect(row && title && add).toBeTruthy();
    // Same row: the button's vertical centre falls within the header row, level with the title.
    const addCentre = add!.y + add!.height / 2;
    expect(addCentre).toBeGreaterThanOrEqual(row!.y);
    expect(addCentre).toBeLessThanOrEqual(row!.y + row!.height);
    expect(add!.y).toBeLessThan(title!.y + title!.height);
    // Right-aligned in the row.
    expect(Math.abs(add!.x + add!.width - (row!.x + row!.width))).toBeLessThanOrEqual(1);
    expect(add!.x).toBeGreaterThan(row!.x + row!.width / 2);
  });

  test('cards show who fed last, the daily ring and one-tap feeding', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openPets(page);
    const maple = page.getByTestId('pet-card-maple');
    await expect(maple).toContainText('Fed just now');
    await expect(maple).toContainText('1 of 2 today');

    const pixel = page.getByTestId('pet-card-pixel');
    await expect(pixel).toContainText('No feedings logged yet');
    await pixel.getByRole('button', { name: 'Feed Pixel, 1 can' }).click();
    await expect(page.getByText('Pixel fed', { exact: true })).toBeVisible();
    await expect(pixel).toContainText('Fed just now by Alex');
    await expect(pixel).toContainText('1 of 2 today');

    await expect.poll(async () => {
      const logs = await household.collection('pets').doc('pixel').collection('feeding-logs').get();
      return logs.docs.map((entry) => entry.data()).map(({ cups, foodAmountType, loggedByUid }) => ({ cups, foodAmountType, loggedByUid }));
    }).toEqual([{ cups: 1, foodAmountType: 'Cans', loggedByUid: ownerUid }]);

    // The second feeding completes the day.
    await pixel.getByRole('button', { name: 'Feed Pixel, 1 can' }).click();
    // Radix also mirrors the toast into its own live region; target the visible title.
    await expect(page.getByText('Pixel is all fed for today', { exact: true })).toBeVisible();
    await expect(pixel).toContainText('All fed today');
  });

  test('the next medication shows a countdown chip', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await household.collection('pets').doc('pixel').collection('medication-logs').doc('flea-prevention')
      .update({ nextDueDate: '2026-08-03' });
    await openPets(page);
    await expect(page.getByTestId('pet-card-pixel')).toContainText('Monthly flea prevention');
    await expect(page.getByTestId('pet-card-pixel')).toContainText('Due in 2 days');
  });

  test('pets without a photo get species art', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await household.collection('pets').doc(TEST_PET).set({
      name: 'Tweety', type: 'Bird', photoUrl: 'https://placehold.co/300x300.png', dataAiHint: 'bird', foodSchedule: 'One scoop each morning',
    });
    await openPets(page);
    const card = page.getByTestId(`pet-card-${TEST_PET}`);
    await expect(card.getByRole('img', { name: 'Tweety, bird illustration' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Feed Tweety, 1 scoop' })).toBeVisible();
    // Seeded pets keep their photo through next/image with a face-safe crop.
    await expect(page.getByRole('img', { name: 'Photo of Maple' })).toHaveCSS('object-position', '50% 35%');
  });

  test('add pet shows inline field errors, not toasts', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openPets(page);
    await page.getByRole('button', { name: 'Add Pet' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a new pet' });
    await dialog.getByRole('button', { name: 'Save Pet' }).click();
    await expect(dialog.getByText('Give your pet a name.')).toBeVisible();
    await expect(dialog.getByLabel('Name')).toBeFocused();
    await expect(dialog.getByLabel('Name')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('status').filter({ hasText: 'Missing Information' })).toHaveCount(0);

    await dialog.getByLabel('Name').fill('maple');
    await expect(dialog.getByText('You already have a pet named maple.')).toBeVisible();
    await dialog.getByLabel('Feedings per day').fill('0');
    await expect(dialog.getByText('Use a whole number from 1 to 12.')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('edit dialog: removing the photo does not submit, and reopening discards the draft', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openPets(page);
    const openEdit = async () => {
      await page.getByRole('button', { name: 'Open actions for Maple' }).click();
      await page.getByRole('menuitem', { name: 'Edit' }).click();
      return page.getByRole('dialog', { name: 'Edit Maple' });
    };
    let dialog = await openEdit();
    await dialog.getByRole('button', { name: /^Remove photo preview for Maple/i }).click();
    // Still open: removal is a draft change until Save Changes.
    await expect(dialog).toBeVisible();
    await expect(page.getByText('Pet updated', { exact: true })).toHaveCount(0);
    await dialog.getByLabel('Food schedule').fill('Draft schedule that is discarded');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    dialog = await openEdit();
    await expect(dialog.getByLabel('Food schedule')).toHaveValue('1.5 cups twice daily');
    await expect(dialog.getByRole('img', { name: /Photo preview for Maple/i })).toBeVisible();
    await page.keyboard.press('Escape');
    expect((await household.collection('pets').doc('maple').get()).data()?.photoUrl).toBe('/favicon.ico');
  });

  test('detail page puts history first, shows who logged and defaults to the planned portion', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await page.clock.setFixedTime(fixedNow);
    await page.goto('/pets/maple');
    await expect(page.getByRole('heading', { name: 'Maple', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Feed Maple, 1.5 cups' }).click();
    await expect(page.getByText('by Alex').first()).toBeVisible();
    await expect(page.getByText('1.5 cups of dry food').first()).toBeVisible();

    await page.getByRole('button', { name: 'Log with details' }).click();
    const form = page.getByRole('form', { name: 'Log a feeding with details' });
    await expect(form.getByLabel('Amount')).toHaveValue('1.5');

    await page.goto('/pets/pixel?tab=medication');
    await expect(page.getByRole('tab', { name: 'Medication' })).toHaveAttribute('aria-selected', 'true');
  });

  test('members without pet permissions see no edit or log controls', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:9002', colorScheme: 'dark' });
    const page = await context.newPage();
    await page.clock.setFixedTime(fixedNow);
    await page.goto('/e2e-login?uid=e2e-limited-uid');
    await expect(page).toHaveURL('/');
    await openPets(page);
    await expect(page.getByTestId('pet-card-maple')).toContainText('Fed just now');
    await expect(page.getByRole('button', { name: 'Add Pet' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open actions for Maple' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Feed / })).toHaveCount(0);

    await page.goto('/pets/maple');
    await expect(page.getByRole('heading', { name: 'Maple', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Log with details' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Delete feeding log/ })).toHaveCount(0);
    await context.close();
  });
});
