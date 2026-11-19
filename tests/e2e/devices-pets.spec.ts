import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import {
  KID,
  TABLET_VIEWPORTS,
  createDeviceCode,
  householdRef,
  openTabletContext,
  pairWithCode,
  prepareHousehold,
  removeEveryTablet,
  restoreHousehold,
  setOwnerPin,
} from './devices-helpers';

// Pets on a registered wall tablet against the emulators (docs/modules/devices/README.md,
// "Device actions: pets"; PE-2c, PE-17a/b/c, PE-23g, PE-23l, D-P5): at 1263x818, a
// face-chosen person feeds and is credited, Undo removes the feed; a feed recorded on another
// device asks "Feed again?" and the answer is written once; a meal-slot pet logs the due
// slot's portion; offline, then online, one feeding is stored; a care entry and its Undo.

const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium', 'tablet journeys run once, in their own tablet-sized browser');
const OWNER_UID = 'e2e-owner-uid';
const TZ = 'America/Chicago';

test.describe.configure({ mode: 'serial' });

let tablet: { context: BrowserContext; page: Page } | null = null;
const tabletPage = () => tablet!.page;
const pet = (id: string) => householdRef.collection('pets').doc(id);
const feedings = (id: string) => pet(id).collection('feeding-logs');
const seeded: string[] = [];

const seedPet = async (id: string, fields: Record<string, unknown> = {}) => {
  seeded.push(id);
  await householdRef.firestore.recursiveDelete(pet(id));
  await pet(id).set({ name: `Tablet ${id}`, type: 'Dog', foodSchedule: '1 cup twice daily', feedingsPerDay: 2, portionAmount: 1, portionUnit: 'Cups', photoUrl: '', ...fields });
};

const chicagoTime = (offsetMinutes: number) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const minutes = Math.max(0, Number(parts.find((p) => p.type === 'hour')!.value) * 60 + Number(parts.find((p) => p.type === 'minute')!.value) + offsetMinutes);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};
const chicagoDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

const openPets = async (page: Page) => {
  await page.getByTestId('tablet-rail-pets').click();
  await expect(page.getByTestId('tablet-view-pets')).toBeVisible();
};

const forgetFace = async (page: Page) => {
  await page.getByTestId('tablet-done').click({ timeout: 3_000 }).catch(() => undefined);
};

const pick = async (page: Page, uid: string) => {
  await expect(page.getByTestId('who-is-here')).toBeVisible();
  await page.getByTestId(`who-person-${uid}`).click();
};

test.beforeAll(async () => {
  await prepareHousehold();
});

test.afterAll(async () => {
  await tablet?.context.close();
  await removeEveryTablet();
  await Promise.all(seeded.map((id) => householdRef.firestore.recursiveDelete(pet(id)).catch(() => undefined)));
  await restoreHousehold();
});

test('setup: the owner pairs a tablet at 1263x818', async ({ page, browser }, testInfo) => {
  desktopOnly(testInfo);
  test.setTimeout(90_000);
  await setOwnerPin(page);
  await seedPet('tab-maple');
  await seedPet('tab-rex');
  await seedPet('tab-slots', {
    mealPlan: { slots: [{ id: 'slot-dinner', name: 'Dinner', time: chicagoTime(-30), amount: 0.5, unit: 'Cans' }], effectiveFrom: chicagoDay(), confirmedAt: Timestamp.now(), confirmedByUid: OWNER_UID, confirmedByName: 'Owner' },
  });
  await seedPet('tab-offline');
  await seedPet('tab-care');
  const code = await createDeviceCode(page, 'Pets tablet', 'Kitchen');
  tablet = await openTabletContext(browser, TABLET_VIEWPORTS[0]);
  await pairWithCode(tabletPage(), code);
});

test('a face-chosen kid feeds and is credited (by Mia on Pets tablet); Undo removes the feed', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await openPets(page);
  await page.getByTestId('tablet-pet-feed-tab-maple').click();
  await pick(page, KID.uid);
  await expect.poll(async () => (await feedings('tab-maple').get()).size, { timeout: 15_000 }).toBe(1);
  const log = (await feedings('tab-maple').get()).docs[0].data();
  expect(log.loggedByUid).toBe(KID.uid);
  expect(log.deviceAttribution?.deviceName).toBe('Pets tablet');
  expect(log.deviceAttribution?.level).toBe('face');
  await page.getByTestId('tablet-undo').first().click();
  await expect.poll(async () => (await feedings('tab-maple').get()).size, { timeout: 15_000 }).toBe(0);
});

test('a feed on another device a minute ago: the tablet asks "Feed again?" and writes the answer once', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  const at = Timestamp.fromDate(new Date(Date.now() - 60_000));
  await feedings('tab-rex').doc('phone-feed').set({ date: at, loggedAt: at, cups: 1, foodAmountType: 'Cups', foodType: 'Dry', comments: '', ampm: 'AM', loggedByUid: OWNER_UID, loggedByName: 'Owner', repeat: 'none' });
  await pet('tab-rex').collection('feeding-state').doc('current').set({ lastLogId: 'phone-feed', lastFedAt: at, lastFedByUid: OWNER_UID, lastFedByName: 'Owner', day: chicagoDay(), countOnDay: 1, prev: null });
  await forgetFace(page);
  await openPets(page);
  await page.getByTestId('tablet-pet-feed-tab-rex').click();
  await pick(page, OWNER_UID);
  await expect(page.getByTestId('tablet-feed-again')).toBeVisible();
  await expect(page.getByTestId('tablet-feed-again')).toContainText('Owner fed');
  expect((await feedings('tab-rex').get()).size).toBe(1);
  await page.getByTestId('tablet-feed-again-yes').click();
  await expect.poll(async () => (await feedings('tab-rex').get()).size, { timeout: 15_000 }).toBe(2);
  const confirmed = (await feedings('tab-rex').where('repeat', '==', 'confirmed').get()).docs;
  expect(confirmed).toHaveLength(1);
  expect(confirmed[0].get('confirmOf')).toBe('phone-feed');
});

test('a meal-slot pet logs the due slot and its portion (D-P5)', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await openPets(page);
  await page.getByTestId('tablet-pet-feed-tab-slots').click();
  // The owner is still remembered (2 minutes): no "Who's here?" this time (PE-17b).
  await expect.poll(async () => (await feedings('tab-slots').get()).size, { timeout: 15_000 }).toBe(1);
  const log = (await feedings('tab-slots').get()).docs[0].data();
  expect(log.slotId).toBe('slot-dinner');
  expect(log.cups).toBe(0.5);
  expect(log.foodAmountType).toBe('Cans');
});

test('offline: the feed waits on the tablet and is stored once when the connection is back (PE-23l)', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await forgetFace(page);
  await openPets(page);
  await tablet!.context.setOffline(true);
  await page.getByTestId('tablet-pet-feed-tab-offline').click();
  await pick(page, KID.uid);
  await expect(page.getByText('Saved on this tablet. It syncs when the connection is back.').first()).toBeVisible();
  expect((await feedings('tab-offline').get()).size).toBe(0);
  await tablet!.context.setOffline(false);
  await expect.poll(async () => (await feedings('tab-offline').get()).size, { timeout: 45_000 }).toBe(1);
  const log = (await feedings('tab-offline').get()).docs[0].data();
  expect(log.loggedByUid).toBe(KID.uid);
  expect(log.repeat).toBe('offline');
  expect(log.clockSource).toBe('device');
});

test('a care entry for the chosen person, and its Undo', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await forgetFace(page);
  await openPets(page);
  await page.getByTestId('tablet-pet-care-tab-care').click();
  await page.getByTestId('tablet-care-activity').fill('Brushing');
  await page.getByTestId('tablet-care-save').click();
  await pick(page, KID.uid);
  const entries = () => pet('tab-care').collection('care-logs').get();
  await expect.poll(async () => (await entries()).size, { timeout: 15_000 }).toBe(1);
  expect((await entries()).docs[0].get('loggedByUid')).toBe(KID.uid);
  await page.getByTestId('tablet-undo').first().click();
  await expect.poll(async () => (await entries()).size, { timeout: 15_000 }).toBe(0);
});

test('at 1263x818 the Pets view has no page scroll and 48 px controls', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await openPets(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const testId of ['tablet-pet-feed-tab-maple', 'tablet-pet-care-tab-maple']) {
    const box = await page.getByTestId(testId).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(48);
    expect(box!.width).toBeGreaterThanOrEqual(48);
  }
});
