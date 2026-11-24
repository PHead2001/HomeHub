import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getDeterministicNotificationId } from '../../src/lib/notifications';
import { fixedNow } from './test-helpers';

// Maintenance Center UX (wave 2): home health, in-place reminder actions,
// collapsed detail fields, photo-first asset cards, tab deep links and
// permission-aware controls. Runs against the seeded emulator household.

const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const adminApp = getApps().find((app) => app.name === 'maintenance-ux')
  || initializeApp({ projectId, storageBucket: `${projectId}.appspot.com` }, 'maintenance-ux');
const household = getFirestore(adminApp).collection('households').doc(householdId);
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');

const HVAC_SCHEDULES = [{
  id: 'asset-filter-e2e', mode: 'scheduled', scheduleName: 'Replace air filter', frequencyType: 'months',
  intervalValue: 3, lastCompletedDate: '2026-05-01', nextDueDate: '2026-08-01',
}];
const DISHWASHER_SCHEDULES = [{
  id: 'dishwasher-filter-e2e', mode: 'scheduled', scheduleName: 'Clean filter', frequencyType: 'months',
  intervalValue: 1, nextDueDate: '2026-08-08',
}];
const SUV_SCHEDULES = [
  {
    id: 'tire-rotation-e2e', mode: 'scheduled', serviceName: 'Tire rotation', intervalMiles: 6000,
    lastCompletedMileage: 43000, lastCompletedDate: '2026-04-15', nextDueMileage: 49000, nextDueDate: '2026-08-15',
  },
  {
    id: 'brake-fluid-e2e', mode: 'scheduled', serviceName: 'Brake fluid inspection', intervalMonths: 24,
    lastCompletedDate: '2024-08-20', nextDueDate: '2026-08-20',
  },
];
/** Log documents in the seed (scripts/e2e/seed.mjs); anything else linked to a seeded record was left by a test. */
const SEEDED_LOG_IDS = new Set(['oil-change', 'hvac-inspection', 'gutter-cleaning']);
const SEEDED_TARGETS = new Set(['hvac-main', 'dishwasher', 'family-suv']);
const HVAC_NOTIFICATION = getDeterministicNotificationId({
  sourceType: 'maintenance_asset_schedule', sourceId: 'hvac-main:asset-filter-e2e', stateKey: 'due_today|2026-08-01',
});

/**
 * Puts the maintenance records this spec reads back to the seed exactly: schedules, mileage, the HVAC
 * reminder notification, no extra photo, and no logs linked to seeded assets/vehicles except the
 * seeded ones. Runs before each test too, because other specs (verification-findings' completion
 * test) leave a completion log behind (a completion also moves a schedule). It also removes
 * leftover "Test … E2E" assets and vehicles (and their attachments) that another spec created and
 * could not delete after a failure: their schedules would change the home health score.
 */
async function restoreMaintenanceSeed() {
  const [logs, photos, extraAssets, extraVehicles] = await Promise.all([
    household.collection('maintenance').get(),
    household.collection('maintenance-attachments').where('fileName', '==', 'maintenance-ux-photo.png').get(),
    household.collection('home-assets').get(),
    household.collection('vehicles').get(),
  ]);
  const isLeftover = (document: { id: string; get: (field: string) => unknown }, nameField: string) => {
    const name = document.get(nameField);
    return !SEEDED_TARGETS.has(document.id) && typeof name === 'string' && /^Test .* E2E$/.test(name);
  };
  const leftovers = [
    ...extraAssets.docs.filter((document) => isLeftover(document, 'name')),
    ...extraVehicles.docs.filter((document) => isLeftover(document, 'nickname')),
  ];
  const leftoverAttachments = leftovers.length === 0 ? [] : (await Promise.all(leftovers.map((document) => (
    household.collection('maintenance-attachments').where('targetId', '==', document.id).get()
  )))).flatMap((snapshot) => snapshot.docs);
  const strayLogs = logs.docs.filter((log) => !SEEDED_LOG_IDS.has(log.id)
    && (SEEDED_TARGETS.has(log.get('assetId')) || SEEDED_TARGETS.has(log.get('vehicleId'))));
  await Promise.all([
    household.collection('home-assets').doc('hvac-main').update({ schedules: HVAC_SCHEDULES }),
    household.collection('home-assets').doc('dishwasher').update({ schedules: DISHWASHER_SCHEDULES }),
    household.collection('vehicles').doc('family-suv').update({
      serviceSchedules: SUV_SCHEDULES, currentMileage: 48750, registrationExpiration: '2026-08-12', inspectionExpiration: '2026-08-05',
    }),
    household.collection('notifications').doc(HVAC_NOTIFICATION).set({
      householdId,
      category: 'maintenance',
      title: 'HVAC filter due today',
      message: 'Replace the Main HVAC System air filter.',
      createdAt: Timestamp.fromDate(new Date('2026-08-01T08:00:00.000Z')),
      expiresAt: Timestamp.fromDate(new Date('2026-08-08T08:00:00.000Z')),
      deepLink: '/maintenance?asset=hvac-main&schedule=hvac-main%3Aasset-filter-e2e',
      sourceType: 'maintenance_asset_schedule',
      sourceId: 'hvac-main:asset-filter-e2e',
      stateKey: 'due_today|2026-08-01',
      audience: ['*'],
      readBy: {},
      dismissedBy: {},
    }),
    ...strayLogs.map((log) => log.ref.delete()),
    ...photos.docs.map((photo) => photo.ref.delete()),
    ...leftoverAttachments.map((attachment) => attachment.ref.delete()),
    ...leftovers.map((document) => document.ref.delete()),
  ]);
}

async function open(page: Page, path: string) {
  await page.clock.setFixedTime(fixedNow);
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Maintenance Center', exact: true })).toBeVisible();
}

test.describe('maintenance center UX', () => {
  // Every project: the spec must start from the seed whatever ran before it, and leave it as found.
  test.beforeEach(async () => { await restoreMaintenanceSeed(); });
  test.afterEach(async () => { await restoreMaintenanceSeed(); });

  test('H10: overview shows the home health score with its reasons, linked to the items', async ({ page }) => {
    await open(page, '/maintenance');
    const panel = page.getByTestId('maintenance-health');
    // MA-10: the average of the three tracked items. HVAC: flagged (−10) and filter due today (−5) = 85;
    // dishwasher (filter due soon) and SUV (service, registration and inspection due soon) cost nothing = 100.
    // Warranties and recent logs do not count. (85 + 100 + 100) / 3 = 95.
    const dial = panel.getByRole('img', { name: 'Home health 95 out of 100, in good shape.' });
    await expect(dial).toBeVisible();
    await expect(dial).toContainText('95');
    await expect(panel.getByText('In good shape', { exact: true })).toBeVisible();
    await expect(panel.getByText(/The average of 3 tracked items/)).toBeVisible();
    const reasons = panel.getByRole('list', { name: 'Score deductions' }).getByRole('listitem');
    await expect(reasons).toHaveText([
      /^−10Main HVAC System: flagged as needing attention/,
      /^−5Main HVAC System: Replace air filter is due today/,
    ]);
    await expect(panel.getByRole('button', { name: /^Show \d+ more$/ })).toHaveCount(0);
    const deduction = panel.getByRole('button', { name: /Main HVAC System: flagged as needing attention/ });
    await expect(deduction).toContainText('−10');
    await deduction.click();
    await expect(page.getByRole('tab', { name: 'Home Assets' })).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/\?asset=hvac-main$/);
    await expect(page.getByRole('img', { name: /^Main HVAC System health 85 out of 100/ }).first()).toBeVisible();
  });

  test('tabs are linkable with ?tab= and choosing a tab updates the URL', async ({ page }) => {
    await open(page, '/maintenance?tab=reminders');
    await expect(page.getByRole('tab', { name: 'Reminders' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Logs' }).click();
    await expect(page).toHaveURL(/\/maintenance\?tab=logs$/);
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Logs' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Overview' }).click();
    await expect(page).toHaveURL(/\/maintenance$/);
  });

  test('D16: reminder cards say the status once and can be snoozed or marked done in place', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await household.collection('home-assets').doc('dishwasher').update({
      schedules: [{ ...DISHWASHER_SCHEDULES[0], nextDueDate: '2026-07-01' }],
    });
    await open(page, '/maintenance?tab=reminders');

    const list = page.getByTestId('reminders-list');
    const overdue = page.getByTestId('reminders-group-overdue');
    const dishwasher = overdue.getByRole('listitem').filter({ hasText: 'Kitchen Dishwasher' });
    await expect(dishwasher.getByText('Overdue', { exact: true })).toHaveCount(1);
    await expect(dishwasher).toContainText('Due Jul 1, 2026 · 4 weeks ago');
    await expect(dishwasher).not.toContainText('is overdue');

    // Warranties expire; they are never "overdue" or "due".
    const warranty = page.getByTestId('reminders-group-due_soon').getByRole('listitem').filter({ hasText: 'Main HVAC System' });
    await expect(warranty.getByText('Expires soon', { exact: true })).toBeVisible();
    await expect(warranty.getByRole('checkbox', { name: /^Mark done/ })).toHaveCount(0);
    await expect(warranty.getByRole('button', { name: /^Log service/ })).toHaveCount(0);
    await expect(warranty.getByRole('button', { name: /^Snooze/ })).toHaveCount(0);

    await dishwasher.getByRole('button', { name: 'Snooze 1 week: Clean filter for Kitchen Dishwasher' }).click();
    // Radix also mirrors each toast into a screen-reader live region; target the visible title.
    await expect(page.getByText('Snoozed for a week', { exact: true })).toBeVisible();
    await expect.poll(async () => (await household.collection('home-assets').doc('dishwasher').get()).get('schedules')?.[0]?.nextDueDate)
      .toBe('2026-08-08');
    // The snooze is recorded so the hourly job stays quiet until that due date.
    expect((await household.collection('home-assets').doc('dishwasher').get()).get('schedules')?.[0]?.snoozedUntil).toBe('2026-08-08');
    await expect(overdue.getByRole('listitem').filter({ hasText: 'Kitchen Dishwasher' })).toHaveCount(0);
    // Still on the Reminders tab: the action happened in place.
    await expect(page.getByRole('tab', { name: 'Reminders' })).toHaveAttribute('aria-selected', 'true');

    const filter = list.getByRole('listitem').filter({ hasText: 'Replace air filter' });
    // H05 completion: the check fills at once, before the write returns.
    const check = filter.getByRole('checkbox', { name: 'Mark done: Replace air filter for Main HVAC System' });
    await check.click();
    await expect(check).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Marked done', { exact: true })).toBeVisible();
    await expect.poll(async () => (await household.collection('home-assets').doc('hvac-main').get()).get('schedules')?.[0])
      .toMatchObject({ lastCompletedDate: '2026-08-01', nextDueDate: '2026-11-01' });
    await expect.poll(async () => (await household.collection('maintenance').where('title', '==', 'Replace air filter').where('date', '==', '2026-08-01').get()).size)
      .toBe(1);
    await expect.poll(async () => Boolean((await household.collection('notifications').doc(HVAC_NOTIFICATION).get()).get('resolvedAt')))
      .toBe(true);
    await expect(list.getByRole('listitem').filter({ hasText: 'Replace air filter' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Reminders' })).toHaveAttribute('aria-selected', 'true');

    // Last: an unrelated edit of the snoozed asset keeps the snooze (the edit form rebuilds the
    // schedule). It navigates to Home Assets, so it runs after the in-place checks above.
    const dishwasherDoc = household.collection('home-assets').doc('dishwasher');
    const originalNotes = (await dishwasherDoc.get()).get('notes') ?? null;
    try {
      await page.goto('/maintenance?asset=dishwasher');
      await page.getByRole('tabpanel', { name: 'Home Assets' }).getByRole('button', { name: 'Edit home asset Kitchen Dishwasher' }).click();
      const editDialog = page.getByRole('dialog', { name: 'Edit Home Asset' });
      await editDialog.getByLabel('Notes').fill('E2E unrelated edit');
      await editDialog.getByRole('button', { name: 'Save Asset' }).click();
      await expect.poll(async () => (await dishwasherDoc.get()).get('notes')).toBe('E2E unrelated edit');
      expect((await dishwasherDoc.get()).get('schedules')?.[0]).toMatchObject({ nextDueDate: '2026-08-08', snoozedUntil: '2026-08-08' });
    } finally {
      await dishwasherDoc.update({ notes: originalNotes });
    }
  });

  test('MA-2: changes made elsewhere appear on the open page without a reload', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/maintenance?tab=logs');
    await expect(page.getByTestId('maintenance-log-oil-change')).toBeVisible();
    // Written with the Admin SDK, as another device (or quick add) would: the page has no reload or refetch.
    const logRef = household.collection('maintenance').doc('live-update-e2e');
    try {
      await logRef.set({
        householdId, targetType: 'home_asset', assetId: 'hvac-main', title: 'Live update E2E', item: 'Live update E2E',
        date: '2026-07-30', type: 'routine', createdAt: '2026-07-30T12:00:00.000Z', updatedAt: '2026-07-30T12:00:00.000Z',
      });
      const liveLog = page.getByTestId('maintenance-log-live-update-e2e');
      await expect(liveLog).toContainText('Live update E2E');
      await logRef.update({ title: 'Live update E2E edited' });
      await expect(liveLog).toContainText('Live update E2E edited');

      // A schedule changed elsewhere moves its reminder.
      await page.getByRole('tab', { name: 'Reminders' }).click();
      const overdueDishwasher = page.getByTestId('reminders-list').getByRole('listitem').filter({ hasText: 'Kitchen Dishwasher' })
        .filter({ has: page.getByText('Overdue', { exact: true }) });
      await expect(overdueDishwasher).toHaveCount(0);
      await household.collection('home-assets').doc('dishwasher').update({
        schedules: [{ ...DISHWASHER_SCHEDULES[0], nextDueDate: '2026-07-01' }],
      });
      await expect(overdueDishwasher).toHaveCount(1);

      await logRef.delete();
      await page.getByRole('tab', { name: 'Logs' }).click();
      await expect(page.getByTestId('maintenance-log-live-update-e2e')).toHaveCount(0);
      await expect(page.getByTestId('maintenance-log-oil-change')).toBeVisible();
    } finally {
      await logRef.delete();
    }
  });

  test('MA-1: the day rolls over at the household midnight on an open page', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    // One minute before midnight on Aug 1 in the household's zone (the seed household has none,
    // so the server default, America/Chicago: midnight is 05:00 UTC). The clock is installed, not
    // fixed, so the page's timer to the next household midnight runs.
    await page.clock.install({ time: new Date('2026-08-02T04:59:00.000Z') });
    await page.goto('/maintenance?tab=reminders');
    await expect(page.getByRole('heading', { name: 'Maintenance Center', exact: true })).toBeVisible();
    const filterIn = (testId: string) => page.getByTestId(testId).getByRole('listitem').filter({ hasText: 'Replace air filter' });
    // The HVAC filter is due Aug 1: due today.
    await expect(filterIn('reminders-group-due_today')).toHaveCount(1);
    await expect(filterIn('reminders-group-overdue')).toHaveCount(0);

    await page.clock.fastForward('02:00');
    // Aug 2 in the household: overdue, without a reload or any data change.
    await expect(filterIn('reminders-group-overdue')).toHaveCount(1);
    await expect(filterIn('reminders-group-due_today')).toHaveCount(0);
  });

  test('M1: Mark done offers Undo for 10 s, which puts the schedule back and removes the log', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/maintenance?tab=reminders');
    const filter = page.getByTestId('reminders-list').getByRole('listitem').filter({ hasText: 'Replace air filter' });
    await filter.getByRole('checkbox', { name: 'Mark done: Replace air filter for Main HVAC System' }).click();
    await expect(page.getByText('Marked done', { exact: true })).toBeVisible();
    const hvac = household.collection('home-assets').doc('hvac-main');
    await expect.poll(async () => (await hvac.get()).get('schedules')?.[0]?.nextDueDate).toBe('2026-11-01');
    const completion = (await household.collection('maintenance').where('title', '==', 'Replace air filter').where('date', '==', '2026-08-01').get()).docs;
    expect(completion).toHaveLength(1);
    // The server records who did it (never an email) and the completion it made.
    expect(completion[0].get('doneByUid')).toBeTruthy();
    expect(String(completion[0].get('doneByName'))).not.toContain('@');
    expect(completion[0].get('completion')).toMatchObject({ scheduleId: 'asset-filter-e2e', cycle: { nextDueDate: '2026-08-01', nextDueMileage: null } });

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByText('Undone', { exact: true })).toBeVisible();
    await expect.poll(async () => (await hvac.get()).get('schedules')?.[0]).toMatchObject({ nextDueDate: '2026-08-01', lastCompletedDate: '2026-05-01' });
    expect((await hvac.get()).get('schedules')?.[0]?.lastCompletion).toBeUndefined();
    await expect.poll(async () => (await household.collection('maintenance').where('title', '==', 'Replace air filter').where('date', '==', '2026-08-01').get()).size)
      .toBe(0);
    // The reminder is back, unchecked, with its actions.
    await expect(page.getByRole('checkbox', { name: 'Mark done: Replace air filter for Main HVAC System' })).toHaveAttribute('aria-checked', 'false');
  });

  test('M1: Mark done on a service due by mileage asks for the odometer first', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/maintenance?tab=reminders');
    const tires = page.getByTestId('reminders-list').getByRole('listitem').filter({ hasText: 'Tire rotation' });
    const check = tires.getByRole('checkbox', { name: 'Mark done: Tire rotation for Family SUV' });
    await check.click();
    const dialog = page.getByRole('dialog', { name: 'Confirm mileage' });
    await expect(dialog).toBeVisible();
    // Not drawn as done before the reading is confirmed. The open dialog hides the
    // page behind it from role queries, so the check is found by its label.
    // MA-13: the service is listed once.
    await expect(page.locator('[role="checkbox"][aria-label="Mark done: Tire rotation for Family SUV"][aria-checked="false"]')).toHaveCount(1);
    await expect(page.locator('[role="checkbox"][aria-label="Mark done: Tire rotation for Family SUV"][aria-checked="true"]')).toHaveCount(0);
    const odometer = dialog.getByLabel('Odometer (miles)');
    await expect(odometer).toHaveValue('48750');
    await expect(odometer).toHaveAttribute('inputmode', 'numeric');

    // A lower reading asks once before it can be saved.
    await odometer.fill('40000');
    await dialog.getByRole('button', { name: 'Mark done' }).click();
    await expect(dialog.getByRole('alert')).toContainText('lower than the recorded 48,750 mi');
    await expect(dialog.getByRole('button', { name: 'Save anyway' })).toBeVisible();
    // A jump of more than 20,000 miles asks too.
    await odometer.fill('80000');
    await dialog.getByRole('button', { name: 'Save anyway' }).click();
    await expect(dialog.getByRole('alert')).toContainText('more than 20,000 mi above');

    await odometer.fill('48900');
    await dialog.getByRole('button', { name: /^(Mark done|Save anyway)$/ }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Marked done', { exact: true })).toBeVisible();
    const suv = household.collection('vehicles').doc('family-suv');
    await expect.poll(async () => (await suv.get()).get('serviceSchedules')?.[0]).toMatchObject({
      lastCompletedMileage: 48900, nextDueMileage: 54900, lastCompletedDate: '2026-08-01',
    });
    expect((await suv.get()).get('currentMileage')).toBe(48900);
    expect((await suv.get()).get('mileageUpdatedAt')).toBe('2026-08-01');
  });

  test('D15: the detail panel hides empty fields and keeps one action row', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/maintenance?asset=dishwasher');
    const panel = page.getByRole('tabpanel', { name: 'Home Assets' });
    await expect(panel.getByText('Not recorded')).toHaveCount(0);
    await expect(panel.getByText('Bosch', { exact: true })).toBeVisible();
    await expect(panel.getByText('Serial Number', { exact: true })).toHaveCount(0);
    const edit = panel.getByRole('button', { name: 'Edit home asset Kitchen Dishwasher' });
    const remove = panel.getByRole('button', { name: 'Delete home asset Kitchen Dishwasher' });
    const details = panel.getByRole('button', { name: /^Add details/ });
    await expect(details).toBeVisible();
    const [editBox, removeBox, detailsBox] = await Promise.all([edit.boundingBox(), remove.boundingBox(), details.boundingBox()]);
    expect(Math.abs(editBox!.y - removeBox!.y)).toBeLessThan(2);
    expect(Math.abs(editBox!.y - detailsBox!.y)).toBeLessThan(2);
    // Delete sits apart from Edit.
    expect(removeBox!.x - (editBox!.x + editBox!.width)).toBeGreaterThan(48);
    await details.click();
    await expect(page.getByRole('dialog', { name: 'Edit Home Asset' })).toBeVisible();
  });

  test('H30: asset cards show the newest photo, with tokenized art otherwise', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await household.collection('maintenance-attachments').doc('maintenance-ux-photo').set({
      householdId,
      targetType: 'home_asset',
      targetId: 'hvac-main',
      category: 'photo',
      fileName: 'maintenance-ux-photo.png',
      filePath: `households/${householdId}/maintenance/home_asset/hvac-main/maintenance-ux-photo.png`,
      downloadUrl: '/icons/icon-192.png',
      contentType: 'image/png',
      size: 1024,
      uploadedByUid: 'e2e-owner-uid',
      createdAt: '2026-07-31T12:00:00.000Z',
    });
    await page.setViewportSize({ width: 1009, height: 900 });
    await open(page, '/maintenance?tab=assets');
    await expect(page.getByTestId('asset-card-hvac-main').locator('[data-asset-photo="image"]')).toBeVisible();
    await expect(page.getByTestId('asset-card-dishwasher').locator('[data-asset-photo="fallback"]')).toBeVisible();
    // B7 still holds with the photo band.
    const height = await page.getByTestId('asset-card-hvac-main').evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeLessThan(250);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  test('D16: Log service opens the log form for that schedule and completes it on save', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/maintenance?tab=reminders');
    const filter = page.getByTestId('reminders-list').getByRole('listitem').filter({ hasText: 'Replace air filter' });
    await filter.getByRole('button', { name: 'Log service: Replace air filter for Main HVAC System' }).click();

    const dialog = page.getByRole('dialog', { name: 'Add Maintenance Log' });
    await expect(dialog).toContainText('Saving marks Replace air filter done for Main HVAC System');
    await expect(dialog.getByLabel('Title')).toHaveValue('Replace air filter');
    await expect(dialog.getByLabel('Date')).toHaveValue('2026-08-01');
    await dialog.getByLabel('Cost').fill('42.5');
    await dialog.getByLabel('Service Provider').fill('E2E Heating');
    await dialog.getByRole('button', { name: 'Save Log' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Service logged', { exact: true })).toBeVisible();

    await expect.poll(async () => (await household.collection('home-assets').doc('hvac-main').get()).get('schedules')?.[0])
      .toMatchObject({ lastCompletedDate: '2026-08-01', nextDueDate: '2026-11-01' });
    await expect.poll(async () => {
      const logs = await household.collection('maintenance').where('title', '==', 'Replace air filter').where('date', '==', '2026-08-01').get();
      return logs.docs.map((log) => ({ assetId: log.get('assetId'), cost: log.get('cost'), serviceProvider: log.get('serviceProvider'), type: log.get('type') }));
    }).toEqual([{ assetId: 'hvac-main', cost: 42.5, serviceProvider: 'E2E Heating', type: 'routine' }]);
    await expect.poll(async () => Boolean((await household.collection('notifications').doc(HVAC_NOTIFICATION).get()).get('resolvedAt')))
      .toBe(true);
    await expect(page.getByTestId('reminders-list').getByRole('listitem').filter({ hasText: 'Replace air filter' })).toHaveCount(0);
  });

  test('H30: vehicle cards show their photo; brand logos and badges theme with the text', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await household.collection('maintenance-attachments').doc('maintenance-ux-vehicle-photo').set({
      householdId,
      targetType: 'vehicle',
      targetId: 'family-suv',
      category: 'photo',
      fileName: 'maintenance-ux-photo.png',
      filePath: `households/${householdId}/maintenance/vehicle/family-suv/maintenance-ux-photo.png`,
      downloadUrl: '/icons/icon-192.png',
      contentType: 'image/png',
      size: 1024,
      uploadedByUid: 'e2e-owner-uid',
      createdAt: '2026-07-31T12:00:00.000Z',
    });
    await open(page, '/maintenance?tab=vehicles');
    const suv = page.getByTestId('vehicle-card-family-suv');
    await expect(suv.locator('[data-vehicle-photo="image"]')).toBeVisible();
    // The make is shown as text, so the Subaru mark is decorative.
    await expect(suv.locator('[data-brand]')).toHaveCount(1);
    await expect(suv.locator('[data-brand="subaru"][data-brand-kind="logo"]')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.getByTestId('vehicle-detail').locator('[data-brand="subaru"] path')).toHaveCount(1);

    await page.getByRole('tab', { name: 'Home Assets' }).click();
    // Each card shows its brand mark once (beside the title), whether or not it has a photo.
    await expect(page.getByTestId('asset-card-dishwasher').locator('[data-brand]')).toHaveCount(1);
    // Bosch has bundled artwork; Carrier gets the monogram badge. Neither card shows the brand as text, so both are named.
    await expect(page.getByTestId('asset-card-dishwasher').getByRole('img', { name: 'Bosch' })).toHaveAttribute('data-brand-kind', 'logo');
    await expect(page.getByTestId('asset-card-hvac-main').getByRole('img', { name: 'Carrier' })).toHaveAttribute('data-brand-kind', 'badge');
    const colors = await page.getByTestId('asset-card-dishwasher').locator('[data-brand="bosch"] svg').evaluate((svg) => ({
      fill: getComputedStyle(svg).fill,
      color: getComputedStyle(svg).color,
    }));
    expect(colors.fill).toBe(colors.color);
  });

  test('H12: an asset card morphs into the detail panel; a modified click selects plainly', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/maintenance?tab=assets');
    // Record the shared-element names present when each view transition starts.
    await page.evaluate(() => {
      const w = window as unknown as { __morphs: string[] };
      w.__morphs = [];
      const start = document.startViewTransition?.bind(document);
      if (!start) return;
      document.startViewTransition = ((update: () => void) => {
        w.__morphs.push([...document.querySelectorAll<HTMLElement>('*')].map((el) => el.style.viewTransitionName).filter(Boolean).join(','));
        return start(update);
      }) as typeof document.startViewTransition;
    });
    const morphs = () => page.evaluate(() => (window as unknown as { __morphs: string[] }).__morphs);
    const current = await page.getByTestId('asset-detail').evaluate((el) => (el.textContent?.includes('Main HVAC System') ? 'hvac-main' : 'dishwasher'));
    const other = current === 'hvac-main' ? 'dishwasher' : 'hvac-main';
    await page.getByTestId(`asset-card-${other}`).click();
    await expect(page.getByTestId(`asset-card-${other}`)).toHaveAttribute('aria-current', 'true');
    expect(await morphs()).toEqual([`asset-${other}-card`]);
    // After the morph no element keeps the name.
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('*')].filter((el) => el.style.viewTransitionName).length)).toBe(0);

    await page.getByTestId(`asset-card-${current}`).click({ modifiers: ['Shift'] });
    await expect(page.getByTestId(`asset-card-${current}`)).toHaveAttribute('aria-current', 'true');
    expect(await morphs()).toHaveLength(1);
  });

  test('summaries are offered only for notes worth summarizing; validation stays inline', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/maintenance?tab=logs');
    await expect(page.getByTestId('maintenance-log-hvac-inspection').getByRole('button', { name: 'Summarize with AI' })).toBeVisible();
    await expect(page.getByTestId('maintenance-log-oil-change').getByRole('button', { name: 'Summarize with AI' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Add Maintenance Log' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add Maintenance Log' });
    await dialog.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'Home Asset' }).click();
    await dialog.getByLabel('Title').fill('Inline validation E2E');
    await dialog.getByRole('button', { name: 'Save Log' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Choose a home asset or switch the log to general.');
    await expect(page.getByRole('region', { name: /Notifications/ }).getByText('Choose a home asset')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('a guest can view but not change maintenance', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:9002', colorScheme: 'dark' });
    const page = await context.newPage();
    await page.clock.setFixedTime(fixedNow);
    await page.goto('/e2e-login?uid=e2e-limited-uid');
    await expect(page).toHaveURL('/');
    await open(page, '/maintenance?tab=reminders');
    await expect(page.getByRole('button', { name: /^Open: Replace air filter/ }).first()).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /^Mark done/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Log service/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Snooze/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add Log', exact: true })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Home Assets' }).click();
    await expect(page.getByRole('button', { name: /^Edit home asset/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Delete home asset/ })).toHaveCount(0);
    await context.close();
  });
});

test.describe('maintenance peeks', () => {
  test.beforeEach(async () => { await restoreMaintenanceSeed(); });
  test.afterEach(async () => { await restoreMaintenanceSeed(); });

  test('H26: a flagged item in Needs doing and a reminder Open link show peek cards on hover', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/maintenance');
    const peek = page.locator('[data-peek-card]');
    // The seeded HVAC is flagged as needing attention.
    const queue = page.getByTestId('needs-doing-flagged');
    await queue.getByRole('button', { name: /Main HVAC System/ }).hover();
    await expect(peek).toBeVisible();
    await expect(peek).toContainText('Main HVAC System');
    await expect(peek).toContainText('Carrier Comfort 16');
    await expect(peek).toContainText('Utility Closet');
    await page.mouse.move(0, 0);
    await expect(peek).toHaveCount(0);

    await page.getByRole('tab', { name: 'Reminders' }).click();
    const openReminder = page.getByRole('button', { name: 'Open: Replace air filter for Main HVAC System' }).first();
    await openReminder.hover();
    await expect(peek).toBeVisible();
    await expect(peek).toContainText('Main HVAC System');
    await expect(peek).toContainText('Replace air filter');
    await expect(peek).toContainText('Opens the home asset');
  });
});

test.describe('maintenance center M4: overview, reminders, filters, layout and insights', () => {
  test.beforeEach(async () => { await restoreMaintenanceSeed(); });
  test.afterEach(async () => { await restoreMaintenanceSeed(); });

  test('MA-12/MA-14: Needs doing comes first on Overview, with its actions in place and the flags labelled', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/maintenance');
    const needs = page.getByTestId('needs-doing');
    await expect(needs).toBeVisible();
    // Due today before due soon; the separate "Needs Attention: 0" count card is gone.
    const items = needs.getByRole('listitem');
    await expect(items.first()).toContainText('Replace air filter');
    await expect(items.first().getByText('Due today', { exact: true })).toBeVisible();
    await expect(page.getByText('Needs Attention', { exact: true })).toHaveCount(0);
    await expect(needs.getByTestId('reminder-actions-hint')).toContainText('Snooze moves a due date 7 days later.');
    // The manual flag is in the same list, labelled as a flag.
    const flagged = needs.getByTestId('needs-doing-flagged');
    await expect(flagged.getByRole('button', { name: /Main HVAC System/ })).toContainText('Flagged');
    // Health and the next 30 days sit beside it.
    await expect(page.getByTestId('maintenance-health')).toBeVisible();
    await expect(page.getByTestId('overview-coming-up')).toContainText('The next 30 days');

    // Snooze in place, muted with "Snoozed until", then Undo.
    const dishwasher = needs.getByRole('listitem').filter({ hasText: 'Kitchen Dishwasher' });
    await dishwasher.getByRole('button', { name: 'Snooze 1 week: Clean filter for Kitchen Dishwasher' }).click();
    await expect(page.getByText('Snoozed for a week', { exact: true })).toBeVisible();
    await expect(dishwasher).toHaveAttribute('data-snoozed', 'true');
    await expect(dishwasher).toContainText('Snoozed until Aug 15, 2026');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByText('Snooze undone', { exact: true })).toBeVisible();
    await expect.poll(async () => (await household.collection('home-assets').doc('dishwasher').get()).get('schedules')?.[0]?.nextDueDate).toBe('2026-08-08');

    // Done in place from Overview, with Undo.
    await needs.getByRole('checkbox', { name: 'Mark done: Replace air filter for Main HVAC System' }).click();
    await expect(page.getByText('Marked done', { exact: true })).toBeVisible();
    await expect.poll(async () => (await household.collection('home-assets').doc('hvac-main').get()).get('schedules')?.[0]?.nextDueDate).toBe('2026-11-01');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByText('Undone', { exact: true })).toBeVisible();
    await expect.poll(async () => (await household.collection('home-assets').doc('hvac-main').get()).get('schedules')?.[0]?.nextDueDate).toBe('2026-08-01');
    await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  test('MA-26: ?location= narrows Needs doing to one room with a Room chip', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/maintenance?location=Kitchen');
    const needs = page.getByTestId('needs-doing');
    await expect(needs.getByRole('group', { name: 'Room' }).getByRole('button', { name: 'Kitchen, 1' })).toHaveAttribute('aria-pressed', 'true');
    await expect(needs.getByRole('listitem').filter({ hasText: 'Kitchen Dishwasher' })).toHaveCount(1);
    await expect(needs).not.toContainText('Replace air filter');
    await expect(needs).not.toContainText('Family SUV');
    await needs.getByRole('button', { name: 'All rooms' }).click();
    await expect(page).toHaveURL(/\/maintenance$/);
    await expect(needs).toContainText('Replace air filter');
  });

  test('MA-13: Reminders is one urgency-grouped list with kind chips; each reminder appears once', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/maintenance?tab=reminders');
    const list = page.getByTestId('reminders-list');
    await expect(list.getByRole('listitem').filter({ hasText: 'Replace air filter' })).toHaveCount(1);
    await expect(list.getByRole('listitem').filter({ hasText: 'Tire rotation' })).toHaveCount(1);
    await expect(page.getByTestId('reminders-group-due_today')).toContainText('Replace air filter');
    await expect(page.getByTestId('reminders-group-due_soon')).toContainText('Clean filter');
    await expect(page.getByText(/Within 14 days/)).toHaveCount(0);
    // Kind chips with counts from the same pass.
    const kinds = list.getByRole('group', { name: 'Kind of reminder' });
    await kinds.getByRole('button', { name: /^Warranties, 1$/ }).click();
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list.getByRole('listitem')).toContainText('Main HVAC System');
    await kinds.getByRole('button', { name: /^All/ }).click();
    await expect(list.getByRole('listitem').filter({ hasText: 'Replace air filter' })).toHaveCount(1);
    // Coming up, 90 days, beside the list.
    await expect(page.getByTestId('reminders-coming-up')).toContainText('The next 90 days');
  });

  test('MA-29: a vehicle service due by mileage shows an estimate, labelled as one', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const readings = [['m4-reading-1', '2026-05-01', 45000], ['m4-reading-2', '2026-06-15', 46500]] as const;
    try {
      await Promise.all(readings.map(([id, date, mileage]) => household.collection('maintenance').doc(id).set({
        householdId, targetType: 'vehicle', vehicleId: 'family-suv', title: 'Odometer E2E', date, type: 'other', mileage,
        createdAt: `${date}T12:00:00.000Z`, updatedAt: `${date}T12:00:00.000Z`,
      })));
      await open(page, '/maintenance?tab=reminders');
      const tires = page.getByTestId('reminders-list').getByRole('listitem').filter({ hasText: 'Tire rotation' });
      await expect(tires.getByTestId('mileage-estimate')).toContainText(/Estimated around [A-Z][a-z]{2} \d{1,2}, based on 3 readings/);
      await expect(tires.getByTestId('mileage-estimate')).toContainText('An estimate');
    } finally {
      await Promise.all(readings.map(([id]) => household.collection('maintenance').doc(id).delete()));
    }
  });

  test('MA-21: filters and search live in the URL and stay across tabs; logs open their files on demand', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/maintenance?tab=assets&q=dish');
    await expect(page.getByRole('searchbox', { name: 'Search maintenance' })).toHaveValue('dish');
    await expect(page.getByTestId('asset-card-dishwasher')).toBeVisible();
    await expect(page.getByTestId('asset-card-hvac-main')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Logs' }).click();
    await expect(page).toHaveURL(/\?tab=logs&q=dish$/);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).toHaveURL(/\?tab=logs$/);

    // Category chip, then typing in the search box (written after a short pause).
    await page.getByRole('tab', { name: 'Home Assets' }).click();
    await page.getByRole('group', { name: 'Category' }).getByRole('button', { name: 'HVAC, 1' }).click();
    await expect(page).toHaveURL(/\?tab=assets&category=HVAC$/);
    await expect(page.getByTestId('asset-card-dishwasher')).toHaveCount(0);
    await page.getByRole('searchbox', { name: 'Search maintenance' }).fill('carrier');
    await expect(page).toHaveURL(/\?tab=assets&category=HVAC&q=carrier$/);
    await expect(page.getByTestId('asset-card-hvac-main')).toBeVisible();

    // Logs: files are not loaded per row; opening a log shows them.
    await page.goto('/maintenance?tab=logs');
    const log = page.getByTestId('maintenance-log-hvac-inspection');
    await expect(log.getByText('sample-hvac-report.txt')).toHaveCount(0);
    await log.getByRole('button', { name: 'Files for Summer HVAC inspection (1)' }).click();
    await expect(log.getByText('sample-hvac-report.txt')).toBeVisible();
  });

  test('MA-11e/MA-20: an undated log is kept, last, as "Undated"; a server log says who did it', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const undated = household.collection('maintenance').doc('m4-undated-e2e');
    const doneBy = household.collection('maintenance').doc('m4-done-by-e2e');
    try {
      await undated.set({ householdId, targetType: 'general', title: 'Undated legacy E2E', type: 'other', receiptUrl: 'https://example.test/receipt.pdf' });
      await doneBy.set({ householdId, targetType: 'general', title: 'Done by E2E', date: '2026-07-31', type: 'routine', doneByUid: 'e2e-owner-uid', doneByName: 'Sam E2E' });
      await open(page, '/maintenance?tab=logs');
      const legacy = page.getByTestId('maintenance-log-m4-undated-e2e');
      await expect(legacy).toContainText('Undated');
      await expect(legacy.getByRole('link', { name: 'Receipt (older upload)' })).toHaveAttribute('href', 'https://example.test/receipt.pdf');
      const ids = await page.locator('[data-testid^="maintenance-log-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')));
      expect(ids.at(-1)).toBe('maintenance-log-m4-undated-e2e');
      await expect(page.getByTestId('maintenance-log-m4-done-by-e2e').getByTestId('log-done-by')).toContainText('Done by Sam E2E');
      await expect(page.getByTestId('maintenance-log-oil-change').getByTestId('log-done-by')).toHaveCount(0);
    } finally {
      await Promise.all([undated.delete(), doneBy.delete()]);
    }
  });

  test('MA-28/MA-31/MA-32/MA-33c: the asset detail shows costs, the history line, the claim checklist and Print label', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/maintenance?asset=hvac-main');
    const detail = page.getByTestId('asset-detail');
    await expect(detail.getByTestId('detail-history')).toHaveText('Summer HVAC inspection last done 6 weeks ago');
    await expect(detail.getByTestId('asset-costs')).toContainText('Lifetime cost');
    await expect(detail.getByTestId('asset-costs')).toContainText('$129');
    await expect(detail.getByTestId('warranty-claim-checklist')).toContainText('Warranty claim checklist');
    await detail.getByRole('button', { name: 'Print label' }).click();
    await expect(detail.getByRole('img', { name: 'QR code that opens Main HVAC System in HomeHub' })).toBeVisible();
    // The detail column stays in view beside the cards (sticky).
    expect(await detail.evaluate((el) => getComputedStyle(el.parentElement!).position)).toBe('sticky');
  });

  test('MA-33a: Renewed (+1 year) moves the registration a year on, with Undo', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/maintenance?vehicle=family-suv');
    const documents = page.getByTestId('vehicle-documents');
    await expect(documents).toContainText('Expires Aug 12, 2026');
    await documents.getByRole('button', { name: 'Renewed (+1 year): registration for Family SUV' }).click();
    await expect(page.getByText('Registration renewed', { exact: true })).toBeVisible();
    const suv = household.collection('vehicles').doc('family-suv');
    await expect.poll(async () => (await suv.get()).get('registrationExpiration')).toBe('2027-08-12');
    await expect(documents).toContainText('Expires Aug 12, 2027');
    expect((await suv.get()).get('inspectionExpiration')).toBe('2026-08-05');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByText('Renewal undone', { exact: true })).toBeVisible();
    await expect.poll(async () => (await suv.get()).get('registrationExpiration')).toBe('2026-08-12');
    await expect(page.getByTestId('vehicle-costs')).toContainText('Cost per mile');
  });

  test('MA-17: on a phone a card opens its detail in a full-height sheet that Back closes; the tab row is one row', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium');
    await open(page, '/maintenance?tab=assets');
    const tabs = page.locator('[data-maintenance-tabs]');
    const tabBoxes = await tabs.getByRole('tab').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top));
    expect(new Set(tabBoxes.map((top) => Math.round(top))).size).toBe(1);
    // No detail column on a phone until a card is chosen.
    await expect(page.getByTestId('asset-detail')).toHaveCount(0);
    await page.getByTestId('asset-card-dishwasher').click();
    const sheet = page.getByTestId('asset-detail-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('asset-detail')).toContainText('Kitchen Dishwasher');
    const box = await sheet.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual((page.viewportSize()!.height) - 1);
    await page.goBack();
    await expect(sheet).toHaveCount(0);
    await expect(page).toHaveURL(/\/maintenance\?tab=assets$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
});
