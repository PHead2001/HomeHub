import { expect, test, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';

/*
 * Meal slots (P2: PE-22, PE-6f/g, PE-10, PE-25, PE-26; D-P3, D-P5, D-P21) on the
 * seeded e2e household (time zone: the server default, America/Chicago).
 * Status-only tests pin the page clock to fixed Chicago times; tests that feed
 * run at the real time (feedings carry the emulator's server time, PE-5) with
 * meal times placed around the real Chicago clock.
 */

const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const ownerUid = 'e2e-owner-uid';
const baseURL = 'http://127.0.0.1:9002';
const TZ = 'America/Chicago';
const adminApp = getApps().find((app) => app.name === 'pets-meal-slots') || initializeApp({ projectId }, 'pets-meal-slots');
const household = getFirestore(adminApp).collection('households').doc(householdId);

const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');
const SLOT_PET = 'e2e-meal-biscuit';
const SEEDED_FEEDING = 'morning-feed';

type Slot = { id: string; name: string; time: string; amount: number; unit: 'Cups' | 'Cans' | 'Scoops' | 'Other'; offDays?: number[] };

/** A Chicago wall-clock time on 2026-08-04 (a Tuesday, CDT = UTC-5). */
const chicago = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 7, 4, h + 5, m));
};

/** Minutes after midnight on the household (Chicago) clock. */
function chicagoMinutes(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  return Number(parts.find((part) => part.type === 'hour')!.value) * 60 + Number(parts.find((part) => part.type === 'minute')!.value);
}
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
/** "6:00 pm" as the app writes a slot time. */
const clock12 = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};

/** Seeds a pet with a confirmed plan (as a member would have saved it). */
async function seedSlotPet(slots: Slot[]) {
  await household.collection('pets').doc(SLOT_PET).set({
    name: 'Biscuit',
    type: 'Dog',
    photoUrl: '/favicon.ico',
    dataAiHint: 'dog',
    foodSchedule: '',
    feedingsPerDay: slots.length,
    mealPlan: { slots, effectiveFrom: '2026-01-01', confirmedAt: Timestamp.now(), confirmedByUid: ownerUid, confirmedByName: 'Alex' },
  });
}

/** Meals around the real Chicago clock: one whose time just passed (due now), and one six hours away. */
function slotsAroundNow(): { due: Slot; other: Slot; otherIsLater: boolean } {
  const now = chicagoMinutes(new Date());
  const dueAt = Math.max(0, now - 5);
  const otherAt = dueAt + 6 * 60 < 24 * 60 ? dueAt + 6 * 60 : dueAt - 6 * 60;
  return {
    due: { id: 'supper', name: 'Supper', time: hhmm(dueAt), amount: 0.5, unit: 'Cans' },
    other: { id: 'snack', name: 'Snack', time: hhmm(otherAt), amount: 1, unit: 'Cups' },
    otherIsLater: otherAt > dueAt,
  };
}

async function slotPetLogs() {
  const logs = await household.collection('pets').doc(SLOT_PET).collection('feeding-logs').get();
  return logs.docs.map((entry) => entry.data());
}

/** Removes everything these tests wrote, leaving the seeded pets as they were (no plans: they are legacy pets). */
async function restore() {
  for (const petId of ['maple', 'pixel', SLOT_PET]) {
    const pet = household.collection('pets').doc(petId);
    const logs = await pet.collection('feeding-logs').get();
    await Promise.all(logs.docs.filter((entry) => entry.id !== SEEDED_FEEDING).map((entry) => entry.ref.delete()));
    await pet.collection('feeding-state').doc('current').delete();
  }
  await household.collection('pets').doc(SLOT_PET).delete();
  await household.collection('pets').doc('pixel').update({
    mealPlan: FieldValue.delete(),
    mealPlanHistory: FieldValue.delete(),
    feedingsPerDay: FieldValue.delete(),
    portionAmount: FieldValue.delete(),
    portionUnit: FieldValue.delete(),
  }).catch(() => undefined);
}

async function openPets(page: Page, at: Date) {
  await page.clock.setFixedTime(at);
  await page.goto('/pets');
  await expect(page.getByRole('heading', { name: 'Your Pets', exact: true })).toBeVisible();
}

const card = (page: Page, petId: string) => page.getByTestId(`pet-card-${petId}`);
/**
 * A toast's own text, inside the toast list (the "Notifications" region). Radix also
 * repeats each toast in a live region (`role="status"`) outside it, so an unscoped
 * text match finds two elements.
 */
const toastText = (page: Page, text: string) => page.getByRole('region', { name: /^Notifications/ }).getByText(text, { exact: true });
const mealState = (scope: Locator) => scope.getByTestId('meal-slots-status').locator('[data-meal-state]');

async function openContext(browser: Browser, viewport: { width: number; height: number }) {
  const context = await browser.newContext({ baseURL, viewport, hasTouch: true, reducedMotion: 'reduce', storageState: 'playwright/.auth/e2e-owner.json' });
  return { context, page: await context.newPage() };
}

test.describe('pets: meal slots (P2)', () => {
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.project.name === 'desktop-chromium') await restore();
  });

  test('a legacy schedule is only a suggestion until a member confirms it (D-P3, PE-6f)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    // 19:00 in Chicago: Pixel ("One can morning and evening") has not been fed today.
    await openPets(page, chicago('19:00'));
    const pixel = card(page, 'pixel');
    // Without confirmed meal times nothing is ever "due" (no guess shown as a need), only a neutral hint.
    await expect(pixel).toContainText('Next meal: morning');
    await expect(pixel.getByTestId('meal-slots-status')).toHaveCount(0);
    await expect(pixel).not.toHaveAttribute('data-attention', /.+/);
    await expect(page.getByTestId('pets-attention')).toHaveCount(0);

    await pixel.getByRole('button', { name: 'Set meal times for Pixel' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit Pixel' });
    await expect(dialog).toBeVisible();
    const suggestion = dialog.getByTestId('meal-plan-suggestion');
    await expect(suggestion).toContainText('Reads as: 2 feedings of 1 can');
    await expect(suggestion).toContainText('Breakfast · 7:00 am · 1 can');
    await expect(suggestion).toContainText('Dinner · 6:00 pm · 1 can');
    await expect(suggestion).toContainText('The times are a guess');

    // Filling the rows is not a confirmation: nothing is written yet.
    await suggestion.getByRole('button', { name: 'Use these meal times' }).click();
    await expect(dialog.getByTestId('meal-row-0')).toBeVisible();
    await expect(dialog.getByTestId('meal-plan-reads-as')).toHaveText('Reads as: 2 feedings of 1 can');
    expect((await household.collection('pets').doc('pixel').get()).get('mealPlan')).toBeUndefined();

    // Correct dinner to 5:30 pm, then save: the member's confirmation.
    await dialog.getByLabel('Time').nth(1).fill('17:30');
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(toastText(page, 'Pet updated')).toBeVisible();

    await expect.poll(async () => {
      const data = (await household.collection('pets').doc('pixel').get()).data() ?? {};
      return {
        slots: (data.mealPlan?.slots ?? []).map((slot: Slot) => [slot.name, slot.time, slot.amount, slot.unit]),
        effectiveFrom: data.mealPlan?.effectiveFrom,
        confirmedByUid: data.mealPlan?.confirmedByUid,
        history: data.mealPlanHistory,
        feedingsPerDay: data.feedingsPerDay,
      };
    }).toEqual({
      slots: [['Breakfast', '07:00', 1, 'Cans'], ['Dinner', '17:30', 1, 'Cans']],
      effectiveFrom: '2026-08-04',
      confirmedByUid: ownerUid,
      // The legacy daily target it replaced is kept for earlier days (PE-22g).
      history: [{ until: '2026-08-04', perDay: 2 }],
      feedingsPerDay: 2,
    });
    // Now Pixel has meal times: dinner's time has passed unfed, so it is due, and the prompt is gone.
    await expect(mealState(pixel)).toHaveAttribute('data-meal-state', 'due');
    await expect(pixel).toContainText('Dinner due 5:30 pm');
    await expect(pixel.getByRole('button', { name: 'Set meal times for Pixel' })).toHaveCount(0);
  });

  test('the card and the pet page show the due or next meal by its window (D-P21)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    // Windows: breakfast [5:00, 7:30), snack [7:30, 16:00) (the midpoint, not 2 h early), dinner [16:00, 24:00).
    await seedSlotPet([
      { id: 'breakfast', name: 'Breakfast', time: '07:00', amount: 1, unit: 'Cups' },
      { id: 'snack', name: 'Snack', time: '08:00', amount: 0.5, unit: 'Cups' },
      { id: 'dinner', name: 'Dinner', time: '18:00', amount: 1, unit: 'Cans' },
    ]);

    await openPets(page, chicago('07:20'));
    const biscuit = card(page, SLOT_PET);
    await expect(mealState(biscuit)).toHaveAttribute('data-meal-state', 'due');
    await expect(biscuit).toContainText('Breakfast due 7:00 am');
    await expect(biscuit).toHaveAttribute('data-attention', 'meal');
    await expect(page.getByTestId(`pets-attention-${SLOT_PET}`)).toContainText('Biscuit: Breakfast due 7:00 am');
    await expect(biscuit.getByRole('button', { name: 'Feed Biscuit, breakfast, 1 cup' })).toBeVisible();

    // 7:40: the snack's window opened at the midpoint (7:30); breakfast is now missed, the snack is next.
    await openPets(page, chicago('07:40'));
    await expect(mealState(biscuit)).toHaveAttribute('data-meal-state', 'pending');
    await expect(biscuit).toContainText('Next: snack at 8:00 am');
    await expect(biscuit).toContainText('Breakfast missed');
    await expect(biscuit.getByRole('button', { name: 'Feed Biscuit, snack, 0.5 cups' })).toBeVisible();
    await expect(page.getByTestId(`pets-attention-${SLOT_PET}`)).toContainText('Breakfast missed');

    // 15:00: the unfed snack is still in its window (due); dinner is not, until its window opens at 16:00.
    await openPets(page, chicago('15:00'));
    await expect(biscuit).toContainText('Snack due 8:00 am');
    // 16:30: dinner's window is open but its time has not come: nothing is due (not hungry all afternoon, PE-31).
    await openPets(page, chicago('16:30'));
    await expect(mealState(biscuit)).toHaveAttribute('data-meal-state', 'pending');
    await expect(biscuit).toContainText('Next: dinner at 6:00 pm');
    await openPets(page, chicago('18:20'));
    await expect(biscuit).toContainText('Dinner due 6:00 pm');

    // The pet page shows the same status, the meal times and the seven-day strip.
    await page.goto(`/pets/${SLOT_PET}`);
    await expect(page.getByRole('heading', { name: 'Biscuit', level: 1 })).toBeVisible();
    await expect(page.getByTestId('meal-slots-status').first()).toContainText('Dinner due 6:00 pm');
    await expect(page.getByTestId('meal-plan-list')).toContainText('Snack · 8:00 am · 0.5 cups');
    const week = page.getByTestId('feeding-week');
    await expect(week.locator('[data-day-state]')).toHaveCount(7);
    await expect(week.locator('[data-day-state="missed"]')).toHaveCount(6);
    await expect(week.locator('[data-day-state="today"]')).toHaveCount(1);
  });

  test('feeding the due meal marks it fed with its portion; a repeat asks "Feed again?" (D-P5)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const { due, other, otherIsLater } = slotsAroundNow();
    await seedSlotPet([due, other]);
    await openPets(page, new Date());
    const biscuit = card(page, SLOT_PET);
    await expect(biscuit).toContainText(`Supper due ${clock12(due.time)}`);
    // The ring counts today's meals fed.
    await expect(biscuit).toContainText('0/2');

    await biscuit.getByRole('button', { name: 'Feed Biscuit, supper, 0.5 cans' }).click();
    await expect(toastText(page, 'Supper: 0.5 cans logged.')).toBeVisible();
    await expect(biscuit).toContainText('1/2');
    await expect(biscuit).toContainText(/Supper ✓ \d{1,2}:\d{2} (am|pm) · Alex/);
    await expect.poll(async () => (await slotPetLogs()).map(({ slotId, cups, foodAmountType, repeat }) => ({ slotId, cups, foodAmountType, repeat })))
      .toEqual([{ slotId: 'supper', cups: 0.5, foodAmountType: 'Cans', repeat: 'none' }]);

    // Pressing again right away is a repeat: the snack is not open yet and the last feed was just now
    // (or, when the snack was earlier today, supper is already logged). Cancel writes nothing.
    await biscuit.getByRole('button', { name: /^Feed Biscuit, / }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Feed Biscuit again?');
    await expect(dialog).toContainText(otherIsLater ? `Snack is at ${clock12(other.time)}.` : "Biscuit's supper is already logged.");
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(await slotPetLogs()).toHaveLength(1);
  });

  test('when every meal is fed the card says so, and an extra feed needs a confirmation', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const { due } = slotsAroundNow();
    await seedSlotPet([due]);
    await openPets(page, new Date());
    const biscuit = card(page, SLOT_PET);
    await biscuit.getByRole('button', { name: 'Feed Biscuit, supper, 0.5 cans' }).click();
    await expect(toastText(page, 'Biscuit is all fed for today')).toBeVisible();
    await expect(mealState(biscuit)).toHaveAttribute('data-meal-state', 'complete');
    await expect(biscuit).toContainText('Meal done today');
    await expect(biscuit).not.toHaveAttribute('data-attention', /.+/);

    await biscuit.getByRole('button', { name: /^Feed Biscuit, / }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Biscuit has had all 1 meal today.');
    await dialog.getByRole('button', { name: 'Feed again' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await slotPetLogs()).map(({ slotId, repeat }) => `${slotId}:${repeat}`).sort())
      .toEqual(['supper:confirmed', 'supper:none']);
  });

  test('phone (390 x 844): the meal-time editor and the slot status fit and are 48 px on touch', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    await seedSlotPet([
      { id: 'breakfast', name: 'Breakfast', time: '07:00', amount: 1, unit: 'Cups' },
      { id: 'dinner', name: 'Dinner', time: '18:00', amount: 1, unit: 'Cans', offDays: [0] },
    ]);
    const { context, page } = await openContext(browser, { width: 390, height: 844 });
    try {
      await openPets(page, chicago('07:20'));
      const biscuit = card(page, SLOT_PET);
      const status = biscuit.getByTestId('meal-slots-status');
      await expect(status).toContainText('Breakfast due 7:00 am');
      await expect(status).toContainText('Dinner 6:00 pm');
      const cardBox = await biscuit.boundingBox();
      const statusBox = await status.boundingBox();
      expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

      // The editor on a legacy pet: the suggestion, then the rows with their weekday toggles.
      await card(page, 'pixel').getByRole('button', { name: 'Set meal times for Pixel' }).click();
      const dialog = page.getByRole('dialog', { name: 'Edit Pixel' });
      // Measured before it is pressed: once the rows are filled it may leave the dialog.
      const useTimes = dialog.getByRole('button', { name: 'Use these meal times' });
      await expect(useTimes).toBeVisible();
      expect((await useTimes.boundingBox())!.height, 'Use these meal times').toBeGreaterThanOrEqual(48);
      await useTimes.click();
      const toggle = dialog.getByRole('button', { name: 'Skip Breakfast on Sunday' });
      await toggle.scrollIntoViewIfNeeded();
      const box = await toggle.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(48);
      expect(box!.height).toBeGreaterThanOrEqual(48);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      for (const name of ['Add a meal', 'Remove Breakfast']) {
        const control = dialog.getByRole('button', { name }).first();
        if (!(await control.isVisible())) continue;
        await control.scrollIntoViewIfNeeded();
        const controlBox = await control.boundingBox();
        expect(controlBox!.height, name).toBeGreaterThanOrEqual(48);
      }
      const dialogBox = await dialog.boundingBox();
      expect(dialogBox!.width).toBeLessThanOrEqual(390);
      // Cancel: nothing was confirmed.
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      expect((await household.collection('pets').doc('pixel').get()).get('mealPlan')).toBeUndefined();
    } finally {
      await context.close();
    }
  });

  test('wall tablet (1263 x 818): the pets page with meal slots fits without page scroll', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    await seedSlotPet([
      { id: 'breakfast', name: 'Breakfast', time: '07:00', amount: 1, unit: 'Cups' },
      { id: 'dinner', name: 'Dinner', time: '18:00', amount: 1, unit: 'Cans' },
    ]);
    const { context, page } = await openContext(browser, { width: 1263, height: 818 });
    try {
      await openPets(page, chicago('18:20'));
      await expect(card(page, SLOT_PET)).toContainText('Dinner due 6:00 pm');
      await expect(page.getByTestId('pets-attention')).toBeVisible();
      const scroll = await page.evaluate(() => ({
        sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        down: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      }));
      expect(scroll.sideways).toBeLessThanOrEqual(0);
      expect(scroll.down, 'the pets page scrolls at 1263 x 818').toBeLessThanOrEqual(0);
      // Every pet's Feed button is on screen.
      for (const petId of ['maple', 'pixel', SLOT_PET]) {
        const feed = card(page, petId).getByRole('button', { name: /^Feed / });
        const box = await feed.boundingBox();
        expect(box!.y + box!.height, petId).toBeLessThanOrEqual(818);
        expect(box!.height, petId).toBeGreaterThanOrEqual(48);
      }
    } finally {
      await context.close();
    }
  });
});
