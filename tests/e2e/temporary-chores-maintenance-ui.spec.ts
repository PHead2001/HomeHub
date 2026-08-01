import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';

const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const adminApp = getApps().find((app) => app.name === 'temporary-chores-maintenance-ui')
  || initializeApp({ projectId, storageBucket: `${projectId}.appspot.com` }, 'temporary-chores-maintenance-ui');
const adminDb = getFirestore(adminApp);
const household = adminDb.collection('households').doc(householdId);
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');

async function openAuthenticated(page: Page, path: string, heading: string) {
  await page.clock.setFixedTime(fixedNow);
  await page.goto(path);
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  await expect(page.getByText('Sign in with Google', { exact: false })).toHaveCount(0);
}

async function assertNoDocumentOverflow(page: Page) {
  const bounds = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
}

async function assertSwitchBounds(page: Page, name: string) {
  const control = page.getByRole('switch', { name });
  await expect(control).toBeVisible();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt === 4) {
      await control.focus();
      await page.keyboard.press('Space');
    } else {
      await control.click();
    }
    const bounds = await control.evaluate((track) => {
      const thumb = track.firstElementChild;
      if (!(thumb instanceof HTMLElement)) return null;
      const trackBounds = track.getBoundingClientRect();
      const thumbBounds = thumb.getBoundingClientRect();
      return {
        trackLeft: trackBounds.left,
        trackRight: trackBounds.right,
        thumbLeft: thumbBounds.left,
        thumbRight: thumbBounds.right,
      };
    });
    expect(bounds).not.toBeNull();
    expect(bounds!.thumbLeft).toBeGreaterThanOrEqual(bounds!.trackLeft - 0.5);
    expect(bounds!.thumbRight).toBeLessThanOrEqual(bounds!.trackRight + 0.5);
  }
}

async function openChoreManagerItem(page: Page, item: string) {
  await page.getByRole('button', { name: 'Chore Manager' }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

async function createMaintenanceLog(page: Page, title: string) {
  const dialog = page.getByRole('dialog', { name: 'Add Maintenance Log' });
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Date').fill('2026-08-01');
  await dialog.getByRole('button', { name: 'Save Log' }).click();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
}

test.describe('temporary chores and maintenance UI regressions', () => {
  test('future and completed chore switches remain inside their tracks at desktop and mobile widths', async ({ page }, testInfo) => {
    const viewports = testInfo.project.name === 'mobile-chromium'
      ? [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 412, height: 915 }]
      : [{ width: 1440, height: 1000 }];

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await openAuthenticated(page, '/chores', 'Chore Chart');
      await assertSwitchBounds(page, 'Show All');
      await assertSwitchBounds(page, 'History');
      await assertNoDocumentOverflow(page);
    }
  });

  test('chore history controls stay bounded with zero, one, two, and many filtered records', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const roomId = 'carousel-bounds-room';
    const testIds = Array.from({ length: 10 }, (_, index) => `carousel-bounds-${index}`);
    await household.collection('rooms').doc(roomId).set({ name: 'Carousel Bounds Room', icon: 'Home' });

    try {
      for (const count of [0, 1, 2, 5]) {
        await Promise.all(testIds.map((id) => household.collection('chores').doc(id).delete()));
        await Promise.all(Array.from({ length: count }, (_, index) => household.collection('chores').doc(testIds[index]).set({
          task: `Carousel item ${index + 1}`,
          assignedToEmail: 'alex.e2e@example.test',
          assignedToDisplayName: 'Alex E2E',
          dueDate: index % 2 === 0 ? '2026-08-10' : '2026-07-31',
          isCompleted: index % 2 === 1,
          completedAt: index % 2 === 1 ? '2026-08-01T10:00:00.000Z' : null,
          originalDueDate: index % 2 === 0 ? '2026-08-10' : '2026-07-31',
          roomIds: [roomId],
          sourceType: 'temporary',
        })));

        await openAuthenticated(page, '/chores', 'Chore Chart');
        await page.getByRole('button', { name: 'All Rooms' }).click();
        await page.getByRole('menuitemradio', { name: 'Carousel Bounds Room' }).click();
        await assertSwitchBounds(page, 'Show All');
        await assertSwitchBounds(page, 'History');
        await assertNoDocumentOverflow(page);
      }
    } finally {
      await Promise.all(testIds.map((id) => household.collection('chores').doc(id).delete()));
      await household.collection('rooms').doc(roomId).delete();
    }
  });

  test('Temporary Task creates one direct chore and one notification without a template', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const taskName = 'Replace hallway filter E2E';
    const existing = await household.collection('chores').where('task', '==', taskName).get();
    await Promise.all(existing.docs.map((item) => item.ref.delete()));
    const templateCount = (await household.collection('chore-templates').get()).size;

    await openAuthenticated(page, '/chores', 'Chore Chart');
    await openChoreManagerItem(page, 'Temporary Task');
    let dialog = page.getByRole('dialog', { name: 'Temporary Task' });
    await expect(dialog).toContainText('without adding it to the reusable chore library');
    await dialog.getByLabel('Task name').fill('Canceled temporary task');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect((await household.collection('chores').where('task', '==', 'Canceled temporary task').get()).size).toBe(0);

    await openChoreManagerItem(page, 'Temporary Task');
    dialog = page.getByRole('dialog', { name: 'Temporary Task' });
    await dialog.getByRole('button', { name: 'Create Temporary Task' }).click();
    await expect(dialog.getByRole('alert')).toHaveCount(4);

    await dialog.getByLabel('Task name').fill(taskName);
    await dialog.getByLabel(/Notes/).fill('Use the spare MERV 11 filter from the hall closet.');
    await dialog.getByLabel('Room').click();
    await page.getByRole('option', { name: 'Living Room' }).click();
    await dialog.getByLabel('Assignee').click();
    await page.getByRole('option', { name: 'Sam Member' }).click();
    await dialog.getByLabel('Due date').fill('2026-08-04');

    const createButton = dialog.getByRole('button', { name: 'Create Temporary Task' });
    await createButton.evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect(dialog).toHaveCount(0);

    const created = await household.collection('chores').where('task', '==', taskName).get();
    expect(created.size).toBe(1);
    const chore = created.docs[0];
    expect(chore.data()).toMatchObject({
      sourceType: 'temporary',
      notes: 'Use the spare MERV 11 filter from the hall closet.',
      originalDueDate: '2026-08-04',
      assignedToEmail: 'sam.member@example.test',
      roomIds: ['living-room'],
      isCompleted: false,
    });
    expect(chore.data().templateId).toBeUndefined();
    expect((await household.collection('chore-templates').get()).size).toBe(templateCount);
    const notifications = await household.collection('notifications').where('sourceId', '==', chore.id).get();
    expect(notifications.size).toBe(1);
    expect(notifications.docs[0].data()).toMatchObject({
      sourceType: 'chore-assignment',
      targetUserEmail: 'sam.member@example.test',
      deepLink: '/chores',
    });

    await page.reload();
    await page.getByRole('button', { name: /^Future \(/ }).click();
    await expect(page.getByText(taskName, { exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: `Select ${taskName}` }).click();
    await page.getByRole('button', { name: 'Complete selected' }).click();
    await expect.poll(async () => (await chore.ref.get()).data()?.isCompleted).toBe(true);
    await page.getByRole('button', { name: /^Completed \(/ }).click();
    await page.getByRole('button', { name: /Living Room/ }).last().click();
    await page.getByRole('button', { name: `Delete ${taskName}` }).click();
    const deleteDialog = page.getByRole('alertdialog', { name: `Delete ${taskName}?` });
    await deleteDialog.getByRole('button', { name: 'Cancel' }).click();
    expect((await chore.ref.get()).exists).toBe(true);
    await page.getByRole('button', { name: `Delete ${taskName}` }).click();
    await page.getByRole('alertdialog', { name: `Delete ${taskName}?` }).getByRole('button', { name: 'Delete Chore' }).click();
    await expect.poll(async () => (await chore.ref.get()).exists).toBe(false);
  });

  test('home asset deletion preserves logs, resolves reminders, and requires attachment cleanup', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    test.setTimeout(90_000);
    const notificationId = 'test-boiler-reminder-e2e';
    const oldAssets = await household.collection('home-assets').where('name', '==', 'Test Boiler E2E').get();
    const oldLogs = await household.collection('maintenance').where('title', '==', 'Test boiler inspection E2E').get();
    await Promise.all([
      ...oldAssets.docs.map((item) => item.ref.delete()),
      ...oldLogs.docs.map((item) => item.ref.delete()),
      household.collection('notifications').doc(notificationId).delete(),
    ]);

    await openAuthenticated(page, '/maintenance', 'Maintenance Center');
    await page.getByRole('tab', { name: 'Home Assets' }).click();
    await page.getByRole('button', { name: 'Add Home Asset' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add Home Asset' });
    await dialog.getByLabel('Name').fill('Test Boiler E2E');
    await dialog.getByLabel('Location / Room').fill('Basement');
    await dialog.getByRole('button', { name: 'Add scheduled maintenance' }).click();
    const schedule = dialog.getByText('Maintenance item #1', { exact: true }).locator('..').locator('..');
    await schedule.getByLabel('Schedule Name').fill('Boiler visual inspection');
    await schedule.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'Unscheduled checklist' }).click();
    await dialog.getByRole('button', { name: 'Save Asset' }).click();
    await expect(page.getByText('Test Boiler E2E', { exact: true }).first()).toBeVisible();
    const createdAsset = await household.collection('home-assets').where('name', '==', 'Test Boiler E2E').get();
    expect(createdAsset.size).toBe(1);
    const assetRef = createdAsset.docs[0].ref;
    const assetId = assetRef.id;

    await page.getByRole('button', { name: /Test Boiler E2E/ }).first().click();
    await page.getByRole('button', { name: 'Edit home asset Test Boiler E2E' }).click();
    let editAssetDialog = page.getByRole('dialog', { name: 'Edit Home Asset' });
    let editSchedule = editAssetDialog.getByText('Maintenance item #1', { exact: true }).locator('..').locator('..');
    await editSchedule.getByRole('button', { name: 'Remove asset maintenance Boiler visual inspection' }).click();
    const removeDialog = page.getByRole('alertdialog', { name: 'Remove Boiler visual inspection?' });
    await removeDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(editSchedule).toBeVisible();
    await editSchedule.getByRole('button', { name: 'Remove asset maintenance Boiler visual inspection' }).click();
    await page.getByRole('alertdialog', { name: 'Remove Boiler visual inspection?' }).getByRole('button', { name: 'Remove Item' }).click();
    await editAssetDialog.getByRole('button', { name: 'Save Asset' }).click();
    await expect.poll(async () => (await assetRef.get()).data()?.schedules?.length).toBe(0);

    await page.getByRole('button', { name: 'Edit home asset Test Boiler E2E' }).click();
    editAssetDialog = page.getByRole('dialog', { name: 'Edit Home Asset' });
    await editAssetDialog.getByRole('button', { name: 'Add scheduled maintenance' }).click();
    editSchedule = editAssetDialog.getByText('Maintenance item #1', { exact: true }).locator('..').locator('..');
    await editSchedule.getByLabel('Schedule Name').fill('Boiler visual inspection');
    await editSchedule.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'Unscheduled checklist' }).click();
    await editAssetDialog.getByRole('button', { name: 'Save Asset' }).click();
    await expect.poll(async () => (await assetRef.get()).data()?.schedules?.length).toBe(1);

    await page.getByRole('tabpanel', { name: 'Home Assets' }).getByRole('button', { name: 'Add Log' }).click();
    await createMaintenanceLog(page, 'Test boiler inspection E2E');
    const createdLog = await household.collection('maintenance').where('title', '==', 'Test boiler inspection E2E').get();
    expect(createdLog.size).toBe(1);

    const attachmentPanel = page.getByTestId(`attachments-home_asset-${assetId}`);
    await attachmentPanel.locator('input[type="file"]').setInputFiles({
      name: 'boiler-note.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Emulator-only maintenance attachment.'),
    });
    await expect(attachmentPanel.getByText('boiler-note.txt', { exact: true })).toBeVisible();

    await household.collection('notifications').doc(notificationId).set({
      householdId,
      category: 'maintenance',
      title: 'Test boiler reminder',
      message: 'Inspect the test boiler.',
      createdAt: Timestamp.fromDate(new Date('2026-08-01T09:00:00.000Z')),
      expiresAt: Timestamp.fromDate(new Date('2026-08-08T09:00:00.000Z')),
      deepLink: `/maintenance?asset=${assetId}`,
      sourceType: 'maintenance_asset_schedule',
      sourceId: `${assetId}:inspection`,
      stateKey: 'due_today|2026-08-01',
      readBy: {},
      dismissedBy: {},
    });

    await page.getByRole('button', { name: 'Delete home asset Test Boiler E2E' }).click();
    let deleteDialog = page.getByRole('alertdialog', { name: 'Delete home asset Test Boiler E2E?' });
    await deleteDialog.getByRole('button', { name: 'Cancel' }).click();
    expect((await assetRef.get()).exists).toBe(true);
    await page.getByRole('button', { name: 'Delete home asset Test Boiler E2E' }).click();
    await page.getByRole('alertdialog', { name: 'Delete home asset Test Boiler E2E?' }).getByRole('button', { name: 'Delete Home Asset' }).click();
    await expect(page.getByText('Remove attachments first')).toBeVisible();
    expect((await assetRef.get()).exists).toBe(true);

    await attachmentPanel.getByRole('button', { name: 'Delete attachment boiler-note.txt' }).click();
    deleteDialog = page.getByRole('alertdialog', { name: 'Delete attachment boiler-note.txt?' });
    await deleteDialog.getByRole('button', { name: 'Cancel' }).click();
    await attachmentPanel.getByRole('button', { name: 'Delete attachment boiler-note.txt' }).click();
    await page.getByRole('alertdialog', { name: 'Delete attachment boiler-note.txt?' }).getByRole('button', { name: 'Delete Attachment' }).click();
    await expect.poll(async () => (await household.collection('maintenance-attachments').where('targetId', '==', assetId).get()).size).toBe(0);

    await page.getByRole('button', { name: 'Delete home asset Test Boiler E2E' }).click();
    await page.getByRole('alertdialog', { name: 'Delete home asset Test Boiler E2E?' }).getByRole('button', { name: 'Delete Home Asset' }).click();
    await expect.poll(async () => (await assetRef.get()).exists).toBe(false);
    const preservedLog = await createdLog.docs[0].ref.get();
    expect(preservedLog.data()).toMatchObject({ targetType: 'general', formerTargetType: 'home_asset', formerTargetName: 'Test Boiler E2E' });
    expect(preservedLog.data()?.assetId).toBeUndefined();
    expect((await household.collection('notifications').doc(notificationId).get()).data()?.resolvedAt).toBeTruthy();

    await page.goto(`/maintenance?asset=${assetId}`);
    await expect(page.getByText('The requested home asset is no longer available.')).toBeVisible();
    await page.getByRole('tab', { name: 'Logs' }).click();
    await page.getByRole('button', { name: 'Delete maintenance log Test boiler inspection E2E' }).click();
    deleteDialog = page.getByRole('alertdialog', { name: 'Delete maintenance log?' });
    await deleteDialog.getByRole('button', { name: 'Cancel' }).click();
    expect((await createdLog.docs[0].ref.get()).exists).toBe(true);
    await page.getByRole('button', { name: 'Delete maintenance log Test boiler inspection E2E' }).click();
    await page.getByRole('alertdialog', { name: 'Delete maintenance log?' }).getByRole('button', { name: 'Delete Log' }).click();
    await expect.poll(async () => (await createdLog.docs[0].ref.get()).exists).toBe(false);
  });

  test('vehicle, linked logs, general logs, and schedule removals delete with confirmation', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    test.setTimeout(90_000);
    const oldVehicles = await household.collection('vehicles').where('nickname', '==', 'Test Roadster E2E').get();
    const oldLogs = await household.collection('maintenance').where('title', 'in', ['Roadster service E2E', 'General deletion E2E']).get();
    await Promise.all([
      ...oldVehicles.docs.map((item) => item.ref.delete()),
      ...oldLogs.docs.map((item) => item.ref.delete()),
    ]);

    await openAuthenticated(page, '/maintenance', 'Maintenance Center');
    await page.getByRole('tab', { name: 'Vehicles' }).click();
    await page.getByRole('button', { name: 'Add Vehicle' }).click();
    let dialog = page.getByRole('dialog', { name: 'Add Vehicle' });
    await dialog.getByLabel('Nickname').fill('Test Roadster E2E');
    await dialog.getByRole('button', { name: 'Add scheduled maintenance' }).click();
    let schedule = dialog.getByText('Service item #1', { exact: true }).locator('..').locator('..');
    await schedule.getByLabel('Service Name').fill('Roadster checklist E2E');
    await schedule.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'Unscheduled checklist' }).click();
    await dialog.getByRole('button', { name: 'Save Vehicle' }).click();
    await expect(page.getByText('Test Roadster E2E', { exact: true }).first()).toBeVisible();
    await expect.poll(async () => (
      await household.collection('vehicles').where('nickname', '==', 'Test Roadster E2E').get()
    ).size).toBe(1);
    const createdVehicle = await household.collection('vehicles').where('nickname', '==', 'Test Roadster E2E').get();
    const vehicleRef = createdVehicle.docs[0].ref;
    const vehicleId = vehicleRef.id;
    await page.getByRole('button', { name: /Test Roadster E2E/ }).first().click();

    await page.getByRole('tabpanel', { name: 'Vehicles' }).getByRole('button', { name: 'Add Log' }).click();
    await createMaintenanceLog(page, 'Roadster service E2E');
    const vehicleLog = await household.collection('maintenance').where('title', '==', 'Roadster service E2E').get();
    expect(vehicleLog.size).toBe(1);

    await page.getByRole('button', { name: 'Edit vehicle Test Roadster E2E' }).click();
    dialog = page.getByRole('dialog', { name: 'Edit Vehicle' });
    schedule = dialog.getByText('Service item #1', { exact: true }).locator('..').locator('..');
    await schedule.getByRole('button', { name: 'Remove vehicle service Roadster checklist E2E' }).click();
    const removeDialog = page.getByRole('alertdialog', { name: 'Remove Roadster checklist E2E?' });
    await removeDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(schedule).toBeVisible();
    await schedule.getByRole('button', { name: 'Remove vehicle service Roadster checklist E2E' }).click();
    await page.getByRole('alertdialog', { name: 'Remove Roadster checklist E2E?' }).getByRole('button', { name: 'Remove Item' }).click();
    await dialog.getByRole('button', { name: 'Save Vehicle' }).click();
    await expect.poll(async () => (await vehicleRef.get()).data()?.serviceSchedules?.length).toBe(0);

    await page.getByRole('button', { name: 'Delete vehicle Test Roadster E2E' }).click();
    let deleteDialog = page.getByRole('alertdialog', { name: 'Delete vehicle?' });
    await deleteDialog.getByRole('button', { name: 'Cancel' }).click();
    expect((await vehicleRef.get()).exists).toBe(true);
    await page.getByRole('button', { name: 'Delete vehicle Test Roadster E2E' }).click();
    await page.getByRole('alertdialog', { name: 'Delete vehicle?' }).getByRole('button', { name: 'Delete Vehicle' }).click();
    await expect.poll(async () => (await vehicleRef.get()).exists).toBe(false);
    expect((await vehicleLog.docs[0].ref.get()).data()).toMatchObject({ targetType: 'general', formerTargetType: 'vehicle', formerTargetName: 'Test Roadster E2E' });
    await page.goto(`/maintenance?vehicle=${vehicleId}`);
    await expect(page.getByText('The requested vehicle is no longer available.')).toBeVisible();

    await page.getByRole('tab', { name: 'Logs' }).click();
    await page.getByRole('button', { name: 'Delete maintenance log Roadster service E2E' }).click();
    await page.getByRole('alertdialog', { name: 'Delete maintenance log?' }).getByRole('button', { name: 'Delete Log' }).click();
    await expect.poll(async () => (await vehicleLog.docs[0].ref.get()).exists).toBe(false);

    await page.goto('/maintenance');
    await expect(page.getByRole('heading', { name: 'Maintenance Center' })).toBeVisible();
    await page.getByRole('tab', { name: 'Logs' }).click();
    await page.getByRole('button', { name: 'Add Log', exact: true }).first().click();
    await createMaintenanceLog(page, 'General deletion E2E');
    const generalLog = await household.collection('maintenance').where('title', '==', 'General deletion E2E').get();
    await page.getByRole('button', { name: 'Delete maintenance log General deletion E2E' }).click();
    deleteDialog = page.getByRole('alertdialog', { name: 'Delete maintenance log?' });
    await deleteDialog.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Delete maintenance log General deletion E2E' }).click();
    await page.getByRole('alertdialog', { name: 'Delete maintenance log?' }).getByRole('button', { name: 'Delete Log' }).click();
    await expect.poll(async () => (await generalLog.docs[0].ref.get()).exists).toBe(false);
  });

  test('homepage contains only the dashboard and remains bounded on mobile', async ({ page }, testInfo) => {
    const viewports = testInfo.project.name === 'mobile-chromium'
      ? [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 412, height: 915 }]
      : [{ width: 1440, height: 1000 }];
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await openAuthenticated(page, '/', 'Welcome Home');
      await expect(page.getByRole('heading', { name: 'Quick Actions' })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Your Dashboard' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'View Shopping' })).toBeVisible();
      await assertNoDocumentOverflow(page);
    }
  });

  test('Shopping inventory controls and long names remain inside mobile viewports', async ({ page }, testInfo) => {
    const longItemId = 'long-mobile-inventory-e2e';
    await household.collection('pantry-inventory').doc(longItemId).set({
      name: 'Extra long pantry item name that must wrap safely on narrow phones',
      category: 'Pantry',
      quantity: 2,
      unit: 'items',
      location: 'Pantry',
      expiryDate: '2026-08-05',
    });
    const viewports = testInfo.project.name === 'mobile-chromium'
      ? [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 412, height: 915 }]
      : [{ width: 1440, height: 1000 }];
    try {
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await openAuthenticated(page, '/shopping', 'Shopping Center');
        const heading = page.getByRole('heading', { name: 'Shopping Center', exact: true });
        const barcodeLink = page.getByRole('link', { name: 'Barcode Library' });
        await expect(barcodeLink).toBeVisible();
        for (const control of [heading, barcodeLink]) {
          const box = await control.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 0.5);
        }
        await page.getByRole('tab', { name: 'Inventory' }).click();
        await expect(page.getByRole('button', { name: /Pantry \(/ })).toBeVisible();
        await expect(page.getByRole('button', { name: /Fridge \(/ })).toBeVisible();
        await expect(page.getByRole('button', { name: /Freezer \(/ })).toBeVisible();
        const longName = 'Extra long pantry item name that must wrap safely on narrow phones';
        if (viewport.width < 640) {
          await expect(page.getByTestId('mobile-inventory-pantry').getByText(longName, { exact: true })).toBeVisible();
        } else {
          await expect(page.getByRole('cell', { name: longName, exact: true })).toBeVisible();
        }
        await assertNoDocumentOverflow(page);

        if (viewport.width < 640) {
          for (const location of ['pantry', 'fridge', 'freezer']) {
            const list = page.getByTestId(`mobile-inventory-${location}`);
            const box = await list.boundingBox();
            expect(box).not.toBeNull();
            expect(box!.x).toBeGreaterThanOrEqual(0);
            expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 0.5);
          }
        }
      }
    } finally {
      await household.collection('pantry-inventory').doc(longItemId).delete();
    }
  });

  test('pantry inventory item add, edit, and delete flows remain functional', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openAuthenticated(page, '/shopping', 'Shopping Center');
    await page.getByRole('tab', { name: 'Inventory' }).click();
    await page.getByRole('button', { name: 'Add Item' }).click();
    let dialog = page.getByRole('dialog', { name: 'Add New Item' });
    await dialog.getByLabel('Item Name').fill('Inventory CRUD E2E');
    await dialog.getByRole('button', { name: 'Save Item' }).click();
    await expect(page.getByRole('cell', { name: 'Inventory CRUD E2E', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit Inventory CRUD E2E' }).click();
    dialog = page.getByRole('dialog', { name: 'Edit Item' });
    await dialog.getByLabel('Item Name').fill('Inventory CRUD Updated E2E');
    await dialog.getByRole('button', { name: 'Save Item' }).click();
    await expect(page.getByRole('cell', { name: 'Inventory CRUD Updated E2E', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Delete Inventory CRUD Updated E2E' }).click();
    let deleteDialog = page.getByRole('alertdialog', { name: 'Delete Inventory CRUD Updated E2E?' });
    await deleteDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('cell', { name: 'Inventory CRUD Updated E2E', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Delete Inventory CRUD Updated E2E' }).click();
    deleteDialog = page.getByRole('alertdialog', { name: 'Delete Inventory CRUD Updated E2E?' });
    await deleteDialog.getByRole('button', { name: 'Delete Only' }).click();
    await expect(page.getByRole('cell', { name: 'Inventory CRUD Updated E2E', exact: true })).toHaveCount(0);
  });
});
