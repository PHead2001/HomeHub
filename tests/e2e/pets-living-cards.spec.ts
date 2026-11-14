import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
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
const EXTRA_MEDS = ['e2e-med-ear', 'e2e-med-joint', 'e2e-med-dental'];

/** One tap feeds (H09, owner decision): the Feed button logs at once; Undo reverses it. */
async function feed(scope: Locator | Page, name: string) {
  await scope.getByRole('button', { name }).click();
}

/** The shared feed operation's "Feed again?" (PE-23): answer it with Feed again. */
async function feedAgain(page: Page, reason: string | RegExp) {
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(reason);
  await dialog.getByRole('button', { name: 'Feed again' }).click();
  await expect(dialog).toHaveCount(0);
}

/**
 * Feedings are stamped with the emulator's (real) server time (PE-5), so tests
 * that log one run the browser at the real time instead of `fixedNow`.
 */
async function useLiveClock(page: Page) {
  await page.clock.setFixedTime(new Date());
}

async function openPets(page: Page) {
  await page.clock.setFixedTime(fixedNow);
  await page.goto('/pets');
  await expect(page.getByRole('heading', { name: 'Your Pets', exact: true })).toBeVisible();
}

/** Removes anything these tests wrote, leaving the seeded pet data as it was. */
async function restorePetsSeed() {
  for (const petId of ['maple', 'pixel', TEST_PET]) {
    const logs = await household.collection('pets').doc(petId).collection('feeding-logs').get();
    await Promise.all(logs.docs.filter((entry) => entry.id !== SEEDED_FEEDING).map((entry) => entry.ref.delete()));
    // The shared feed operation's per-pet state: without this, the next test's first feed would ask "Feed again?".
    await household.collection('pets').doc(petId).collection('feeding-state').doc('current').delete();
  }
  await household.collection('pets').doc('pixel').collection('medication-logs').doc('flea-prevention')
    .update({ nextDueDate: FieldValue.delete() }).catch(() => undefined);
  await Promise.all(EXTRA_MEDS.map((id) => household.collection('pets').doc('pixel').collection('medication-logs').doc(id).delete()));
  const testPetLogs = await household.collection('pets').doc(TEST_PET).collection('feeding-logs').get();
  await Promise.all(testPetLogs.docs.map((entry) => entry.ref.delete()));
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
    const addButton = page.getByRole('button', { name: 'Add Pet' });
    // Measure only once the header has rendered with its action (it appears after
    // permissions load) and the page-enter transition has settled.
    await expect(addButton).toBeVisible();
    // Ambient effects loop forever, so wait for the button itself to stop moving (the
    // page-enter transition) instead of waiting for every animation to end.
    let previous = '';
    await expect.poll(async () => {
      const box = await addButton.boundingBox();
      const current = box ? `${box.x},${box.y}` : '';
      const settled = current !== '' && current === previous;
      previous = current;
      return settled;
    }, { intervals: [100] }).toBe(true);
    // The header row holds the title block (heading + subtitle) and the actions.
    const row = await heading.locator('xpath=../..').boundingBox();
    const title = await heading.boundingBox();
    const add = await addButton.boundingBox();
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
    // From here on feedings carry server time: run the page at the real time.
    await useLiveClock(page);
    await page.reload();
    await expect(pixel).toContainText('No feedings logged yet');
    await feed(pixel, 'Feed Pixel, 1 can');
    await expect(page.getByText('Pixel fed', { exact: true })).toBeVisible();
    await expect(pixel).toContainText('Fed just now by Alex');
    await expect(pixel).toContainText('1 of 2 today');

    await expect.poll(async () => {
      const logs = await household.collection('pets').doc('pixel').collection('feeding-logs').get();
      return logs.docs.map((entry) => entry.data()).map(({ cups, foodAmountType, loggedByUid, repeat }) => ({ cups, foodAmountType, loggedByUid, repeat }));
    }).toEqual([{ cups: 1, foodAmountType: 'Cans', loggedByUid: ownerUid, repeat: 'none' }]);
    await expect.poll(async () => (await household.collection('pets').doc('pixel').collection('feeding-state').doc('current').get()).data()?.countOnDay).toBe(1);

    // The second feeding right after asks first (PE-23), then completes the day.
    await feed(pixel, 'Feed Pixel, 1 can');
    await feedAgain(page, 'You fed Pixel just now.');
    // Radix also mirrors the toast into its own live region; target the visible title.
    await expect(page.getByText('Pixel is all fed for today', { exact: true })).toBeVisible();
    await expect(pixel).toContainText('All fed today');
  });

  test('new feedings show up even behind many legacy ISO-string feedings', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    // Legacy entries stored the date as an ISO string; Firestore orders strings
    // apart from timestamps, so a single ordered, limited query would hide new ones.
    const logs = household.collection('pets').doc('pixel').collection('feeding-logs');
    await Promise.all(Array.from({ length: 25 }, (_, i) => logs.doc(`legacy-${i}`).set({
      date: new Date(Date.UTC(2026, 6, 1 + i, 8)).toISOString(), cups: 1, foodType: 'Wet', foodAmountType: 'Cans', comments: '', ampm: 'AM',
    })));
    await useLiveClock(page);
    await page.goto('/pets');
    const pixel = page.getByTestId('pet-card-pixel');
    await expect(pixel).toContainText('0 of 2 today');
    await feed(pixel, 'Feed Pixel, 1 can');
    await expect(pixel).toContainText('Fed just now by Alex');
    await expect(pixel).toContainText('1 of 2 today');

    await page.goto('/pets/pixel');
    await expect(page.getByText('by Alex').first()).toBeVisible();
  });

  test('the detailed feeding form saves a fractional planned portion', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await household.collection('pets').doc(TEST_PET).set({
      name: 'Tweety', type: 'Bird', photoUrl: 'https://placehold.co/300x300.png', dataAiHint: 'bird', foodSchedule: '1/3 cup twice daily',
    });
    await page.clock.setFixedTime(fixedNow);
    await page.goto(`/pets/${TEST_PET}`);
    await page.getByRole('button', { name: 'Log with details' }).click();
    const form = page.getByRole('form', { name: 'Log a feeding with details' });
    await expect(form.getByLabel('Amount')).toHaveValue('0.33');
    await form.getByLabel('Comments (Optional)').fill('Fractional portion');
    await form.getByRole('button', { name: 'Save feeding' }).click();
    await expect(page.getByText('Feeding logged', { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const saved = await household.collection('pets').doc(TEST_PET).collection('feeding-logs').get();
      return saved.docs.map((entry) => entry.data().cups);
    }).toEqual([0.33]);
  });

  test('the next medication shows a countdown chip', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await household.collection('pets').doc('pixel').collection('medication-logs').doc('flea-prevention')
      .update({ nextDueDate: '2026-08-03' });
    await openPets(page);
    await expect(page.getByTestId('pet-card-pixel')).toContainText('Monthly flea prevention');
    await expect(page.getByTestId('pet-card-pixel')).toContainText('Due in 2 days');
  });

  test('one tap writes a feeding and Undo removes it', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openPets(page);
    const pixel = page.getByTestId('pet-card-pixel');
    const button = pixel.getByRole('button', { name: 'Feed Pixel, 1 can' });
    await expect(button).toHaveAttribute('aria-keyshortcuts', 'F');
    await button.click();
    // No confirmation on the card: the tap logged.
    await expect(page.getByTestId('feed-confirm')).toHaveCount(0);
    await expect(page.getByText('Pixel fed', { exact: true })).toBeVisible();
    await expect.poll(async () => (await household.collection('pets').doc('pixel').collection('feeding-logs').get()).size).toBe(1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await household.collection('pets').doc('pixel').collection('feeding-logs').get()).size).toBe(0);
    await expect(pixel).toContainText('No feedings logged yet');
  });

  test('every current medication gets a chip, most urgent first, with +N overflow', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const meds = household.collection('pets').doc('pixel').collection('medication-logs');
    await meds.doc('flea-prevention').update({ nextDueDate: '2026-08-03' });
    await meds.doc(EXTRA_MEDS[0]).set({ date: '2026-07-30T09:00:00.000Z', medication: 'Ear drops', dosage: '2 drops', notes: '', nextDueDate: '2026-07-31' });
    await openPets(page);
    const chips = page.getByTestId('pet-card-pixel').getByTestId('medication-chips');
    await expect(chips.getByRole('listitem')).toHaveCount(2);
    await expect(chips.getByRole('listitem').first()).toContainText('Ear drops');
    await expect(chips.getByRole('listitem').first()).toContainText('Overdue by 1 day');
    await expect(chips.getByRole('listitem').nth(1)).toContainText('Monthly flea prevention');

    await meds.doc(EXTRA_MEDS[1]).set({ date: '2026-07-30T09:00:00.000Z', medication: 'Joint support', dosage: '1 tab', notes: '', nextDueDate: '2026-08-10' });
    await meds.doc(EXTRA_MEDS[2]).set({ date: '2026-07-30T09:00:00.000Z', medication: 'Dental chew', dosage: '1', notes: '', nextDueDate: '2026-08-20' });
    await expect(chips.getByTestId('medication-chips-more')).toContainText('+2');
    await expect(chips.getByTestId('medication-chips-more')).toHaveAttribute('title', /Joint support: Due in 9 days\nDental chew: Due in 19 days/);

    // The Medication tab shows all of them.
    await page.goto('/pets/pixel?tab=medication');
    await expect(page.getByRole('tabpanel').getByTestId('medication-chips').getByRole('listitem')).toHaveCount(4);
  });

  test('the Log feeding shortcut opens the feeding picker', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    // Pixel last ate wet food: the confirm must say so and log Wet, never a default Dry.
    const pixelLogs = household.collection('pets').doc('pixel').collection('feeding-logs');
    await pixelLogs.doc('e2e-wet-yesterday').set({
      date: new Date('2026-07-31T18:00:00.000Z'), cups: 1, foodType: 'Wet', foodAmountType: 'Cans', comments: '', ampm: 'PM',
    });
    await useLiveClock(page);
    await page.goto('/pets?feed=1');
    const dialog = page.getByRole('dialog', { name: 'Log a feeding' });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/pets$/);
    await dialog.getByRole('button', { name: 'Pixel, 1 can' }).click();
    // Confirm stays disabled until the history has loaded, then names the last food.
    await expect(dialog).toContainText('Log 1 can of wet food for Pixel?');
    await expect(dialog.getByTestId('feed-confirm-loading')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Log feeding' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('pet-card-pixel')).toContainText('Fed just now by Alex');
    await expect.poll(async () => (await pixelLogs.get()).docs
      .filter((entry) => entry.id !== 'e2e-wet-yesterday')
      .map((entry) => entry.data().foodType)).toEqual(['Wet']);
  });

  test('a pet card opens the pet page (shared-element morph) and peeks on hover', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openPets(page);
    const link = page.getByTestId('pet-card-maple').getByRole('link', { name: 'Maple' });
    await link.hover();
    await expect(page.getByTestId('pet-peek-maple')).toBeVisible();
    await expect(page.getByTestId('pet-peek-maple')).toContainText("Open Maple's page");
    await link.click();
    await expect(page).toHaveURL(/\/pets\/maple$/);
    await expect(page.getByRole('heading', { name: 'Maple', exact: true })).toBeVisible();
    await expect(page.getByTestId('pet-hero')).toHaveCSS('view-transition-name', 'pet-maple-photo');
  });

  test('pets without a photo get species art', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await household.collection('pets').doc(TEST_PET).set({
      name: 'Tweety', type: 'Bird', photoUrl: 'https://placehold.co/300x300.png', dataAiHint: 'bird', foodSchedule: 'One scoop each morning',
    });
    await openPets(page);
    const card = page.getByTestId(`pet-card-${TEST_PET}`);
    await expect(card.getByRole('img', { name: 'Tweety, bird illustration' })).toBeVisible();
    // The art idles on a slow ambient loop (none under reduced motion, see the unit test).
    await expect(card.getByTestId('species-idle')).toHaveCSS('animation-duration', '24s');
    await expect(card.getByRole('button', { name: 'Feed Tweety, 1 scoop' })).toBeVisible();
    // Seeded pets keep their photo through next/image with a face-safe crop.
    await expect(page.getByRole('img', { name: 'Photo of Maple' })).toHaveCSS('object-position', '50% 35%');
  });

  test('legacy pets stay editable and non-daily schedules get no daily target', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    // Created before the 40-character name rule, with a twice-weekly schedule.
    const legacyName = 'Sir Reginald Fluffington the Third of Maple Street';
    await household.collection('pets').doc(TEST_PET).set({
      name: legacyName, type: 'Small mammal', photoUrl: 'https://placehold.co/300x300.png', dataAiHint: 'rabbit', foodSchedule: '1 scoop twice a week',
    });
    await openPets(page);
    const card = page.getByTestId(`pet-card-${TEST_PET}`);
    await expect(card).toContainText('No feeding planned daily'); // PE-18b: a non-daily schedule has no daily target
    await expect(card).not.toContainText('of 2 today');

    await card.getByRole('button', { name: `Open actions for ${legacyName}` }).click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog', { name: `Edit ${legacyName}` });
    await dialog.getByLabel('Feedings per day').fill('1');
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByText('Pet updated', { exact: true })).toBeVisible();
    await expect.poll(async () => (await household.collection('pets').doc(TEST_PET).get()).data()?.feedingsPerDay).toBe(1);
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
    // Maple's seeded feeding is "just now" at fixedNow: the tap asks first.
    await feed(page, 'Feed Maple, 1.5 cups');
    await feedAgain(page, 'Maple was fed just now.');
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
