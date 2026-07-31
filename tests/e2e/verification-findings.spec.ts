import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getManagedBarcodeImagePath } from '../../src/lib/barcode-storage';
import { getDeterministicNotificationId } from '../../src/lib/notifications';
import { resolveShoppingCategory } from '../../src/lib/shopping-categorization';
import { fixedNow } from './test-helpers';

const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const ownerUid = 'e2e-owner-uid';
const adminApp = getApps().find((app) => app.name === 'verification-findings')
  || initializeApp({ projectId, storageBucket: `${projectId}.appspot.com` }, 'verification-findings');
const adminDb = getFirestore(adminApp);

const household = adminDb.collection('households').doc(householdId);
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');

async function restoreMutableSeedData() {
  await Promise.all([
    household.collection('chores').doc('chore-laundry').set({
      task: 'Fold clean laundry', assignedToEmail: 'sam.member@example.test', assignedToDisplayName: 'Sam Member',
      dueDate: '2026-08-01', isCompleted: false, templateId: 'one-time-laundry', originalDueDate: '2026-08-01', roomIds: ['living-room'],
    }),
    household.collection('chores').doc('chore-completed').set({
      task: 'Take bins to curb', assignedToEmail: 'morgan.admin@example.test', assignedToDisplayName: 'Morgan Admin',
      dueDate: '2026-07-31', isCompleted: true, completedAt: '2026-07-31T20:10:00.000Z', templateId: 'one-time-bins', originalDueDate: '2026-07-31', roomIds: ['garage'],
    }),
    household.collection('pets').doc('maple').collection('feeding-logs').doc('morning-feed').set({
      date: new Date('2026-08-01T12:00:00.000Z'), cups: 1.5, foodType: 'Dry', foodAmountType: 'Cups', comments: 'Ate normally', ampm: 'AM',
    }),
    household.collection('pets').doc('maple').collection('care-logs').doc('walk').set({
      date: '2026-07-31T23:30:00.000Z', activity: 'Evening walk', notes: 'Thirty minutes around the neighborhood.',
    }),
    household.collection('pets').doc('pixel').collection('medication-logs').doc('flea-prevention').set({
      date: '2026-07-28T15:00:00.000Z', medication: 'Monthly flea prevention', dosage: 'One topical dose', notes: 'Next dose due in four weeks.',
    }),
    household.collection('barcode-library').doc('012345678905').set({
      name: 'E2E Oat Cereal', imageUrl: '/favicon.ico', createdAt: '2026-07-25T15:00:00.000Z',
    }),
    household.collection('home-assets').doc('hvac-main').update({
      schedules: [{
        id: 'asset-filter-e2e', mode: 'scheduled', scheduleName: 'Replace air filter', frequencyType: 'months',
        intervalValue: 3, lastCompletedDate: '2026-05-01', nextDueDate: '2026-08-01',
      }],
    }),
    household.collection('vehicles').doc('family-suv').update({
      serviceSchedules: [
        {
          id: 'tire-rotation-e2e', mode: 'scheduled', serviceName: 'Tire rotation', intervalMiles: 6000,
          lastCompletedMileage: 43000, lastCompletedDate: '2026-04-15', nextDueMileage: 49000, nextDueDate: '2026-08-15',
        },
        {
          id: 'brake-fluid-e2e', mode: 'scheduled', serviceName: 'Brake fluid inspection', intervalMonths: 24,
          lastCompletedDate: '2024-08-20', nextDueDate: '2026-08-20',
        },
      ],
    }),
    household.collection('notifications').doc(getDeterministicNotificationId({
      sourceType: 'maintenance_asset_schedule', sourceId: 'hvac-main:asset-filter-e2e', stateKey: 'due_today|2026-08-01',
    })).set({
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
  ]);

  for (const barcode of ['100000000001', '100000000002', '100000000003', '100000000004', '100000000005']) {
    await household.collection('barcode-library').doc(barcode).delete();
  }
  for (const name of ['Manual category item', 'Fallback category item']) {
    const snapshot = await household.collection('shopping-lists').doc('weekly-groceries').collection('items').where('name', '==', name).get();
    await Promise.all(snapshot.docs.map((item) => item.ref.delete()));
  }
}

async function openAuthenticated(page: Page, path: string, heading: string) {
  await page.clock.setFixedTime(fixedNow);
  await page.goto(path);
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  await expect(page.getByText('Sign in with Google')).toHaveCount(0);
}

test.describe('verification finding regressions', () => {
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.project.name === 'desktop-chromium') await restoreMutableSeedData();
  });
  test('shopping categorization and barcode path helpers fail safely', async ({}, testInfo) => {
    desktopOnly(testInfo);

    await expect(resolveShoppingCategory({
      itemName: 'Milk',
      categories: ['Dairy', 'Other'],
      categorize: async () => ({ category: 'Dairy' }),
    })).resolves.toEqual({ category: 'Dairy', usedFallback: false });
    await expect(resolveShoppingCategory({
      itemName: 'Milk',
      categories: ['Dairy', 'Other'],
      selectedCategory: 'Dairy',
      categorize: async () => { throw new Error('must not run'); },
    })).resolves.toEqual({ category: 'Dairy', usedFallback: false });
    await expect(resolveShoppingCategory({
      itemName: 'Mystery item',
      categories: ['Dairy', 'Other'],
      categorize: async () => { throw new Error('AI unavailable'); },
    })).resolves.toEqual({ category: 'Other', usedFallback: true, reason: 'error' });
    await expect(resolveShoppingCategory({
      itemName: 'Slow item',
      categories: ['Other'],
      timeoutMs: 5,
      categorize: () => new Promise(() => undefined),
    })).resolves.toEqual({ category: 'Other', usedFallback: true, reason: 'timeout' });

    const managedPath = `${household.path}/barcode-library/managed.png`;
    expect(getManagedBarcodeImagePath({ householdId, imagePath: managedPath })).toBe(managedPath);
    expect(getManagedBarcodeImagePath({ householdId, imageUrl: 'https://images.example.test/product.png' })).toBeNull();
    expect(getManagedBarcodeImagePath({ householdId })).toBeNull();
  });

  test('notification identities are deterministic for source state', async ({}, testInfo) => {
    desktopOnly(testInfo);
    const input = {
      sourceType: 'maintenance_vehicle_service',
      sourceId: 'family-suv:tire-rotation-e2e',
      stateKey: 'due_soon|2026-08-15|49000',
    };
    expect(getDeterministicNotificationId(input)).toBe(getDeterministicNotificationId(input));
    expect(getDeterministicNotificationId(input)).not.toBe(getDeterministicNotificationId({
      ...input,
      stateKey: 'overdue|2026-08-15|49000',
    }));
  });

  test('dashboard contains no horizontal overflow at 360, 390, and 412 pixels', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    for (const width of [360, 390, 412]) {
      await page.setViewportSize({ width, height: 915 });
      await openAuthenticated(page, '/', 'Welcome Home');
      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(dimensions.scrollWidth, `document overflow at ${width}px`).toBeLessThanOrEqual(dimensions.clientWidth);
    }
  });

  test('maintenance deep links select records and invalid IDs degrade safely', async ({ page }) => {
    const cases = [
      ['/maintenance?asset=hvac-main', 'Home Assets', 'Main HVAC System'],
      ['/maintenance?asset=hvac-main&schedule=hvac-main%3Aasset-filter-e2e', 'Home Assets', 'Replace air filter'],
      ['/maintenance?vehicle=family-suv', 'Vehicles', 'Family SUV'],
      ['/maintenance?vehicle=family-suv&schedule=family-suv%3Atire-rotation-e2e', 'Vehicles', 'Tire rotation'],
      ['/maintenance?log=oil-change', 'Logs', 'Engine oil and filter'],
    ] as const;

    for (const [path, tab, content] of cases) {
      await openAuthenticated(page, path, 'Maintenance Center');
      await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByText(content, { exact: true }).first()).toBeVisible();
    }

    await openAuthenticated(page, '/maintenance?asset=deleted-asset', 'Maintenance Center');
    await expect(page.getByRole('tab', { name: 'Home Assets' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('status')).toContainText('no longer available');
  });

  test('maintenance synchronization is idempotent and preserves dismissal', async ({ page, context }, testInfo) => {
    desktopOnly(testInfo);
    const browserErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text());
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));
    await openAuthenticated(page, '/maintenance', 'Maintenance Center');

    const notificationCollection = household.collection('notifications');
    await expect.poll(async () => (await notificationCollection.get()).size).toBeGreaterThan(1);
    const stableCount = (await notificationCollection.get()).size;

    for (let visit = 1; visit < 10; visit += 1) {
      await page.goto('/notifications');
      await page.goto('/maintenance');
      await expect(page.getByRole('heading', { name: 'Maintenance Center' })).toBeVisible();
    }
    await expect.poll(async () => (await notificationCollection.get()).size).toBe(stableCount);

    await page.goto('/notifications');
    const title = page.getByText('HVAC filter due today', { exact: true }).first();
    await title.hover();
    await page.getByRole('button', { name: 'Dismiss HVAC filter due today' }).click();

    const getDismissedHvacNotification = async () => {
      const snapshot = await notificationCollection.where('title', '==', 'HVAC filter due today').get();
      return snapshot.docs.find((notification) => notification.data().dismissedBy?.[ownerUid]);
    };
    await expect.poll(async () => Boolean(await getDismissedHvacNotification()), {
      message: `notification was not dismissed; browser errors: ${browserErrors.join(' | ')}`,
    }).toBe(true);

    const secondPage = await context.newPage();
    await secondPage.clock.setFixedTime(fixedNow);
    await Promise.all([page.goto('/maintenance'), secondPage.goto('/maintenance')]);
    await expect.poll(async () => (await notificationCollection.get()).size).toBe(stableCount);
    expect(await getDismissedHvacNotification()).toBeTruthy();
    await secondPage.close();

    await page.goto('/maintenance?asset=hvac-main&schedule=hvac-main%3Aasset-filter-e2e');
    await page.getByTestId('asset-schedule-asset-filter-e2e').getByRole('button', { name: 'Complete' }).click();
    const completionDialog = page.getByRole('dialog', { name: 'Complete Scheduled Maintenance' });
    await completionDialog.getByLabel('Completed Date').fill('2026-08-01');
    await completionDialog.getByRole('button', { name: 'Complete Maintenance' }).click();
    await expect.poll(async () => {
      const schedules = (await household.collection('home-assets').doc('hvac-main').get()).data()?.schedules;
      return schedules?.[0]?.nextDueDate;
    }).toBe('2026-11-01');
    await expect.poll(async () => {
      const snapshot = await notificationCollection.where('sourceId', '==', 'hvac-main:asset-filter-e2e').get();
      return snapshot.docs.some((notification) => Boolean(notification.data().resolvedAt));
    }).toBe(true);
  });

  test('one-time chores hide recurring controls and each recurrence mode shows relevant fields', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openAuthenticated(page, '/chores', 'Chore Chart');
    await page.getByRole('button', { name: 'Chore Manager' }).click();
    await page.getByRole('menuitem', { name: 'Chores' }).click();
    const choresDialog = page.getByRole('dialog', { name: 'Chores' });
    const templateRow = choresDialog.getByRole('row').filter({ hasText: 'Reset the kitchen' });
    await templateRow.getByRole('checkbox').click();
    await choresDialog.getByRole('button', { name: 'Assign (1)' }).click();

    const assignDialog = page.getByRole('dialog', { name: /Assign 1 Chore/ });
    await expect(assignDialog.getByText('One-time Due Date')).toBeVisible();
    await expect(assignDialog.getByText('Recurring Schedule', { exact: true })).toHaveCount(0);
    await assignDialog.getByLabel('Recurring Task').click();
    await expect(assignDialog.getByText('Recurring Schedule', { exact: true })).toBeVisible();
    await expect(assignDialog.getByText('One-time Due Date')).toHaveCount(0);

    await assignDialog.getByRole('radio', { name: 'Daily', exact: true }).click();
    await expect(assignDialog.getByLabel('Weekdays Only')).toBeVisible();
    await assignDialog.getByRole('radio', { name: 'Weekly', exact: true }).click();
    await expect(assignDialog.getByText('Repeat weekly on')).toBeVisible();
    await assignDialog.getByRole('radio', { name: 'Biweekly', exact: true }).click();
    await expect(assignDialog.getByText('Anchor Week Start')).toBeVisible();
    await assignDialog.getByRole('radio', { name: 'Monthly', exact: true }).click();
    await expect(assignDialog.getByLabel('Day of month')).toBeVisible();
    await assignDialog.getByLabel('Nth weekday').click();
    await expect(assignDialog.getByText('Weekday', { exact: true })).toBeVisible();
    await assignDialog.getByLabel('One-time Task').click();
    await expect(assignDialog.getByText('Recurring Schedule', { exact: true })).toHaveCount(0);
  });

  test('active and completed chore deletion requires confirmation', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openAuthenticated(page, '/chores', 'Chore Chart');

    await page.getByRole('button', { name: 'Delete Fold clean laundry' }).click();
    const activeDialog = page.getByRole('alertdialog', { name: 'Delete Fold clean laundry?' });
    await expect(activeDialog).toContainText('active chore');
    await activeDialog.getByRole('button', { name: 'Cancel' }).click();
    expect((await household.collection('chores').doc('chore-laundry').get()).exists).toBe(true);

    await page.getByRole('button', { name: 'Delete Fold clean laundry' }).click();
    await page.getByRole('alertdialog', { name: 'Delete Fold clean laundry?' }).getByRole('button', { name: 'Delete Chore' }).click();
    await expect.poll(async () => (await household.collection('chores').doc('chore-laundry').get()).exists).toBe(false);

    await page.getByRole('button', { name: /^Completed \(/ }).click();
    await page.getByRole('button', { name: /Garage/ }).click();
    await page.getByRole('button', { name: 'Delete Take bins to curb' }).click();
    const completedDialog = page.getByRole('alertdialog', { name: 'Delete Take bins to curb?' });
    await expect(completedDialog).toContainText('completed chore');
    await completedDialog.getByRole('button', { name: 'Delete Chore' }).click();
    await expect.poll(async () => (await household.collection('chores').doc('chore-completed').get()).exists).toBe(false);
  });

  test('pet log deletion uses cancel and confirm dialogs for every log type', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const checks = [
      { path: '/pets/maple', tab: 'Feeding', button: /Delete feeding log/, collection: 'feeding-logs', id: 'morning-feed' },
      { path: '/pets/maple', tab: 'Care', button: /Delete Evening walk care log/, collection: 'care-logs', id: 'walk' },
      { path: '/pets/pixel', tab: 'Medication', button: /Delete Monthly flea prevention medication log/, collection: 'medication-logs', id: 'flea-prevention' },
    ];

    for (const check of checks) {
      await page.goto(check.path);
      await page.getByRole('tab', { name: check.tab }).click();
      await page.getByRole('button', { name: check.button }).click();
      const dialog = page.getByRole('alertdialog', { name: new RegExp(`Delete ${check.tab.toLowerCase()} log`) });
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      const logRef = household.collection('pets').doc(check.path.split('/').at(-1)!).collection(check.collection).doc(check.id);
      expect((await logRef.get()).exists).toBe(true);
      await page.getByRole('button', { name: check.button }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete Log' }).click();
      await expect.poll(async () => (await logRef.get()).exists).toBe(false);
    }
  });

  test('shopping items save with a manual category and after categorization failure', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openAuthenticated(page, '/shopping', 'Shopping Center');
    await page.getByRole('button', { name: 'Open Weekly Groceries' }).click();

    await page.getByRole('button', { name: 'Add Item' }).click();
    let dialog = page.getByRole('dialog', { name: 'Add Item to List' });
    await dialog.getByLabel('Item Name').fill('Manual category item');
    await dialog.getByLabel('Category').click();
    await page.getByRole('option', { name: 'Dairy' }).click();
    await dialog.getByRole('button', { name: 'Add to List' }).click();
    await expect(page.getByRole('checkbox', { name: /Manual category item/ })).toBeVisible();

    await page.route('**/shopping', async (route) => {
      if (route.request().method() === 'POST') await route.abort('failed');
      else await route.continue();
    });
    await page.getByRole('button', { name: 'Add Item' }).click();
    dialog = page.getByRole('dialog', { name: 'Add Item to List' });
    await dialog.getByLabel('Item Name').fill('Fallback category item');
    await dialog.getByRole('button', { name: 'Add to List' }).click();
    await expect(page.getByRole('checkbox', { name: /Fallback category item/ })).toBeVisible();

    const fallbackDocs = await household.collection('shopping-lists').doc('weekly-groceries').collection('items')
      .where('name', '==', 'Fallback category item').get();
    expect(fallbackDocs.size).toBe(1);
    expect(fallbackDocs.docs[0].data().category).toBe('Other');
  });

  test('maintenance schedules distinguish actionable work from checklists', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openAuthenticated(page, '/maintenance?asset=hvac-main', 'Maintenance Center');
    await page.getByRole('button', { name: 'Edit' }).first().click();
    let dialog = page.getByRole('dialog', { name: 'Edit Home Asset' });
    await dialog.getByRole('button', { name: 'Add scheduled maintenance' }).click();
    let item = dialog.getByText('Maintenance item #2', { exact: true }).locator('..').locator('..');
    await item.getByLabel('Schedule Name').fill('Incomplete scheduled item');
    await dialog.getByRole('button', { name: 'Save Asset' }).click();
    await expect(item.getByRole('alert')).toContainText('needs a frequency interval or next due date');

    await item.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'Unscheduled checklist' }).click();
    await expect(item.getByText('Next Due', { exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Save Asset' }).click();
    await expect(page.getByText('Unscheduled checklist item', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Edit' }).first().click();
    dialog = page.getByRole('dialog', { name: 'Edit Home Asset' });
    await dialog.getByRole('button', { name: 'Add scheduled maintenance' }).click();
    item = dialog.getByText('Maintenance item #3', { exact: true }).locator('..').locator('..');
    await item.getByLabel('Schedule Name').fill('Date-only inspection');
    await item.getByText('Next Due', { exact: true }).locator('..').locator('input[type="date"]').fill('2026-09-01');
    await dialog.getByRole('button', { name: 'Save Asset' }).click();

    await expect.poll(async () => {
      const schedules = (await household.collection('home-assets').doc('hvac-main').get()).data()?.schedules || [];
      return schedules.some((schedule: { scheduleName?: string; mode?: string; nextDueDate?: string }) => (
        schedule.scheduleName === 'Incomplete scheduled item' && schedule.mode === 'checklist'
      )) && schedules.some((schedule: { scheduleName?: string; nextDueDate?: string }) => (
        schedule.scheduleName === 'Date-only inspection' && schedule.nextDueDate === '2026-09-01'
      ));
    }).toBe(true);

    await page.getByRole('tab', { name: 'Vehicles' }).click();
    await page.getByRole('button', { name: 'Edit' }).first().click();
    dialog = page.getByRole('dialog', { name: 'Edit Vehicle' });
    await dialog.getByRole('button', { name: 'Add scheduled maintenance' }).click();
    const serviceItem = dialog.getByText('Service item #3', { exact: true }).locator('..').locator('..');
    await serviceItem.getByLabel('Service Name').fill('Mileage-only service');
    await serviceItem.getByText('Next Due Mileage', { exact: true }).locator('..').locator('input[type="number"]').fill('52000');
    await dialog.getByRole('button', { name: 'Save Vehicle' }).click();
    await expect.poll(async () => {
      const schedules = (await household.collection('vehicles').doc('family-suv').get()).data()?.serviceSchedules || [];
      const mileageOnly = schedules.some((schedule: { serviceName?: string; nextDueMileage?: number }) => (
        schedule.serviceName === 'Mileage-only service' && schedule.nextDueMileage === 52000
      ));
      const combined = schedules.some((schedule: { id?: string; nextDueDate?: string; nextDueMileage?: number }) => (
        schedule.id === 'tire-rotation-e2e' && schedule.nextDueDate && schedule.nextDueMileage
      ));
      return mileageOnly && combined;
    }).toBe(true);
  });

  test('affected icon controls and dialogs expose accessible names and descriptions', async ({ page, context }, testInfo) => {
    await openAuthenticated(page, '/chores', 'Chore Chart');
    const choreDelete = page.getByRole('button', { name: 'Delete Fold clean laundry' });
    await expect(choreDelete).toBeVisible();
    await choreDelete.click();
    const choreDialog = page.getByRole('alertdialog', { name: 'Delete Fold clean laundry?' });
    await expect(choreDialog).toHaveAttribute('aria-describedby', /.+/);
    await choreDialog.getByRole('button', { name: 'Cancel' }).click();

    await openAuthenticated(page, '/shopping', 'Shopping Center');
    await expect(page.getByRole('button', { name: 'Open actions for Weekly Groceries' })).toBeVisible();
    await page.getByRole('button', { name: 'Open Weekly Groceries' }).click();
    const shoppingWidths = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(shoppingWidths.scrollWidth).toBeLessThanOrEqual(shoppingWidths.clientWidth);
    await page.getByRole('button', { name: 'Add Item' }).click();
    const itemDialog = page.getByRole('dialog', { name: 'Add Item to List' });
    await expect(itemDialog).toHaveAttribute('aria-describedby', /.+/);
    await page.keyboard.press('Escape');

    await openAuthenticated(page, '/library', 'Barcode Library');
    await page.getByRole('button', { name: 'Add Item' }).click();
    const libraryDialog = page.getByRole('dialog', { name: 'Add New Library Item' });
    await expect(libraryDialog).toHaveAttribute('aria-describedby', /.+/);
    await expect(page.getByRole('button', { name: 'Scan product barcode' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Delete E2E Oat Cereal' })).toBeVisible();

    await openAuthenticated(page, '/pets', 'Your Pets');
    await expect(page.getByRole('button', { name: 'Open actions for Maple' })).toBeVisible();

    await openAuthenticated(page, '/maintenance?log=oil-change', 'Maintenance Center');
    await expect(page.getByRole('button', { name: 'Edit maintenance log Engine oil and filter' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete maintenance log Engine oil and filter' })).toBeVisible();

    await openAuthenticated(page, '/notifications', 'Notification Center');
    const notificationLink = page.getByRole('link', { name: /HVAC filter due today/ });
    if (testInfo.project.name === 'desktop-chromium') {
      await notificationLink.hover();
      await expect(page.getByRole('button', { name: 'Dismiss HVAC filter due today' })).toBeVisible();
    } else {
      await notificationLink.scrollIntoViewIfNeeded();
      await expect(notificationLink).toBeVisible();
      const draggableNotification = notificationLink.locator('..');
      const notificationBox = await draggableNotification.boundingBox();
      expect(notificationBox).not.toBeNull();
      const touchClient = await context.newCDPSession(page);
      const touchY = notificationBox!.y + notificationBox!.height / 2;
      const touchStartX = notificationBox!.x + notificationBox!.width - 20;
      await touchClient.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: touchStartX, y: touchY }],
      });
      await expect(draggableNotification).toHaveCSS('cursor', 'grabbing');
      await touchClient.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: touchStartX - 110, y: touchY }],
      });
      await expect.poll(async () => draggableNotification.evaluate((element) => element.getAttribute('style') || ''))
        .toContain('translateX(-110px)');
      await touchClient.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await touchClient.detach();
      await expect.poll(async () => {
        const snapshot = await household.collection('notifications').where('title', '==', 'HVAC filter due today').get();
        return snapshot.docs.some((notification) => Boolean(notification.data().dismissedBy?.[ownerUid]));
      }).toBe(true);
    }
  });

  test('barcode metadata deletion is prompt for managed, missing, external, empty, and unavailable images', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const collection = household.collection('barcode-library');
    const managedPath = `${household.path}/barcode-library/managed-e2e.png`;
    await getStorage(adminApp).bucket().file(managedPath).save(Buffer.from('e2e image'), { contentType: 'image/png' });

    const records = [
      ['100000000001', { name: 'Managed image item', imageUrl: '', imagePath: managedPath }],
      ['100000000002', { name: 'Missing image item', imageUrl: '', imagePath: `${household.path}/barcode-library/missing.png` }],
      ['100000000003', { name: 'External image item', imageUrl: 'https://images.example.test/product.png' }],
      ['100000000004', { name: 'No image item', imageUrl: '' }],
      ['100000000005', { name: 'Unavailable storage item', imageUrl: '', imagePath: `${household.path}/barcode-library/unavailable.png` }],
    ] as const;
    await Promise.all(records.map(([id, data]) => collection.doc(id).set({ ...data, createdAt: fixedNow.toISOString() })));

    await openAuthenticated(page, '/library', 'Barcode Library');
    for (const [id, data] of records.slice(0, 4)) {
      const startedAt = Date.now();
      await page.getByRole('button', { name: `Delete ${data.name}` }).click();
      await expect.poll(async () => (await collection.doc(id).get()).exists, { timeout: 3_000 }).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    }

    await page.route('http://127.0.0.1:9199/**', async (route) => {
      if (route.request().method() === 'DELETE') await route.abort('failed');
      else await route.continue();
    });
    const unavailableStartedAt = Date.now();
    await page.getByRole('button', { name: 'Delete Unavailable storage item' }).click();
    await expect.poll(async () => (await collection.doc('100000000005').get()).exists, { timeout: 3_000 }).toBe(false);
    expect(Date.now() - unavailableStartedAt).toBeLessThan(3_000);
  });
});
