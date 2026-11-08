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
 * test) leave a completion log behind, and the health score counts recent logs. It also removes
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
    household.collection('vehicles').doc('family-suv').update({ serviceSchedules: SUV_SCHEDULES, currentMileage: 48750 }),
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
    // Seed: HVAC flagged (−10), filter due today (−5), warranty ending (−2); dishwasher filter due soon (−2);
    // SUV tire rotation, registration and inspection due soon (−2 each); two logs in 90 days (+4) = 79.
    const dial = panel.getByRole('img', { name: 'Home health 79 out of 100, needs some care.' });
    await expect(dial).toBeVisible();
    await expect(dial).toContainText('79');
    await expect(panel.getByText('Needs some care', { exact: true })).toBeVisible();
    const reasons = panel.getByRole('list', { name: 'Score deductions' }).getByRole('listitem');
    await expect(reasons).toHaveText([
      /^−10Main HVAC System: flagged as needing attention/,
      /^−5Main HVAC System: Replace air filter is due today/,
      /^−2Family SUV: Inspection expires in 4 days/,
      /^−2Family SUV: Registration expires in 11 days/,
      /^−2Family SUV: Tire rotation is due in 2 weeks/,
    ]);
    await panel.getByRole('button', { name: 'Show 2 more' }).click();
    await expect(reasons).toHaveCount(7);
    await expect(reasons.filter({ hasText: 'Kitchen Dishwasher: Clean filter is due in 7 days' })).toHaveCount(1);
    await expect(reasons.filter({ hasText: 'Main HVAC System: warranty ends in 9 days' })).toHaveCount(1);
    await expect(panel.getByText('2 logs in the last 90 days')).toBeVisible();
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

    const overdue = page.getByTestId('reminders-overdue');
    const dishwasher = overdue.getByRole('listitem').filter({ hasText: 'Kitchen Dishwasher' });
    await expect(dishwasher.getByText('Overdue', { exact: true })).toHaveCount(1);
    await expect(dishwasher).toContainText('Due Jul 1, 2026 · 4 weeks ago');
    await expect(dishwasher).not.toContainText('is overdue');

    // Warranties expire; they are never "overdue" or "due".
    const warranty = page.getByTestId('reminders-warranty').getByRole('listitem').filter({ hasText: 'Main HVAC System' });
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

    const filter = page.getByRole('listitem').filter({ hasText: 'Replace air filter' }).first();
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
    await expect(page.getByRole('listitem').filter({ hasText: 'Replace air filter' })).toHaveCount(0);
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
    const filter = page.getByRole('listitem').filter({ hasText: 'Replace air filter' }).first();
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
    await expect(page.getByRole('listitem').filter({ hasText: 'Replace air filter' })).toHaveCount(0);
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
