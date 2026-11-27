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
  promptReady,
  removeEveryTablet,
  restoreHousehold,
  setOwnerPin,
} from './devices-helpers';

// Shopping on a registered wall tablet against the emulators (docs/modules/devices/README.md,
// "Shopping on the tablet"; audit HP-33, HP-36, SH-11, SH-28; WT-6a, WT-11, WT-18c, WT-20): at
// 1263x818 the Shopping view is kitchen mode: the list's needed items by aisle with who added
// each ("Alex added · 2d"), a big quick add whose items are credited to the face chosen in
// "Who's here?" with the tablet recorded (never the points PIN) and taken back by Undo; a
// one-tap tick with Undo; "Mia is shopping · N left" while a member ticks elsewhere; the
// dashboard's Shopping tile ticks for a face too; the section switched off leaves the rail.

const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium', 'tablet journeys run once, in their own tablet-sized browser');
const OWNER_UID = 'e2e-owner-uid';
// Named to sort first, so the dashboard tile's first rows are this list's.
const LIST_ID = 'tab-kitchen-e2e';
const LIST_NAME = '0 Tablet kitchen E2E';

test.describe.configure({ mode: 'serial' });

let tablet: { context: BrowserContext; page: Page; deviceId: string } | null = null;
const tabletPage = () => tablet!.page;
const list = () => householdRef.collection('shopping-lists').doc(LIST_ID);
const item = (id: string) => list().collection('items').doc(id);
const itemsNamed = async (nameKey: string) => (await list().collection('items').where('nameKey', '==', nameKey).get()).docs;

const seedItem = (id: string, name: string, fields: Record<string, unknown> = {}) => item(id).set({
  name, nameKey: name.toLowerCase(), quantity: 1, category: 'Produce', categorySource: 'manual', status: 'needed', addedByUid: OWNER_UID,
  createdAt: Timestamp.fromMillis(Date.now() - 2 * 86_400_000 - 60_000), ...fields,
});

const forget = async (page: Page) => {
  const done = page.getByTestId('tablet-done');
  if (await done.isVisible().catch(() => false)) await done.click();
};

const pick = async (page: Page, uid: string) => {
  await expect(page.getByTestId('who-is-here')).toBeVisible();
  await promptReady(page, 'who-is-here');
  await page.getByTestId(`who-person-${uid}`).click();
};

const openKitchen = async (page: Page) => {
  await page.getByTestId('tablet-rail-shopping').click();
  await expect(page.getByTestId('tablet-view-shopping')).toBeVisible();
  const chip = page.getByTestId(`tablet-shopping-list-${LIST_ID}`);
  if (await chip.isVisible().catch(() => false)) await chip.click();
  await expect(page.getByRole('heading', { name: LIST_NAME })).toBeVisible({ timeout: 20_000 });
};

test.beforeAll(async () => {
  await prepareHousehold();
  // Shopping never asks for the points PIN (WT-22d), even with it set to Everyone.
  await householdRef.update({ devicePolicy: { pointsPin: 'everyone' } });
  await householdRef.firestore.recursiveDelete(list());
  await list().set({ name: LIST_NAME, type: 'Grocery', description: '', icon: 'ShoppingCart' });
  await seedItem('apples', 'Apples');
  await seedItem('bananas', 'Bananas');
  await seedItem('soap', 'Dish soap', { category: 'Household' });
});

test.afterAll(async () => {
  await tablet?.context.close();
  await removeEveryTablet();
  await householdRef.firestore.recursiveDelete(list()).catch(() => undefined);
  await householdRef.update({ devicePolicy: { pointsPin: 'off' } }).catch(() => undefined);
  await restoreHousehold();
});

test('setup: the owner sets a tablet PIN and pairs a Kitchen tablet at 1263x818', async ({ page, browser }, testInfo) => {
  desktopOnly(testInfo);
  test.setTimeout(90_000);
  await setOwnerPin(page);
  const code = await createDeviceCode(page, 'Shopping tablet', 'Kitchen');
  const opened = await openTabletContext(browser, TABLET_VIEWPORTS[0]);
  const deviceId = await pairWithCode(opened.page, code);
  tablet = { ...opened, deviceId };
});

test('kitchen mode: the needed items by aisle, who added each, and the quick add on screen', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await openKitchen(page);
  await expect(page.getByTestId('tablet-shopping-add-input')).toBeVisible();
  await expect(page.getByTestId('tablet-shopping-aisle').filter({ hasText: 'Produce' })).toContainText('Apples');
  await expect(page.getByTestId('tablet-shopping-aisle').filter({ hasText: 'Household' })).toContainText('Dish soap');
  await expect(page.getByTestId('tablet-shopping-attribution-apples')).toHaveText('Alex added · 2d');
  // No sideways scroll, and the page itself never scrolls.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('quick add: credited to the face chosen (no points PIN), the tablet recorded; Undo takes it back', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await forget(page);
  await openKitchen(page);
  await page.getByTestId('tablet-shopping-add-input').fill('milk, 2 bread');
  await page.getByTestId('tablet-shopping-add').click();
  await pick(page, OWNER_UID);
  await expect(page.getByTestId('pin-pad')).toHaveCount(0);
  await expect.poll(async () => (await itemsNamed('milk')).length, { timeout: 15_000 }).toBe(1);
  const [milk] = await itemsNamed('milk');
  expect(milk.get('addedByUid')).toBe(OWNER_UID);
  expect(milk.get('deviceAttribution')).toMatchObject({ deviceId: tablet!.deviceId, actorUid: OWNER_UID, level: 'face' });
  expect((await itemsNamed('bread'))[0].get('quantity')).toBe(2);
  await expect(page.getByTestId(`tablet-shopping-item-${milk.id}`)).toBeVisible();
  await expect(page.getByTestId('tablet-shopping-add-input')).toHaveValue('');
  await page.getByTestId('tablet-undo').first().click();
  await expect.poll(async () => (await itemsNamed('milk')).length + (await itemsNamed('bread')).length, { timeout: 15_000 }).toBe(0);
});

test('scan: a saved product goes on the list for the face chosen, from the tablet camera; an unknown code says to save it from a phone (BL-20)', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  const code = '000000000404';
  const product = householdRef.collection('barcode-library').doc(code);
  await product.set({ name: 'E2E Tablet Tin', imageUrl: '', createdAt: new Date().toISOString(), createdByUid: OWNER_UID });
  try {
    await forget(page);
    await openKitchen(page);
    await page.getByTestId('tablet-shopping-scan').click();
    const panel = page.getByTestId('tablet-scan-panel');
    await expect(panel).toBeVisible();
    // The test browser has no camera: the typed number is the scanner's other way in.
    await panel.getByLabel('Barcode number').fill(code);
    await panel.getByRole('button', { name: 'Use barcode' }).click();
    await pick(page, OWNER_UID);
    await expect(page.getByTestId('pin-pad')).toHaveCount(0);
    await expect.poll(async () => (await itemsNamed('e2e tablet tin')).length, { timeout: 15_000 }).toBe(1);
    const [tin] = await itemsNamed('e2e tablet tin');
    expect(tin.get('quantity')).toBe(1);
    expect(tin.get('deviceAttribution')).toMatchObject({ deviceId: tablet!.deviceId, actorUid: OWNER_UID, level: 'face' });
    await expect(panel.getByTestId('tablet-scan-line')).toContainText('E2E Tablet Tin is on');

    await panel.getByLabel('Barcode number').fill('000000000408');
    await panel.getByRole('button', { name: 'Use barcode' }).click();
    await expect(panel.getByTestId('tablet-scan-line')).toContainText('not in the household library yet');
    await panel.getByRole('button', { name: 'Done scanning' }).click();
    await expect(panel).toHaveCount(0);
  } finally {
    await product.delete();
    for (const doc of await itemsNamed('e2e tablet tin')) await doc.ref.delete();
  }
});

test('one tap ticks an item for the face chosen; Undo puts it back on the list', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await forget(page);
  await openKitchen(page);
  await page.getByTestId('tablet-shopping-item-bananas').click();
  await pick(page, OWNER_UID);
  await expect.poll(async () => (await item('bananas').get()).get('status'), { timeout: 15_000 }).toBe('purchased');
  const ticked = (await item('bananas').get()).data()!;
  expect(ticked.purchasedByUid).toBe(OWNER_UID);
  expect(ticked.purchaseDeviceAttribution).toMatchObject({ deviceId: tablet!.deviceId, actorUid: OWNER_UID, purchaseOpId: ticked.purchaseOpId });
  await expect(page.getByTestId('tablet-shopping-item-bananas')).toHaveCount(0);
  await page.getByTestId('tablet-undo').first().click();
  await expect.poll(async () => (await item('bananas').get()).get('status'), { timeout: 15_000 }).toBe('needed');
  await expect(page.getByTestId('tablet-shopping-item-bananas')).toBeVisible();
});

test('"Mia is shopping · N left" while a member ticks items elsewhere, live', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await openKitchen(page);
  await expect(page.getByTestId('tablet-shopping-activity')).toHaveCount(0);
  const now = Timestamp.now();
  await seedItem('kiwi', 'Kiwi', { status: 'purchased', purchasedByUid: KID.uid, purchasedAt: now, purchaseOpId: 'phone-kiwi' });
  await seedItem('lemons', 'Lemons', { status: 'purchased', purchasedByUid: KID.uid, purchasedAt: now, purchaseOpId: 'phone-lemons' });
  await expect(page.getByTestId('tablet-shopping-activity')).toHaveText(/Mia is shopping · \d+ left/, { timeout: 15_000 });
  await item('kiwi').delete();
  await item('lemons').delete();
  await expect(page.getByTestId('tablet-shopping-activity')).toHaveCount(0, { timeout: 15_000 });
});

test("the dashboard's Shopping tile ticks for a face (HP-33, HP-36)", async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await forget(page);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  const tick = page.getByTestId(`shopping-tick-${LIST_ID}-apples`);
  await expect(tick).toBeVisible({ timeout: 20_000 });
  // The palette's "+" is not on a tablet.
  await expect(page.getByTestId('tile-quick-add-add-item')).toHaveCount(0);
  await tick.click();
  await pick(page, OWNER_UID);
  await expect.poll(async () => (await item('apples').get()).get('purchasedByUid'), { timeout: 15_000 }).toBe(OWNER_UID);
  await page.getByTestId('tablet-undo').first().click();
  await expect.poll(async () => (await item('apples').get()).get('status'), { timeout: 15_000 }).toBe('needed');
});

test('a child cannot add (shopping.edit, as on a phone); the section switched off leaves the rail', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await forget(page);
  await openKitchen(page);
  await page.getByTestId('tablet-shopping-add-input').fill('Candy');
  await page.getByTestId('tablet-shopping-add').click();
  await pick(page, KID.uid);
  await expect(page.getByText(`${KID.name}'s role doesn't allow that.`).first()).toBeVisible();
  expect((await itemsNamed('candy')).length).toBe(0);
  await householdRef.collection('devices').doc(tablet!.deviceId).update({ 'sections.shopping': false });
  await expect(page.getByTestId('tablet-rail-shopping')).toHaveCount(0, { timeout: 15_000 });
  await householdRef.collection('devices').doc(tablet!.deviceId).update({ 'sections.shopping': true });
});
