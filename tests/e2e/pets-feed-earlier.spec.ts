import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import {
  baseURL,
  createDeviceCode,
  householdRef,
  openTabletContext,
  pairWithCode,
  prepareHousehold,
  removeEveryTablet,
  restoreHousehold,
  TABLET_VIEWPORTS,
} from './devices-helpers';

// "Feed earlier" (owner request; docs/modules/pets/README.md, "Feed earlier"): a tap or click on
// Feed still feeds now; holding Feed on touch (500 ms), the desktop split button's clock,
// right-click and Shift+Enter open "When did <pet> eat?", whose times are household wall times
// (the e2e household has no zone: America/Chicago). Saving is a backdated feeding through the
// shared feed operation (`backdated: true`, `date` = the chosen time, `loggedAt` = server time),
// with Undo; on a wall tablet it is a device action ("Who's here?" first).

const OWNER_UID = 'e2e-owner-uid';
const TZ = 'America/Chicago';
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium', 'each journey makes its own browser at its own size');
const pet = (id: string) => householdRef.collection('pets').doc(id);
const feedings = (id: string) => pet(id).collection('feeding-logs');

test.describe.configure({ mode: 'serial' });

/** Pixel has no seeded feedings; remove anything these tests wrote (and the feed operation's state). */
async function clearPixel() {
  const logs = await feedings('pixel').get();
  await Promise.all(logs.docs.map((entry) => entry.ref.delete()));
  await pet('pixel').collection('feeding-state').doc('current').delete();
}

const chicago = (at: Date) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(at).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, hour: Number(parts.hour) };
};
const chicagoTime = (offsetMinutes: number) => chicago(new Date(Date.now() + offsetMinutes * 60_000)).time;
const toMinute = (ms: number) => Math.floor(ms / 60_000) * 60_000;

async function onlyLog(petId: string) {
  await expect.poll(async () => (await feedings(petId).get()).size, { timeout: 15_000 }).toBe(1);
  return (await feedings(petId).get()).docs[0].data();
}

async function openPets(page: Page) {
  await page.goto('/pets');
  await expect(page.getByRole('heading', { name: 'Your Pets', exact: true })).toBeVisible();
}

async function touchSession(browser: Browser, viewport: { width: number; height: number }) {
  const context = await browser.newContext({ baseURL, viewport, hasTouch: true, isMobile: viewport.width < 768, storageState: 'playwright/.auth/e2e-owner.json' });
  return { context, page: await context.newPage() };
}

/** A touch press on an element's centre through CDP (pointerType "touch"); `hold`: ms before lifting. */
async function touchPress(page: Page, testIdOrBox: { x: number; y: number; width: number; height: number }, hold: number, move?: number) {
  const client = await page.context().newCDPSession(page);
  const x = testIdOrBox.x + testIdOrBox.width / 2;
  const y = testIdOrBox.y + testIdOrBox.height / 2;
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  if (move) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - move }] });
  await page.waitForTimeout(hold);
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await client.detach();
}

test.describe('pets: feed earlier on /pets', () => {
  test.beforeEach(async ({}, testInfo) => { if (testInfo.project.name === 'desktop-chromium') await clearPixel(); });
  test.afterEach(async ({}, testInfo) => { if (testInfo.project.name === 'desktop-chromium') await clearPixel(); });

  test('desktop: the split button\'s clock logs a backdated feeding at the chosen time, with Undo', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    // Feedings carry the emulator's server time: run the page at the real time.
    const fixed = new Date();
    await page.clock.setFixedTime(fixed);
    await openPets(page);
    const card = page.getByTestId('pet-card-pixel');
    await expect(card).toContainText('No feedings logged yet');
    const feed = card.getByRole('button', { name: 'Feed Pixel, 1 can' });
    await expect(feed).toHaveAccessibleDescription(/To log an earlier feeding, use the clock button, right-click Feed, or press Shift\+Enter\./);
    const clock = card.getByRole('button', { name: 'Choose feeding time for Pixel' });
    const box = (await clock.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);

    await clock.click();
    const dialog = page.getByTestId('feed-earlier-dialog');
    await expect(dialog.getByRole('heading', { name: 'When did Pixel eat?' })).toBeVisible();
    await expect(dialog.getByTestId('feed-earlier-last-fed')).toHaveText('No feedings logged yet.');
    await dialog.getByTestId('feed-earlier-chip-30').click();
    await expect(dialog.getByTestId('feed-earlier-counts')).toHaveText('Logs 1 can.');
    await expect(dialog.getByTestId('feed-earlier-time')).toHaveValue(chicago(new Date(toMinute(fixed.getTime() - 30 * 60_000))).time);
    await dialog.getByTestId('feed-earlier-save').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/^Pixel fed (yesterday )?at /)).toBeVisible();

    const log = await onlyLog('pixel');
    expect(log.backdated).toBe(true);
    expect(log.date.toMillis()).toBe(toMinute(fixed.getTime() - 30 * 60_000));
    // Recorded at server time, not the chosen time.
    expect(Math.abs(log.loggedAt.toMillis() - Date.now())).toBeLessThan(120_000);
    expect(log.cups).toBe(1);
    expect(log.foodAmountType).toBe('Cans');
    expect(log.loggedByUid).toBe(OWNER_UID);

    // The same per-pet Undo as any feeding.
    await page.getByRole('button', { name: 'Undo' }).first().click();
    await expect.poll(async () => (await feedings('pixel').get()).size, { timeout: 15_000 }).toBe(0);
  });

  test('desktop: right-click and Shift+Enter open it; a future time is refused; a click still feeds now', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await page.clock.setFixedTime(new Date());
    await openPets(page);
    const card = page.getByTestId('pet-card-pixel');
    await expect(card).toContainText('No feedings logged yet');
    const feed = card.getByRole('button', { name: 'Feed Pixel, 1 can' });
    const dialog = page.getByTestId('feed-earlier-dialog');

    // Right-click opens the dialog (no browser menu, no feeding).
    await feed.click({ button: 'right' });
    await expect(dialog).toBeVisible();
    if (chicago(new Date()).hour < 22) {
      await dialog.getByTestId('feed-earlier-day-today').click();
      await dialog.getByTestId('feed-earlier-time').fill(chicagoTime(90));
      await expect(dialog.getByText('Pick a time that has already passed.')).toBeVisible();
      await expect(dialog.getByTestId('feed-earlier-save')).toBeDisabled();
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect((await feedings('pixel').get()).size).toBe(0);

    // Shift+Enter on Feed opens it too; yesterday 9:15 pm in the household zone.
    await feed.focus();
    await page.keyboard.press('Shift+Enter');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('feed-earlier-day-yesterday').click();
    await dialog.getByTestId('feed-earlier-time').fill('21:15');
    await expect(dialog.getByTestId('feed-earlier-when')).toHaveText('Yesterday 9:15 pm');
    await dialog.getByTestId('feed-earlier-save').click();
    await expect(dialog).toBeHidden();
    const log = await onlyLog('pixel');
    expect(log.backdated).toBe(true);
    const when = chicago(log.date.toDate());
    expect(when.time).toBe('21:15');
    const today = chicago(new Date()).day;
    expect(when.day < today).toBe(true);

    // A plain click is unchanged: it feeds now (a live feeding, not backdated).
    await feed.click();
    await expect.poll(async () => (await feedings('pixel').get()).size, { timeout: 15_000 }).toBe(2);
    const live = (await feedings('pixel').get()).docs.map((entry) => entry.data()).find((entry) => !entry.backdated);
    expect(live).toBeTruthy();
    expect(Math.abs(live!.date.toMillis() - Date.now())).toBeLessThan(120_000);
  });

  test('phone 390x844: holding Feed opens the dialog; a scroll cancels; a tap still feeds now', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const { context, page } = await touchSession(browser, { width: 390, height: 844 });
    try {
      await page.clock.setFixedTime(new Date());
      await openPets(page);
      const card = page.getByTestId('pet-card-pixel');
      await expect(card).toHaveAttribute('data-layout', 'rows');
      await expect(card).toContainText('No feedings logged yet');
      const feed = card.getByRole('button', { name: 'Feed Pixel, 1 can' });
      await feed.scrollIntoViewIfNeeded();
      // Phone rows keep Feed alone (no room for the clock); the hold is described.
      await expect(card.getByRole('button', { name: 'Choose feeding time for Pixel' })).toHaveCount(0);
      await expect(feed).toHaveAccessibleDescription(/Press and hold Feed to log an earlier feeding\./);
      const dialog = page.getByTestId('feed-earlier-dialog');

      // A finger that moves (a scroll) cancels: no dialog, no feeding.
      await touchPress(page, (await feed.boundingBox())!, 800, 40);
      await page.waitForTimeout(300);
      await expect(dialog).toHaveCount(0);
      expect((await feedings('pixel').get()).size).toBe(0);

      // Held past 500 ms: the dialog opens, and letting go does not also feed.
      await touchPress(page, (await feed.boundingBox())!, 900);
      await expect(dialog).toBeVisible();
      await page.waitForTimeout(500);
      expect((await feedings('pixel').get()).size).toBe(0);
      await dialog.getByTestId('feed-earlier-chip-15').click();
      await dialog.getByTestId('feed-earlier-save').click();
      await expect(dialog).toBeHidden();
      const log = await onlyLog('pixel');
      expect(log.backdated).toBe(true);
      expect(Math.abs(log.date.toMillis() - (Date.now() - 15 * 60_000))).toBeLessThan(120_000);

      // A quick tap is unchanged: it feeds now, so with a feeding 15 min ago it asks "Feed again?".
      await touchPress(page, (await feed.boundingBox())!, 60);
      await expect(page.getByTestId('feed-again-dialog')).toBeVisible();
      await page.getByTestId('feed-again-dialog').getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);
      expect((await feedings('pixel').get()).size).toBe(1);
    } finally {
      await context.close();
    }
  });
});

test.describe('pets: feed earlier on a registered wall tablet', () => {
  let tablet: Awaited<ReturnType<typeof openTabletContext>> | null = null;
  const seeded = ['early'];

  test.beforeAll(async () => {
    await prepareHousehold();
  });

  test.afterAll(async () => {
    await tablet?.context.close();
    await removeEveryTablet();
    await Promise.all(seeded.map((id) => householdRef.firestore.recursiveDelete(pet(id)).catch(() => undefined)));
    await restoreHousehold();
  });

  test('1263x818: holding Feed opens the dialog; saving asks "Who\'s here?" and logs a backdated device feed', async ({ page: ownerPage, browser }, testInfo) => {
    desktopOnly(testInfo);
    test.setTimeout(120_000);
    // A pet whose dinner (0.5 cans) was due 30 minutes ago, confirmed today.
    await householdRef.firestore.recursiveDelete(pet('early'));
    const slots = chicago(new Date()).hour >= 2;
    await pet('early').set({
      name: 'Tablet early', type: 'Dog', foodSchedule: '1 cup twice daily', feedingsPerDay: 2, portionAmount: 1, portionUnit: 'Cups', photoUrl: '',
      ...(slots ? { mealPlan: { slots: [{ id: 'slot-dinner', name: 'Dinner', time: chicagoTime(-30), amount: 0.5, unit: 'Cans' }], effectiveFrom: chicago(new Date()).day, confirmedAt: Timestamp.now(), confirmedByUid: OWNER_UID, confirmedByName: 'Owner' } } : {}),
    });
    const code = await createDeviceCode(ownerPage, 'Earlier tablet', 'Kitchen');
    tablet = await openTabletContext(browser, TABLET_VIEWPORTS[0]);
    const page = tablet.page;
    await pairWithCode(page, code);
    await page.getByTestId('tablet-rail-pets').click();
    await expect(page.getByTestId('tablet-view-pets')).toBeVisible();
    const feed = page.getByTestId('tablet-pet-feed-early');
    await expect(feed).toBeEnabled();
    // The clock fits beside Feed at 48 px.
    const clockBox = (await page.getByTestId('tablet-pet-feed-earlier-early').boundingBox())!;
    expect(clockBox.height).toBeGreaterThanOrEqual(48);
    expect(clockBox.width).toBeGreaterThanOrEqual(48);

    await touchPress(page, (await feed.boundingBox())!, 900);
    const dialog = page.getByTestId('feed-earlier-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('feed-earlier-chip-15').click();
    if (slots) await expect(dialog.getByTestId('feed-earlier-counts')).toHaveText('Counts for dinner: 0.5 cans.');
    await dialog.getByTestId('feed-earlier-save').click();
    await expect(page.getByTestId('who-is-here')).toBeVisible();
    await page.getByTestId(`who-person-${OWNER_UID}`).click();

    const log = await onlyLog('early');
    expect(log.backdated).toBe(true);
    expect(log.loggedByUid).toBe(OWNER_UID);
    expect(log.deviceAttribution?.deviceName).toBe('Earlier tablet');
    expect(Math.abs(log.date.toMillis() - (Date.now() - 15 * 60_000))).toBeLessThan(120_000);
    expect(log.date.toMillis() % 60_000).toBe(0);
    expect(Math.abs(log.loggedAt.toMillis() - Date.now())).toBeLessThan(120_000);
    if (slots) {
      expect(log.cups).toBe(0.5);
      expect(log.foodAmountType).toBe('Cans');
    }
    await expect(dialog).toBeHidden();
    // Undo, as for any tablet feed.
    await page.getByTestId('tablet-undo').first().click();
    await expect.poll(async () => (await feedings('early').get()).size, { timeout: 15_000 }).toBe(0);
  });
});
