import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';

// Chores wave 2: one-tap completion with Undo, quick add with inline validation,
// select mode, the left-aligned header and the /calendar page (H05, H06, H19, D11).
const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const ownerEmail = 'alex.e2e@example.test';
const adminApp = getApps().find((app) => app.name === 'chores-ux')
  || initializeApp({ projectId, storageBucket: `${projectId}.appspot.com` }, 'chores-ux');
const adminDb = getFirestore(adminApp);
const household = adminDb.collection('households').doc(householdId);
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');

async function open(page: Page, path: string, heading: string) {
  await page.clock.setFixedTime(fixedNow);
  await page.goto(path);
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  await expect(page.getByText('Sign in with Google', { exact: false })).toHaveCount(0);
}

async function documentOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

const seedChore = (id: string, data: Record<string, unknown>) => household.collection('chores').doc(id).set({
  assignedToEmail: ownerEmail,
  assignedToDisplayName: 'Alex E2E',
  dueDate: '2026-08-01',
  originalDueDate: '2026-08-01',
  isCompleted: false,
  roomIds: ['kitchen'],
  ...data,
});

test.describe('chores wave 2', () => {
  test('header is left-aligned with actions and links to the calendar', async ({ page }) => {
    await open(page, '/chores', 'Chore Chart');
    const heading = page.getByRole('heading', { name: 'Chore Chart', exact: true });
    expect(await heading.evaluate((el) => getComputedStyle(el).textAlign)).not.toBe('center');
    await expect(page.getByRole('button', { name: 'Add Chore' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Calendar' })).toHaveAttribute('href', '/calendar');
    expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('one tap completes a chore and Undo restores it exactly', async ({ page }) => {
    const id = 'chores-ux-one-tap';
    const ref = household.collection('chores').doc(id);
    await seedChore(id, { task: 'Chores UX one tap', subTasks: ['Rinse', 'Dry'], completedSubTasks: ['Rinse'] });
    try {
      await open(page, '/chores', 'Chore Chart');
      await page.getByRole('checkbox', { name: 'Mark Chores UX one tap done' }).click();
      await expect.poll(async () => (await ref.get()).data()?.isCompleted).toBe(true);
      const done = (await ref.get()).data()!;
      expect(done.completedAtServer).toBeTruthy();
      expect(done.completedSubTasks).toEqual(['Rinse', 'Dry']);

      await page.getByRole('button', { name: 'Undo' }).click();
      await expect.poll(async () => (await ref.get()).data()?.isCompleted).toBe(false);
      const restored = (await ref.get()).data()!;
      expect(restored.completedAtServer).toBeUndefined();
      expect(restored.completedAt).toBeUndefined();
      expect(restored.completedSubTasks).toEqual(['Rinse']);
      await expect(page.getByRole('checkbox', { name: 'Mark Chores UX one tap done' })).toHaveAttribute('aria-checked', 'false');
    } finally {
      await ref.delete();
    }
  });

  test('Add Chore validates inline, defaults to me and does not notify me', async ({ page }) => {
    const taskName = 'Chores UX quick add';
    const existing = await household.collection('chores').where('task', '==', taskName).get();
    await Promise.all(existing.docs.map((d) => d.ref.delete()));
    await open(page, '/chores', 'Chore Chart');
    await page.getByRole('button', { name: 'Add Chore' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add chore' });
    await dialog.getByRole('button', { name: 'Add Chore' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Give the chore a name.');
    await expect(dialog.getByLabel('Chore', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.getByLabel('Who')).toContainText('Alex E2E');

    await dialog.getByLabel('Chore', { exact: true }).fill(taskName);
    await dialog.getByRole('button', { name: 'Add Chore' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await household.collection('chores').where('task', '==', taskName).get()).size).toBe(1);
    const created = (await household.collection('chores').where('task', '==', taskName).get()).docs[0];
    expect(created.data()).toMatchObject({ assignedToEmail: ownerEmail, sourceType: 'temporary', isCompleted: false });
    expect((await household.collection('notifications').where('sourceId', '==', created.id).get()).size).toBe(0);
    await created.ref.delete();
  });

  test('select mode completes several chores at once', async ({ page }) => {
    const ids = ['chores-ux-bulk-a', 'chores-ux-bulk-b'];
    await Promise.all(ids.map((id, i) => seedChore(id, { task: `Chores UX bulk ${i + 1}` })));
    try {
      await open(page, '/chores', 'Chore Chart');
      await page.getByRole('button', { name: 'Select' }).click();
      await page.getByRole('checkbox', { name: 'Select Chores UX bulk 1' }).click();
      await page.getByRole('checkbox', { name: 'Select Chores UX bulk 2' }).click();
      await page.getByRole('button', { name: 'Complete selected' }).click();
      for (const id of ids) {
        await expect.poll(async () => (await household.collection('chores').doc(id).get()).data()?.isCompleted).toBe(true);
      }
    } finally {
      await Promise.all(ids.map((id) => household.collection('chores').doc(id).delete()));
    }
  });

  test('missed repeating chores fold into the latest one', async ({ page }) => {
    const ids = ['chores-ux-missed-1', 'chores-ux-missed-2'];
    await seedChore(ids[0], { task: 'Chores UX repeating', templateId: 'chores-ux-series', originalDueDate: '2026-07-29', dueDate: '2026-07-29' });
    await seedChore(ids[1], { task: 'Chores UX repeating', templateId: 'chores-ux-series', originalDueDate: '2026-07-30', dueDate: '2026-07-30' });
    try {
      await open(page, '/chores', 'Chore Chart');
      await expect(page.getByText('Chores UX repeating', { exact: true })).toHaveCount(1);
      await expect(page.getByText('+1 earlier missed')).toBeVisible();
    } finally {
      await Promise.all(ids.map((id) => household.collection('chores').doc(id).delete()));
    }
  });

  test('the calendar shows today, the overdue rail and moves a chore by keyboard', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const id = 'chores-ux-calendar';
    const ref = household.collection('chores').doc(id);
    await seedChore(id, { task: 'Chores UX overdue', originalDueDate: '2026-07-29', dueDate: '2026-07-29' });
    try {
      await open(page, '/calendar', 'Calendar');
      await expect(page.getByText('Today', { exact: true }).first()).toBeVisible();
      const rail = page.getByRole('complementary').filter({ has: page.getByRole('heading', { name: /Overdue/ }) });
      const chip = rail.getByRole('button', { name: /Chore: Chores UX overdue/ });
      await expect(chip).toBeVisible();

      await chip.focus();
      await page.keyboard.press('Enter');
      const moveField = page.getByLabel('Move to date');
      await moveField.fill('2026-08-03');
      await page.getByRole('button', { name: 'Move', exact: true }).click();
      await expect.poll(async () => (await ref.get()).data()?.originalDueDate).toBe('2026-08-03');
      await expect(rail.getByRole('button', { name: /Chore: Chores UX overdue/ })).toHaveCount(0);

      await page.getByRole('radio', { name: 'Month' }).click();
      await expect(page.getByRole('heading', { name: 'Calendar', exact: true })).toBeVisible();
      expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
    } finally {
      await ref.delete();
    }
  });

  test('calendar and chores fit a phone screen', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium');
    await open(page, '/chores', 'Chore Chart');
    expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
    await open(page, '/calendar', 'Calendar');
    expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
  });
});
