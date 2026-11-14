import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import {
  KID,
  OWNER_PIN,
  TABLET_VIEWPORTS,
  createDeviceCode,
  deviceRecord,
  enterPin,
  householdRef,
  openTabletContext,
  pairWithCode,
  prepareHousehold,
  removeEveryTablet,
  restoreHousehold,
  setOwnerPin,
} from './devices-helpers';

// The registered wall tablet's shell against the emulators (docs/modules/devices/README.md,
// "Tablet shell", "Protected exit and Tablet settings", "Revocation on the tablet"; design
// 13-14; WT-5, WT-8, WT-9, WT-11, WT-14, WT-16, WT-19, D-T1-D-T18): the household resting
// view at the measured sizes, sections and deep links, local quick add (read-only tablet
// until F4), "Who's here?", the PIN pad (wrong, right, lockout), admin settings live, the
// idle return and the ambient screen, the protected exit, and a removal observed.

const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium', 'tablet journeys run once, in their own tablet-sized browser');

test.describe.configure({ mode: 'serial' });

let tablet: { context: BrowserContext; page: Page } | null = null;
let deviceId = '';

const tabletPage = () => tablet!.page;

test.beforeAll(async () => {
  await prepareHousehold();
});

test.afterAll(async () => {
  await tablet?.context.close();
  await removeEveryTablet();
  await restoreHousehold();
});

test('setup: the owner sets a tablet PIN in Profile and pairs a tablet', async ({ page, browser }, testInfo) => {
  desktopOnly(testInfo);
  test.setTimeout(90_000);
  await setOwnerPin(page);
  const code = await createDeviceCode(page, 'Kitchen tablet', 'Kitchen');
  tablet = await openTabletContext(browser);
  deviceId = await pairWithCode(tabletPage(), code);
});

test('resting view: the household brief, nothing personal, one screen at every measured size', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await expect(page.getByTestId('tablet-view-home')).toBeVisible();
  // Tablet default text size 115 % (PR-14, WT-14j).
  await expect(page.locator('html')).toHaveAttribute('data-text-scale', '115');
  const brief = page.getByTestId('morning-brief');
  await expect(brief).toBeVisible({ timeout: 20_000 });
  await expect(brief).not.toContainText('Alex');
  await expect(brief).not.toContainText('needs you');
  // No AI rewrite, no Home Wrapped download, no keyboard hints on a tablet (JC-28, D-T15).
  await expect(page.getByTestId('brief-ai-rewrite')).toHaveCount(0);
  await expect(page.getByTestId('dashboard-shortcuts-hint')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Home Wrapped/i })).toHaveCount(0);
  // Clock and room in the top bar.
  await expect(page.getByTestId('tablet-clock')).toBeVisible();
  for (const viewport of TABLET_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(300);
    const overflow = await page.getByTestId('tablet-main').evaluate((main) => main.scrollHeight - main.clientHeight);
    expect(overflow, `no scroll on the resting view at ${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(1);
    // 48 px touch targets on the rail, the Add button and the top bar.
    for (const id of ['tablet-rail-home', 'tablet-rail-chores', 'tablet-rail-more', 'tablet-add', 'tablet-settings-button', 'tablet-notices-button']) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, id).not.toBeNull();
      expect(Math.min(box!.width, box!.height), `${id} hit area`).toBeGreaterThanOrEqual(48);
    }
  }
  await page.setViewportSize(TABLET_VIEWPORTS[0]);
});

test('sections: a switched-off section leaves the rail and its deep link lands on the start page', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await expect(page.getByTestId('tablet-rail-shopping')).toBeVisible();
  await householdRef.collection('devices').doc(deviceId).update({ 'sections.shopping': false });
  await expect(page.getByTestId('tablet-rail-shopping')).toHaveCount(0);
  await page.goto('/shopping?list=anything');
  await expect(page.getByTestId('tablet-view-home')).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/$/);
  // Pages a tablet never shows land on the start page too.
  await page.goto('/profile');
  await expect(page.getByTestId('tablet-view-home')).toBeVisible({ timeout: 30_000 });
  await householdRef.collection('devices').doc(deviceId).update({ 'sections.shopping': true });
  await expect(page.getByTestId('tablet-rail-shopping')).toBeVisible();
  await page.getByTestId('tablet-rail-pets').click();
  await expect(page.getByTestId('tablet-view-pets')).toBeVisible();
  await expect(page.getByTestId('tablet-pet-maple')).toBeVisible();
});

test('quick add matches locally; every write is refused until the device actions exist', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await page.getByTestId('tablet-add').click();
  await page.getByTestId('tablet-quick-add-input').fill('feed maple');
  const intent = page.getByTestId('tablet-quick-add-intent').filter({ hasText: 'Feed Maple' });
  await expect(intent).toBeVisible();
  await intent.click();
  await expect(page.getByText("That isn't available on wall tablets yet. Use your phone.").first()).toBeVisible();
  await expect(page.getByTestId('who-is-here')).toHaveCount(0);
});

test('"Who\'s here?" and the PIN pad: eligible people only, wrong then right PIN, admin settings applied live', async ({}, testInfo) => {
  desktopOnly(testInfo);
  test.setTimeout(90_000);
  const page = tabletPage();
  await page.getByTestId('tablet-settings-button').click();
  await page.getByTestId('tablet-admin-settings').click();
  const who = page.getByTestId('who-is-here');
  await expect(who).toBeVisible();
  // Active owners, admins, members and kid profiles; never guests or pending people.
  for (const uid of ['e2e-owner-uid', 'e2e-admin-uid', 'e2e-member-uid', KID.uid]) await expect(page.getByTestId(`who-person-${uid}`)).toBeVisible();
  for (const uid of ['e2e-limited-uid', 'e2e-pending-uid']) await expect(page.getByTestId(`who-person-${uid}`)).toHaveCount(0);
  await expect(who.getByText('Kid profile')).toBeVisible();
  // A member's PIN is never enough for admin settings.
  await page.getByTestId('who-person-e2e-member-uid').click();
  await expect(page.getByTestId('who-note')).toHaveText('An owner or admin PIN is needed.');
  await page.getByTestId('who-person-e2e-owner-uid').click();
  await expect(page.getByTestId('pin-pad')).toBeVisible();
  await enterPin(page, '9137');
  await expect(page.getByTestId('pin-error')).toContainText("That PIN isn't right.");
  await enterPin(page, OWNER_PIN);
  await expect(page.getByTestId('pin-pad')).toHaveCount(0);
  await expect(page.getByTestId('tablet-acting')).toContainText('(PIN)');
  const room = page.getByLabel('Room');
  await room.fill('Hallway');
  await page.getByRole('button', { name: /^Save/ }).click();
  // Saving needs a PIN session at most 30 s old: the pad comes back if the unlock is older.
  if (await page.getByTestId('pin-pad').isVisible().catch(() => false)) await enterPin(page, OWNER_PIN);
  await expect(page.getByTestId('tablet-room')).toHaveText('Hallway');
  const record = await deviceRecord(deviceId);
  expect(record?.room).toBe('Hallway');
  expect(record?.updatedVia).toBe('tablet-admin-pin');
  const logged = await householdRef.collection('auditLogs').where('action', '==', 'device.settings_changed').where('deviceId', '==', deviceId).get();
  expect(logged.docs.some((d) => d.get('via') === 'device' && d.get('level') === 'pin')).toBe(true);
  // "Done" ends the unlock.
  await page.getByTestId('tablet-done').click();
  await expect(page.getByTestId('tablet-acting')).toHaveCount(0);
});

test('comfort settings for anyone, no PIN', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await page.getByTestId('tablet-settings-button').click();
  await page.getByTestId('tablet-text-130').click();
  await expect(page.locator('html')).toHaveAttribute('data-text-scale', '130');
  expect((await deviceRecord(deviceId))?.comfort?.textScale).toBe(130);
  await page.getByTestId('tablet-text-115').click();
  await expect(page.locator('html')).toHaveAttribute('data-text-scale', '115');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tablet-settings')).toHaveCount(0);
});

test('idle return to the start page after 2 minutes, then the ambient clock; a tap wakes it and never acts', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await householdRef.collection('devices').doc(deviceId).update({ startPage: { kind: 'pets' } });
  await expect(page.getByTestId('tablet-view-pets')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('tablet-rail-chores').click();
  await expect(page.getByTestId('tablet-view-chores')).toBeVisible();
  await page.clock.fastForward('02:05');
  await expect(page.getByTestId('tablet-view-pets')).toBeVisible();
  await expect(page).toHaveURL(/\/pets$/);
  await page.clock.fastForward('08:05');
  const ambient = page.getByTestId('tablet-ambient');
  await expect(ambient).toBeVisible();
  await expect(page.getByTestId('tablet-ambient-clock')).toBeVisible();
  await ambient.click();
  await expect(ambient).toHaveCount(0);
  await expect(page.getByTestId('tablet-view-pets')).toBeVisible();
  await householdRef.collection('devices').doc(deviceId).update({ startPage: { kind: 'home' } });
});

test('night dimming follows household quiet hours', async ({}, testInfo) => {
  desktopOnly(testInfo);
  const page = tabletPage();
  await householdRef.update({ quietHours: { start: '00:00', end: '23:59' } });
  await page.clock.fastForward('00:35');
  await expect(page.getByTestId('tablet-night-dim')).toBeVisible();
  await householdRef.update({ quietHours: null });
  await page.clock.fastForward('00:35');
  await expect(page.getByTestId('tablet-night-dim')).toHaveCount(0);
});

test('protected exit: "Use a different code" needs a fresh owner PIN, ends the credential and keeps the record', async ({}, testInfo) => {
  desktopOnly(testInfo);
  test.setTimeout(60_000);
  const page = tabletPage();
  await page.getByTestId('tablet-settings-button').click();
  await page.getByTestId('tablet-exit-new-code').click();
  await page.getByTestId('tablet-exit-continue').click();
  await page.getByTestId('who-person-e2e-owner-uid').click();
  await enterPin(page, OWNER_PIN);
  await expect(page.getByText('This tablet was signed out. Enter a new code to set it up again.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('Tablet code')).toBeVisible();
  const record = await deviceRecord(deviceId);
  expect(record?.status).toBe('unpaired');
  expect(record?.endedReason).toBe('new-code');
  const exited = await householdRef.collection('auditLogs').where('action', '==', 'device.exited').where('deviceId', '==', deviceId).get();
  expect(exited.size).toBe(1);
});

test('PIN lockout copy, then a removal from the Devices list is observed and everything is cleared', async ({ page: owner }, testInfo) => {
  desktopOnly(testInfo);
  test.setTimeout(90_000);
  const code = await createDeviceCode(owner, 'Kitchen tablet B', 'Kitchen');
  const page = tabletPage();
  deviceId = await pairWithCode(page, code);
  await page.getByTestId('tablet-settings-button').click();
  await page.getByTestId('tablet-admin-settings').click();
  await page.getByTestId('who-person-e2e-owner-uid').click();
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await enterPin(page, '9137');
    await expect(page.getByTestId('pin-error')).toContainText("That PIN isn't right.");
  }
  await enterPin(page, '9137');
  await expect(page.getByTestId('pin-error')).toHaveText('Too many tries. Try again in 1 min.');
  await page.getByRole('button', { name: 'Cancel' }).click();
  // The owner removes the tablet from the Devices list.
  await owner.goto('/household?tab=devices');
  await owner.getByRole('button', { name: 'Remove Kitchen tablet B' }).click();
  await owner.getByRole('button', { name: 'Remove tablet' }).click();
  await expect(page.getByText('This tablet was removed.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('Tablet code')).toBeVisible();
  // Protected local state is gone: the tablet database and the Firestore cache.
  const databases = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  expect(databases).not.toContain('homehub-device');
  expect((await deviceRecord(deviceId))?.status).toBe('removed');
});
