import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import {
  KID,
  OWNER_PIN,
  TABLET_VIEWPORTS,
  enterPin,
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
// F4b-2: Give dose from the pet's medication chip and from a reminder's ?dose= link, credited
// to the chosen person, and its Undo; a behaviour note and a weighing with Undo (face level);
// a PIN-level action (pinning a note) asks the PIN pad and nothing else does; the Pets board
// and the pet sheet at 1263x818, 1263x722 and 1264x843 without page scroll, 48 px controls.

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

// Closes every open dialog. An Escape goes to the topmost layer, which is a toast while one
// is on screen (Radix), so Escape is pressed until no dialog is left.
const closeDialogs = async (page: Page) => {
  await expect(async () => {
    if (await page.getByRole('dialog').count()) await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 750 });
  }).toPass({ timeout: 15_000 });
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
  await seedPet('tab-meds');
  await pet('tab-meds').collection('medication-courses').doc('course-e2e').set({
    name: 'Apoquel', dosage: '1 tablet', schedule: { kind: 'hours', everyHours: 6, firstTime: '00:00' }, startDay: chicagoDay(), endDay: null, status: 'active', legacyKeys: [],
    lastDose: null, prevDose: null, coveredUntil: null, createdAt: Timestamp.now(), createdByUid: OWNER_UID, createdByName: 'Owner', updatedAt: Timestamp.now(), updatedByUid: OWNER_UID, updatedByName: 'Owner',
  });
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
  // The Undo toast starts below the top bar: Done, notices and settings stay reachable.
  const bar = await page.getByTestId('tablet-top-bar').boundingBox();
  // Measured once the toast's slide-in has settled.
  await expect.poll(async () => (await page.getByTestId('tablet-undo').first().boundingBox())!.y, { timeout: 5_000 })
    .toBeGreaterThanOrEqual(bar!.y + bar!.height);
  // D1, D2: the Undo is a 48 px target in a toast at the bottom right, clear of the first pet row's buttons.
  const undoBox = (await page.getByTestId('tablet-undo').first().boundingBox())!;
  expect(undoBox.height).toBeGreaterThanOrEqual(48);
  expect(undoBox.width).toBeGreaterThanOrEqual(48);
  const feedBox = (await page.getByTestId('tablet-pet-feed-tab-maple').boundingBox())!;
  expect(undoBox.y).toBeGreaterThan(feedBox.y + feedBox.height);
  // The toast region takes no tap outside its card: Maple's Feed is what a tap there hits.
  expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid="tablet-pet-feed-tab-maple"]') !== null, [feedBox.x + feedBox.width / 2, feedBox.y + feedBox.height / 2])).toBe(true);
  await page.getByTestId('tablet-undo').first().click();
  await expect.poll(async () => (await feedings('tab-maple').get()).size, { timeout: 15_000 }).toBe(0);
  // The informational "Undone." leaves within 4 s (D2).
  await expect(page.getByText('Undone.')).toHaveCount(0, { timeout: 6_000 });
  // Done ends the remembered person straight away, even with a toast on screen.
  await page.getByTestId('tablet-done').click({ timeout: 5_000 });
  await expect(page.getByTestId('tablet-acting')).toHaveCount(0);
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
  // Toasts are grouped per pet, so an earlier pet's Undo can still be on screen: use this entry's.
  await page.getByRole('status').filter({ hasText: 'Brushing' }).getByTestId('tablet-undo').click();
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

const doses = (id: string) => pet(id).collection('medication-logs');

test('Give dose from the medication chip, credited to the chosen person; Undo removes the record (F4b-2)', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await forgetFace(page);
  await openPets(page);
  await page.getByTestId('tablet-pet-tab-meds').getByTestId('medication-chips').getByRole('button').first().click();
  await expect(page.getByTestId('give-dose-dialog')).toBeVisible();
  await page.getByTestId('give-dose-dialog').getByRole('button', { name: 'Record dose' }).click();
  await pick(page, KID.uid);
  await expect.poll(async () => (await doses('tab-meds').get()).size, { timeout: 15_000 }).toBe(1);
  const log = (await doses('tab-meds').get()).docs[0].data();
  expect(log.loggedByUid).toBe(KID.uid);
  expect(log.courseId).toBe('course-e2e');
  expect(log.deviceAttribution?.level).toBe('face');
  await page.getByTestId('tablet-undo').last().click();
  await expect.poll(async () => (await doses('tab-meds').get()).size, { timeout: 15_000 }).toBe(0);
  await closeDialogs(page);
});

test("a reminder's ?dose= link opens Give dose for that course on the tablet", async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await page.goto('/pets/tab-meds?tab=medication&dose=course-e2e');
  await expect(page.getByTestId('tablet-pet-sheet')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('give-dose-dialog')).toBeVisible();
  // One dialog per Escape: Give dose first, then the sheet (each waits for the one before to leave).
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('give-dose-dialog')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tablet-pet-sheet')).toHaveCount(0);
  await expect(page).toHaveURL(/\/pets$/);
});

test('a behaviour note and a weighing are face-level with Undo; pinning a note asks the PIN pad', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await forgetFace(page);
  await openPets(page);
  await page.getByTestId('tablet-pet-more-tab-meds').click();
  await page.getByTestId('tablet-pet-tab-notes').click();
  await page.getByTestId('tablet-note-text').fill('Barked at the mail carrier');
  await page.getByTestId('tablet-note-save').click();
  await pick(page, OWNER_UID);
  await expect(page.getByTestId('pin-pad')).toHaveCount(0);
  await expect.poll(async () => (await pet('tab-meds').collection('notes').get()).size, { timeout: 15_000 }).toBe(1);
  const noteId = (await pet('tab-meds').collection('notes').get()).docs[0].id;
  await page.getByTestId(`tablet-note-${noteId}`).getByRole('button', { name: 'Pin' }).click();
  await expect(page.getByTestId('pin-pad')).toBeVisible();
  await enterPin(page, OWNER_PIN);
  await expect.poll(async () => (await pet('tab-meds').collection('notes').doc(noteId).get()).get('pinned'), { timeout: 15_000 }).toBe(true);
  await page.getByTestId('tablet-pet-tab-weight').click();
  await page.getByTestId('tablet-weight-value').fill('12.4');
  await page.getByTestId('tablet-weight-save').click();
  await expect.poll(async () => (await pet('tab-meds').collection('weights').get()).size, { timeout: 15_000 }).toBe(1);
  await page.getByTestId('tablet-undo').last().click();
  await expect.poll(async () => (await pet('tab-meds').collection('weights').get()).size, { timeout: 15_000 }).toBe(0);
  await closeDialogs(page);
});

for (const viewport of TABLET_VIEWPORTS) {
  test(`at ${viewport.width}x${viewport.height} the Pets board has no page scroll; the pet sheet keeps 48 px controls`, async ({}, testInfo) => {
    desktopOnly(testInfo);
    const page = tabletPage();
    await page.setViewportSize(viewport);
    await openPets(page);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight && document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByTestId('tablet-pet-more-tab-meds').click();
    await expect(page.getByTestId('tablet-pet-sheet')).toBeVisible();
    for (const testId of ['tablet-pet-tab-medication', 'tablet-pet-tab-profile', 'tablet-give-course-e2e']) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(48);
    }
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
    await closeDialogs(page);
  });
}

test('D3 and D4: Done with the pet sheet open ends the remembered person; Back closes the topmost dialog and stays on Pets', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await page.setViewportSize(TABLET_VIEWPORTS[0]);
  await forgetFace(page);
  await openPets(page);
  // Someone is remembered (a note as the kid).
  await page.getByTestId('tablet-pet-more-tab-meds').click();
  await page.getByTestId('tablet-pet-tab-notes').click();
  await page.getByTestId('tablet-note-text').fill('Napped in the sun');
  await page.getByTestId('tablet-note-save').click();
  await pick(page, KID.uid);
  await expect(page.getByTestId('tablet-acting')).toBeVisible();
  await page.getByTestId('tablet-done').click();
  await expect(page.getByTestId('tablet-acting')).toHaveCount(0);
  // Back: the Give dose dialog first, then the sheet, never leaving Pets.
  await page.getByTestId('tablet-pet-more-tab-meds').click();
  await page.getByTestId('tablet-give-course-e2e').click();
  await expect(page.getByTestId('give-dose-dialog')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('give-dose-dialog')).toHaveCount(0);
  await expect(page.getByTestId('tablet-pet-sheet')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('tablet-pet-sheet')).toHaveCount(0);
  await expect(page.getByTestId('tablet-view-pets')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/pets');
});

test('D6: a PIN-level action for someone with no tablet PIN says so at once (no pad) and offers someone else', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await forgetFace(page);
  await openPets(page);
  await page.getByTestId('tablet-pet-more-tab-meds').click();
  await page.getByTestId('tablet-pet-tab-notes').click();
  const noteId = (await pet('tab-meds').collection('notes').get()).docs[0].id;
  await page.getByTestId(`tablet-note-${noteId}`).getByRole('button', { name: /^(Pin|Unpin)$/ }).click();
  await pick(page, KID.uid);
  await expect(page.getByText(`${KID.name} has no tablet PIN. An adult can set one in Household > Members.`).first()).toBeVisible();
  await expect(page.getByTestId('pin-pad')).toHaveCount(0);
  // Someone else may act: "Who's here?" again.
  await expect(page.getByTestId('who-is-here')).toBeVisible();
  await closeDialogs(page);
});

test('Codex #190: a legacy medication shows on the tablet and its schedule is confirmed (PIN level)', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await pet('tab-meds').collection('medication-logs').doc('legacy-heartgard').set({ date: '2026-11-01', medication: 'Heartgard', dosage: '1 chew', nextDueDate: '2026-12-01', notes: '', loggedByUid: OWNER_UID, loggedByName: 'Owner' });
  await forgetFace(page);
  await openPets(page);
  await page.getByTestId('tablet-pet-more-tab-meds').click();
  await expect(page.getByTestId('tablet-legacy-heartgard')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('tablet-legacy-confirm-heartgard').click();
  await expect(page.getByTestId('tablet-course-form')).toBeVisible();
  await page.getByLabel('Every how many days').fill('30');
  await page.getByTestId('tablet-course-save').click();
  await pick(page, OWNER_UID);
  await expect(page.getByTestId('pin-pad')).toBeVisible();
  await enterPin(page, OWNER_PIN);
  await expect.poll(async () => (await pet('tab-meds').collection('medication-courses').where('legacyKeys', 'array-contains', 'heartgard').get()).size, { timeout: 15_000 }).toBe(1);
  await closeDialogs(page);
});

test('Codex #190: history merges both date shapes; Log weight tapped twice saves one weighing', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  const care = pet('tab-care').collection('care-logs');
  for (let index = 0; index < 13; index += 1) await care.doc(`old-${index}`).set({ date: `2025-01-${String(index + 1).padStart(2, '0')}`, activity: `Old walk ${index}`, notes: '', loggedByUid: OWNER_UID, loggedByName: 'Owner' });
  await care.doc('new-stamped').set({ date: Timestamp.now(), activity: 'Brushed today', notes: '', loggedByUid: OWNER_UID, loggedByName: 'Owner' });
  await forgetFace(page);
  await openPets(page);
  await page.getByTestId('tablet-pet-more-tab-care').click();
  await page.getByTestId('tablet-pet-tab-history').click();
  await expect(page.getByTestId('tablet-log-new-stamped')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('tablet-pet-tab-weight').click();
  await page.getByTestId('tablet-weight-value').fill('7.5');
  await page.getByTestId('tablet-weight-save').dblclick();
  await pick(page, KID.uid);
  await expect.poll(async () => (await pet('tab-care').collection('weights').get()).size, { timeout: 15_000 }).toBe(1);
  await page.waitForTimeout(1500);
  expect((await pet('tab-care').collection('weights').get()).size).toBe(1);
  await closeDialogs(page);
});
