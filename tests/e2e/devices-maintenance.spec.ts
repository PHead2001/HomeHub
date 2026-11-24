import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import {
  KID,
  OWNER_PIN,
  TABLET_VIEWPORTS,
  createDeviceCode,
  enterPin,
  householdRef,
  openTabletContext,
  pairWithCode,
  prepareHousehold,
  promptReady,
  removeEveryTablet,
  restoreHousehold,
  setOwnerPin,
} from './devices-helpers';

// Maintenance on a registered wall tablet against the emulators (M8b; docs/modules/devices/
// README.md, "Maintenance on the tablet"; WT-4, WT-6, WT-20, WT-22, MA-26): at 1263x818 the
// paired tablet shows Maintenance when its section is on, Needs doing filtered to the tablet's
// room with "All rooms"; Done for a face-chosen person with Undo; a person without the
// permission sees the refusal; a schedule edit asks for the PIN; offline Done waits and syncs
// once; the section switched off leaves the rail; a removed tablet stops.

const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium', 'tablet journeys run once, in their own tablet-sized browser');
const OWNER_UID = 'e2e-owner-uid';

test.describe.configure({ mode: 'serial' });

let tablet: { context: BrowserContext; page: Page; deviceId: string } | null = null;
const tabletPage = () => tablet!.page;
const asset = (id: string) => householdRef.collection('home-assets').doc(id);
const seeded: string[] = [];

/** Today's household day (America/Chicago): device actions run on the real clock, and so does the tablet page. */
const chicagoDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());

/** A home asset with one schedule due today, in a room. */
const seedAsset = async (id: string, name: string, location: string) => {
  seeded.push(id);
  await asset(id).set({
    householdId: householdRef.id, name, category: 'HVAC', location, status: 'active', createdAt: 'x', updatedAt: 'x',
    schedules: [{ id: 'filter', mode: 'scheduled', scheduleName: `Filter ${id}`, frequencyType: 'months', intervalValue: 3, nextDueDate: chicagoDay() }],
  });
};
const filterOf = async (id: string) => ((await asset(id).get()).get('schedules') as Array<Record<string, unknown>>)[0];

// Ends the remembered face, if one is showing (a click on an absent button would wait out the test).
const forget = async (page: Page) => {
  const done = page.getByTestId('tablet-done');
  if (await done.isVisible().catch(() => false)) await done.click();
};

const openMaintenance = async (page: Page) => {
  // The tablet page is shared by the tests: when an earlier test left it on Maintenance, stay there
  // (start over on Home first so each test begins from the default room view).
  if (await page.getByTestId('tablet-view-maintenance').isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Home', exact: true }).click();
  }
  await page.getByTestId('tablet-rail-more').click();
  await page.getByTestId('tablet-more-maintenance').click();
  await expect(page.getByTestId('tablet-view-maintenance')).toBeVisible();
  await expect(page.getByTestId('tablet-maintenance-needs')).toBeVisible({ timeout: 20_000 });
};

const pick = async (page: Page, uid: string) => {
  await expect(page.getByTestId('who-is-here')).toBeVisible();
  await promptReady(page, 'who-is-here');
  await page.getByTestId(`who-person-${uid}`).click();
};

// The completion check is a checkbox (CompletionCheck), as on the personal page.
const markDone = (page: Page, id: string, name: string) => page.getByRole('checkbox', { name: `Mark done: Filter ${id} for ${name}` });

test.beforeAll(async () => {
  await prepareHousehold();
  await householdRef.update({ devicePolicy: { pointsPin: 'everyone' } });
  await seedAsset('tab-furnace', 'Kitchen furnace', 'Kitchen');
  await seedAsset('tab-garage', 'Garage heater', 'Garage');
});

test.afterAll(async () => {
  await tablet?.context.close();
  await removeEveryTablet();
  await Promise.all(seeded.map((id) => asset(id).delete().catch(() => undefined)));
  const logs = await householdRef.collection('maintenance').where('assetId', 'in', ['tab-furnace', 'tab-garage', 'tab-offline']).get();
  // (the record-sheet logs tab-log-2020..2025 are on tab-furnace)
  await Promise.all(logs.docs.map((d) => d.ref.delete()));
  await householdRef.update({ devicePolicy: { pointsPin: 'off' } }).catch(() => undefined);
  await restoreHousehold();
});

test('setup: the owner sets a tablet PIN and pairs a Kitchen tablet at 1263x818', async ({ page, browser }, testInfo) => {
  desktopOnly(testInfo);
  test.setTimeout(90_000);
  await setOwnerPin(page);
  const code = await createDeviceCode(page, 'Maintenance tablet', 'Kitchen');
  const opened = await openTabletContext(browser, TABLET_VIEWPORTS[0]);
  const deviceId = await pairWithCode(opened.page, code);
  tablet = { ...opened, deviceId };
});

test("Needs doing shows the tablet's room by default; All rooms shows the rest", async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await openMaintenance(page);
  await expect(page.getByTestId('tablet-maintenance-needs')).toHaveAttribute('data-room', 'Kitchen');
  await expect(markDone(page, 'tab-furnace', 'Kitchen furnace')).toBeVisible();
  await expect(markDone(page, 'tab-garage', 'Garage heater')).toHaveCount(0);
  await page.getByRole('button', { name: 'All rooms' }).click();
  await expect(markDone(page, 'tab-garage', 'Garage heater')).toBeVisible();
  await page.getByRole('button', { name: /^Kitchen, / }).click();
  await expect(markDone(page, 'tab-garage', 'Garage heater')).toHaveCount(0);
  // No sideways scroll at the tablet's size.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('Done for a face-chosen person (never the points PIN), with the tablet recorded; Undo puts it back', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await forget(page);
  await openMaintenance(page);
  await markDone(page, 'tab-furnace', 'Kitchen furnace').click();
  await pick(page, OWNER_UID);
  // The household's points PIN is Everyone: maintenance still never asks for it.
  await expect(page.getByTestId('pin-pad')).toHaveCount(0);
  await expect.poll(async () => ((await filterOf('tab-furnace')).lastCompletion as { byUid?: string } | undefined)?.byUid, { timeout: 15_000 }).toBe(OWNER_UID);
  const logs = await householdRef.collection('maintenance').where('assetId', '==', 'tab-furnace').get();
  expect(logs.size).toBe(1);
  expect(logs.docs[0].get('doneByUid')).toBe(OWNER_UID);
  expect(logs.docs[0].get('deviceAttribution')).toMatchObject({ deviceId: tablet!.deviceId, actorUid: OWNER_UID, level: 'face' });
  await page.getByTestId('tablet-undo').first().click();
  await expect.poll(async () => (await filterOf('tab-furnace')).nextDueDate, { timeout: 15_000 }).toBe(chicagoDay());
  await expect.poll(async () => (await householdRef.collection('maintenance').where('assetId', '==', 'tab-furnace').get()).size, { timeout: 15_000 }).toBe(0);
});

test("a person without maintenance permissions sees the refusal and nothing is written", async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await forget(page);
  await openMaintenance(page);
  await markDone(page, 'tab-furnace', 'Kitchen furnace').click();
  await pick(page, KID.uid);
  await expect(page.getByText(`${KID.name}'s role doesn't allow that.`).first()).toBeVisible();
  expect((await filterOf('tab-furnace')).lastCompletion).toBeUndefined();
});

test('editing a schedule asks for the PIN and changes only that schedule', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await forget(page);
  await openMaintenance(page);
  await page.getByRole('button', { name: 'Open: Filter tab-furnace for Kitchen furnace' }).click();
  await expect(page.getByTestId('tablet-maintenance-record')).toBeVisible();
  await page.getByTestId('tablet-maintenance-edit-schedule').first().click();
  await page.getByTestId('tablet-maintenance-schedule-interval').fill('6');
  await page.getByTestId('tablet-maintenance-schedule-save').click();
  await pick(page, OWNER_UID);
  await expect(page.getByTestId('pin-pad')).toBeVisible();
  await enterPin(page, OWNER_PIN);
  await expect.poll(async () => (await filterOf('tab-furnace')).intervalValue, { timeout: 15_000 }).toBe(6);
  expect((await asset('tab-furnace').get()).get('name')).toBe('Kitchen furnace');
  const audit = await householdRef.collection('auditLogs').where('action', '==', 'device.action').get();
  expect(audit.docs.some((d) => d.get('details')?.capability === 'maintenance.editSchedules' && d.get('level') === 'pin')).toBe(true);
  await page.keyboard.press('Escape');
});

test('the record sheet lists the newest logs; a delete is confirmed first, even with an open PIN session', async ({}, testInfo) => {
  desktopOnly(testInfo);
  // Six logs whose document ids run oldest first: the sheet must show the newest five by date.
  const logs = householdRef.collection('maintenance');
  for (let year = 2020; year <= 2025; year += 1) {
    await logs.doc(`tab-log-${year}`).set({ householdId: householdRef.id, targetType: 'home_asset', assetId: 'tab-furnace', title: `Service ${year}`, item: `Service ${year}`, date: `${year}-06-01`, type: 'routine', createdAt: 'x', updatedAt: 'x' });
  }
  const page = tabletPage();
  // The owner stays chosen with the PIN session from the schedule edit (no "Done" here).
  await openMaintenance(page);
  await page.getByRole('button', { name: 'Open: Filter tab-furnace for Kitchen furnace' }).click();
  await expect(page.getByTestId('tablet-maintenance-log-tab-log-2025')).toBeVisible();
  await expect(page.getByTestId('tablet-maintenance-log-tab-log-2020')).toHaveCount(0);
  // Delete asks first, naming the log; Cancel keeps it.
  await page.getByTestId('tablet-maintenance-delete-log-tab-log-2025').click();
  await expect(page.getByTestId('tablet-maintenance-delete-confirm')).toContainText('Delete maintenance log "Service 2025"?');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('tablet-maintenance-delete-confirm')).toHaveCount(0);
  expect((await logs.doc('tab-log-2025').get()).exists).toBe(true);
  // Confirmed, it is deleted (the PIN pad only if the session ended meanwhile).
  await page.getByTestId('tablet-maintenance-delete-log-tab-log-2025').click();
  await page.getByTestId('tablet-maintenance-delete-confirm-button').click();
  if (await page.getByTestId('who-is-here').isVisible().catch(() => false)) await pick(page, OWNER_UID);
  if (await page.getByTestId('pin-pad').isVisible().catch(() => false)) await enterPin(page, OWNER_PIN);
  await expect.poll(async () => (await logs.doc('tab-log-2025').get()).exists, { timeout: 15_000 }).toBe(false);
  await page.keyboard.press('Escape');
});

test('offline: Done waits on the tablet and syncs once when the connection is back', async ({}, testInfo) => {
  desktopOnly(testInfo);
  await seedAsset('tab-offline', 'Kitchen boiler', 'Kitchen');
  const page = tabletPage();
  await forget(page);
  await openMaintenance(page);
  await expect(markDone(page, 'tab-offline', 'Kitchen boiler')).toBeVisible();
  await tablet!.context.setOffline(true);
  await markDone(page, 'tab-offline', 'Kitchen boiler').click();
  await pick(page, OWNER_UID);
  await expect(page.getByText('Saved on this tablet. It syncs when the connection is back.').first()).toBeVisible();
  expect((await filterOf('tab-offline')).lastCompletion).toBeUndefined();
  await tablet!.context.setOffline(false);
  await expect.poll(async () => ((await filterOf('tab-offline')).lastCompletion as { byUid?: string } | undefined)?.byUid, { timeout: 45_000 }).toBe(OWNER_UID);
  expect((await householdRef.collection('maintenance').where('assetId', '==', 'tab-offline').get()).size).toBe(1);
});

test('the section switched off leaves the rail; a removed tablet stops', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await householdRef.collection('devices').doc(tablet!.deviceId).update({ 'sections.maintenance': false });
  await page.getByTestId('tablet-rail-more').click();
  await expect(page.getByTestId('tablet-more-maintenance')).toHaveCount(0, { timeout: 15_000 });
  await page.keyboard.press('Escape');
  await householdRef.collection('devices').doc(tablet!.deviceId).update({ 'sections.maintenance': true });
  await removeEveryTablet();
  await expect(page.getByText('This tablet was removed.')).toBeVisible({ timeout: 30_000 });
});
