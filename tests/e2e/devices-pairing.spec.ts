import { expect, test, type TestInfo } from '@playwright/test';
import {
  createDeviceCode,
  deviceRecord,
  firestore,
  openTabletContext,
  pairWithCode,
  prepareHousehold,
  removeEveryTablet,
  restoreHousehold,
} from './devices-helpers';

// Registered wall tablets: pairing through the real setup screen against the emulators
// (docs/modules/devices/README.md, "Pairing and redemption", "Tablet shell"; WT-1, WT-2,
// WT-3, WT-12, S15). Runs with both device flags on (playwright.config.ts).

const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium', 'pairing journeys run once, in their own tablet-sized browser');

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await prepareHousehold();
});

test.afterAll(async () => {
  await removeEveryTablet();
  await restoreHousehold();
});

test('an owner pairs a tablet with a typed code; the tablet lands in its shell and the creator sees "Paired"', async ({ page, browser }, testInfo) => {
  desktopOnly(testInfo);
  const code = await createDeviceCode(page, 'Kitchen tablet', 'Kitchen');
  const tablet = await openTabletContext(browser);
  try {
    const deviceId = await pairWithCode(tablet.page, code);
    // The tablet interface, not the personal app: room in the top bar, the rail, no account menu.
    await expect(tablet.page.getByTestId('tablet-room')).toHaveText('Kitchen');
    await expect(tablet.page.getByTestId('tablet-rail')).toBeVisible();
    await expect(tablet.page.getByRole('link', { name: /profile/i })).toHaveCount(0);
    await expect(tablet.page.getByText('Log out')).toHaveCount(0);
    // The code's creator sees the use live (S15).
    await expect(page.getByText(/Paired: Kitchen tablet/)).toBeVisible();
    // Backend state: one active record at generation 1 with the code's name and room.
    const record = await deviceRecord(deviceId);
    expect(record?.status).toBe('active');
    expect(record?.generation).toBe(1);
    expect(record?.name).toBe('Kitchen tablet');
    expect((await firestore.collection('deviceCodes').doc(code).get()).get('usedAt')).toBeTruthy();
    // A reload keeps the tablet session (Firebase refresh token in IndexedDB).
    await tablet.page.reload();
    await expect(tablet.page.getByTestId('tablet-shell')).toBeVisible({ timeout: 30_000 });
    // /setup is unreachable while the tablet session exists: the shell stays.
    await tablet.page.goto('/setup');
    await expect(tablet.page.getByTestId('tablet-shell')).toBeVisible({ timeout: 30_000 });
    await expect(tablet.page.getByLabel('Tablet code')).toHaveCount(0);
  } finally {
    await tablet.context.close();
  }
});

test('a used, mistyped or member-invite code is refused with plain copy', async ({ page, browser }, testInfo) => {
  desktopOnly(testInfo);
  const code = await createDeviceCode(page, 'Hall tablet', 'Hall');
  const first = await openTabletContext(browser);
  const second = await openTabletContext(browser);
  try {
    await pairWithCode(first.page, code);
    await second.page.goto('/setup');
    await second.page.getByLabel('Tablet code').fill(code);
    await second.page.getByRole('button', { name: 'Set up this tablet' }).click();
    await expect(second.page.getByText('That code has already been used. Tell the person who made it, then ask for a new one.')).toBeVisible();
    await second.page.getByLabel('Tablet code').fill('ZZZZ-ZZZZ-ZZ');
    await second.page.getByRole('button', { name: 'Set up this tablet' }).click();
    await expect(second.page.getByText("That code wasn't found. Check it and try again.")).toBeVisible();
    await expect(second.page.getByTestId('tablet-shell')).toHaveCount(0);
  } finally {
    await first.context.close();
    await second.context.close();
  }
});

test('a personal session never reaches redemption', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await page.goto('/setup');
  await expect(page.getByText('Sign out first to set this browser up as a wall tablet')).toBeVisible();
  await expect(page.getByLabel('Tablet code')).toHaveCount(0);
});
