import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { fixedNow } from './test-helpers';

// M5/M6: shorter forms with presets and calendar anchoring (MA-15, MA-11g), the unsaved-changes
// guard (MA-24f), the receipt picker and the AI receipt reader with the deterministic provider
// (MA-16, MA-30), delete with attachments (MA-22) and Update mileage (MA-19).
const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const adminApp = getApps().find((app) => app.name === 'maintenance-m56')
  || initializeApp({ projectId, storageBucket: `${projectId}.appspot.com` }, 'maintenance-m56');
const household = getFirestore(adminApp).collection('households').doc(householdId);
const bucket = getStorage(adminApp).bucket();
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');

// A real 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function open(page: Page, path: string, { realClock = false } = {}) {
  // Playwright's fixed time also freezes the page's timers (they are scheduled on the fake clock,
  // which never advances), so flows with a bounded wait (the receipt reading) use the real clock.
  if (!realClock) await page.clock.setFixedTime(fixedNow);
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Maintenance Center', exact: true })).toBeVisible();
}

/** Prints the page's console errors and uncaught exceptions with the test output (diagnosis on failure). */
function logPageErrors(page: Page) {
  page.on('console', (message) => { if (message.type() === 'error') console.log(`[page console] ${message.text()}`); });
  page.on('pageerror', (error) => console.log(`[page error] ${error.message}`));
}

async function removeTestRecords() {
  const [assets, vehicles, logs] = await Promise.all([
    household.collection('home-assets').get(),
    household.collection('vehicles').get(),
    household.collection('maintenance').where('title', 'in', ['Receipt log E2E', 'Late receipt E2E']).get(),
  ]);
  const ours = [
    ...assets.docs.filter((d) => /^Test .* M56 E2E$/.test(String(d.get('name')))),
    ...vehicles.docs.filter((d) => /^Test .* M56 E2E$/.test(String(d.get('nickname')))),
    ...logs.docs,
  ];
  for (const document of ours) {
    const files = await household.collection('maintenance-attachments').where('targetId', '==', document.id).get();
    await Promise.all(files.docs.map((file) => file.ref.delete()));
    await document.ref.delete();
  }
}

test.describe('maintenance forms, receipts and deletes (M5/M6)', () => {
  test.beforeEach(async () => { await removeTestRecords(); });
  test.afterAll(async () => { await removeTestRecords(); });

  test('MA-15: Add Home Asset shows the essentials, presets add an anchored schedule, More details shows the rest', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/maintenance?tab=assets');
    await page.getByRole('button', { name: 'Add Home Asset' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add Home Asset' });
    await expect(dialog.getByLabel('Name', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Location / Room')).toBeVisible();
    await expect(dialog.getByLabel('Warranty Expiration')).toBeVisible();
    await expect(dialog.getByLabel('Lifetime warranty')).toBeVisible();
    await expect(dialog.getByLabel('Brand')).toHaveCount(0);
    await expect(dialog.getByLabel('Serial Number')).toHaveCount(0);

    await dialog.getByLabel('Name', { exact: true }).fill('Test Gutters M56 E2E');
    await dialog.getByLabel('Category').click();
    await page.getByRole('option', { name: 'Lawn / Outdoor' }).click();
    await dialog.getByLabel('Lifetime warranty').check();
    await dialog.getByRole('group', { name: 'Suggested schedules' }).getByRole('button', { name: /Clean gutters/ }).click();
    const schedule = dialog.getByText('Maintenance item #1', { exact: true }).locator('..').locator('..');
    await expect(schedule.getByLabel('Schedule Name')).toHaveValue('Clean gutters');
    await expect(schedule.getByLabel(/Keep it on a calendar day/)).toBeChecked();

    await dialog.getByRole('button', { name: 'More details' }).click();
    await expect(dialog.getByLabel('Brand')).toBeVisible();
    await dialog.getByLabel('Brand').fill('Gutter Co');
    await dialog.getByRole('button', { name: 'Save Asset' }).click();
    await expect(dialog).toHaveCount(0);

    await expect.poll(async () => (await household.collection('home-assets').where('name', '==', 'Test Gutters M56 E2E').get()).size).toBe(1);
    const asset = (await household.collection('home-assets').where('name', '==', 'Test Gutters M56 E2E').get()).docs[0].data();
    expect(asset).toMatchObject({ warrantyLifetime: true, brand: 'Gutter Co' });
    expect(asset.warrantyExpiration).toBeUndefined();
    expect(asset.schedules[0]).toMatchObject({ scheduleName: 'Clean gutters', anchor: 'calendar', anchorMonth: 10, anchorDay: 1, nextDueDate: '2026-10-01' });

    // An edit opens with the filled details shown and "Add details (N empty)" for the rest.
    await page.getByRole('button', { name: /Test Gutters M56 E2E/ }).first().click();
    await page.getByRole('button', { name: 'Edit home asset Test Gutters M56 E2E' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit Home Asset' });
    await expect(edit.getByLabel('Brand')).toHaveValue('Gutter Co');
    await expect(edit.getByLabel('Serial Number')).toHaveCount(0);
    await edit.getByRole('button', { name: /^Add details \(\d+ empty\)$/ }).click();
    await expect(edit.getByLabel('Serial Number')).toBeVisible();
    await edit.getByRole('button', { name: 'Cancel' }).click();
    await expect(edit).toHaveCount(0);
  });

  test('MA-24f: a dirty form asks before Escape or Cancel discards it; a clean one closes at once', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/maintenance?tab=vehicles');
    await page.getByRole('button', { name: 'Add Vehicle' }).click();
    let dialog = page.getByRole('dialog', { name: 'Add Vehicle' });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await page.getByRole('button', { name: 'Add Vehicle' }).click();
    dialog = page.getByRole('dialog', { name: 'Add Vehicle' });
    await dialog.getByLabel('Nickname').fill('Test Draft M56 E2E');
    await page.keyboard.press('Escape');
    const confirm = page.getByRole('alertdialog', { name: 'Discard your changes?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Keep editing' }).click();
    await expect(dialog.getByLabel('Nickname')).toHaveValue('Test Draft M56 E2E');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('alertdialog', { name: 'Discard your changes?' }).getByRole('button', { name: 'Discard' }).click();
    await expect(dialog).toHaveCount(0);
    expect((await household.collection('vehicles').where('nickname', '==', 'Test Draft M56 E2E').get()).size).toBe(0);
  });

  test('MA-15 phones: the log form is a full-screen sheet with Cancel and Save on screen', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium');
    await open(page, '/maintenance');
    // The page header's button (the dialog is titled "Add Maintenance Log").
    await page.getByRole('button', { name: 'Add Log', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add Maintenance Log' });
    const viewport = page.viewportSize()!;
    const box = (await dialog.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(viewport.width - 1);
    for (const name of ['Cancel', 'Save Log']) {
      const button = (await dialog.getByRole('button', { name, exact: true }).boundingBox())!;
      expect(button.y + button.height).toBeLessThanOrEqual(viewport.height);
    }
  });

  test('MA-16/MA-30: a receipt is read with AI, confirmed without overwriting what was typed, and attached on save', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    test.setTimeout(90_000);
    logPageErrors(page);
    await open(page, '/maintenance', { realClock: true });
    // The page header's button (the dialog is titled "Add Maintenance Log").
    await page.getByRole('button', { name: 'Add Log', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add Maintenance Log' });
    await dialog.getByLabel('Title').fill('Receipt log E2E');
    await dialog.getByLabel('Cost').fill('10');
    const picker = dialog.getByTestId('receipt-picker');
    // Camera on phones (accept image/*, capture) and a plain file picker.
    await expect(picker.getByLabel('Take a photo of the receipt')).toHaveAttribute('capture', 'environment');
    await picker.getByLabel('Choose receipt or photo files').setInputFiles([
      { name: 'receipt.png', mimeType: 'image/png', buffer: PNG },
      { name: 'invoice.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') },
    ]);
    await expect(picker.getByText('receipt.png', { exact: true })).toBeVisible();
    await expect(picker.getByText(/invoice\.svg can't be attached/)).toBeVisible();

    await picker.getByRole('button', { name: 'Read receipt' }).click();
    const result = dialog.getByTestId('receipt-read-result');
    const readError = dialog.getByTestId('receipt-read-error');
    // The first call compiles the new server action in the dev server, which can take longer than
    // the default 10 s; the reading itself is bounded at 30 s (then the error note shows instead).
    await expect(result.or(readError)).toBeVisible({ timeout: 40_000 });
    await expect(readError).toHaveCount(0);
    await expect(result).toContainText('Comfort Air Services');
    await expect(result).toContainText('you already entered one; yours stays');
    await result.getByRole('button', { name: 'Use these' }).click();
    await expect(dialog.getByLabel('Cost')).toHaveValue('10');
    await expect(dialog.getByLabel('Service Provider')).toHaveValue('Comfort Air Services');
    await expect(dialog.getByLabel('Parts Used')).toHaveValue('MERV 11 filter 16x25x1');

    await dialog.getByRole('button', { name: 'Save Log' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await household.collection('maintenance').where('title', '==', 'Receipt log E2E').get()).size).toBe(1);
    const log = (await household.collection('maintenance').where('title', '==', 'Receipt log E2E').get()).docs[0];
    expect(log.data()).toMatchObject({ cost: 10, serviceProvider: 'Comfort Air Services' });
    await expect.poll(async () => (await household.collection('maintenance-attachments').where('targetId', '==', log.id).get()).size).toBe(1);
    const attachment = (await household.collection('maintenance-attachments').where('targetId', '==', log.id).get()).docs[0].data();
    expect(attachment).toMatchObject({ targetType: 'maintenance_log', category: 'receipt', fileName: 'receipt.png', contentType: 'image/png' });
    await expect(page.getByText('Receipt attached', { exact: true })).toBeVisible();
  });

  test('MA-30: a late reading is ignored after the receipt is removed, and the log still saves', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    logPageErrors(page);
    await open(page, '/maintenance', { realClock: true });
    // The page header's button (the dialog is titled "Add Maintenance Log").
    await page.getByRole('button', { name: 'Add Log', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add Maintenance Log' });
    await dialog.getByLabel('Title').fill('Late receipt E2E');
    const picker = dialog.getByTestId('receipt-picker');
    // The deterministic provider answers this one after 3 s.
    await picker.getByLabel('Choose receipt or photo files').setInputFiles({ name: 'ai-test:slow receipt.png', mimeType: 'image/png', buffer: PNG });
    await picker.getByRole('button', { name: 'Read receipt' }).click();
    await expect(picker.getByRole('button', { name: 'Reading receipt…' })).toBeVisible();
    await picker.getByRole('button', { name: 'Remove ai-test:slow receipt.png' }).click();
    await page.waitForTimeout(4_000);
    await expect(dialog.getByTestId('receipt-read-result')).toHaveCount(0);
    await expect(dialog.getByLabel('Cost')).toHaveValue('');
    await dialog.getByRole('button', { name: 'Save Log' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await household.collection('maintenance').where('title', '==', 'Late receipt E2E').get()).size).toBe(1);
  });

  test('MA-22: an asset is deleted with its attachments in one confirmed operation; its logs stay', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const assetRef = household.collection('home-assets').doc('test-delete-m56-e2e');
    await assetRef.set({ householdId, name: 'Test Delete M56 E2E', category: 'Appliance', status: 'active', schedules: [], createdAt: 'x', updatedAt: 'x' });
    const path = `households/${householdId}/maintenance/home_asset/test-delete-m56-e2e/1-manual.txt`;
    await bucket.file(path).save(Buffer.from('manual'), { contentType: 'text/plain' });
    await household.collection('maintenance-attachments').doc('test-delete-m56-file').set({
      householdId, targetType: 'home_asset', targetId: 'test-delete-m56-e2e', category: 'manual', fileName: 'manual.txt', filePath: path,
      uploadedByUid: 'seed', createdAt: '2026-08-01T00:00:00.000Z',
    });
    const logRef = household.collection('maintenance').doc('test-delete-m56-log');
    await logRef.set({ householdId, targetType: 'home_asset', assetId: 'test-delete-m56-e2e', title: 'Delete history M56 E2E', date: '2026-07-01', type: 'repair' });
    try {
      await open(page, '/maintenance?asset=test-delete-m56-e2e');
      await page.getByRole('button', { name: 'Delete home asset Test Delete M56 E2E' }).click();
      const confirm = page.getByRole('alertdialog', { name: 'Delete home asset Test Delete M56 E2E?' });
      await expect(confirm).toContainText(/attachment/);
      await confirm.getByRole('button', { name: /^Delete (Home Asset|Test Delete M56 E2E and its 1 attachment)$/ }).click();
      // Closes only after the whole delete answered (record, history, files, reminders).
      await expect(confirm).toHaveCount(0);
      await expect.poll(async () => (await assetRef.get()).exists).toBe(false);
      expect((await household.collection('maintenance-attachments').doc('test-delete-m56-file').get()).exists).toBe(false);
      expect((await bucket.file(path).exists())[0]).toBe(false);
      expect((await logRef.get()).data()).toMatchObject({ targetType: 'general', formerTargetType: 'home_asset', formerTargetName: 'Test Delete M56 E2E' });
    } finally {
      await Promise.all([assetRef.delete(), logRef.delete(), household.collection('maintenance-attachments').doc('test-delete-m56-file').delete()]);
    }
  });

  // Needs the page wiring of UpdateMileageButton on the vehicle card/detail panel (owned by the
  // page/cards change); remove fixme once it is wired.
  test.fixme('MA-19: Update mileage from a vehicle with the lower-reading correction and Undo', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const suv = household.collection('vehicles').doc('family-suv');
    const before = (await suv.get()).data()!;
    try {
      await open(page, '/maintenance?vehicle=family-suv');
      await page.getByRole('button', { name: /^Update mileage for / }).first().click();
      const dialog = page.getByTestId('update-mileage-dialog');
      await expect(dialog.getByLabel('Odometer (miles)')).toHaveValue(String(before.currentMileage));
      await dialog.getByLabel('Odometer (miles)').fill(String(before.currentMileage - 100));
      await dialog.getByRole('button', { name: 'Save mileage' }).click();
      await expect(dialog.getByRole('alert')).toContainText("corrects the vehicle's odometer down");
      await dialog.getByRole('button', { name: 'Save correction' }).click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(async () => (await suv.get()).get('currentMileage')).toBe(before.currentMileage - 100);
      await page.getByRole('button', { name: /^Undo the mileage update/ }).click();
      await expect.poll(async () => (await suv.get()).get('currentMileage')).toBe(before.currentMileage);
    } finally {
      await suv.update({ currentMileage: before.currentMileage, mileageUpdatedAt: before.mileageUpdatedAt ?? null });
    }
  });
});
