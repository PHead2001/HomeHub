import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
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
    // H28: the button names the global shortcut that does the same (shared ShortcutHint).
    const addChore = page.getByRole('main').getByRole('button', { name: 'Add Chore' });
    await expect(addChore).toHaveAttribute('aria-keyshortcuts', 'N');
    await addChore.hover();
    await expect(page.getByTestId('shortcut-hint-new-chore')).toContainText('New chore from anywhere');
    await page.mouse.move(0, 0);
    // The page's own link (the header nav also has one once the dashboard PR lands).
    await expect(page.getByRole('main').getByRole('link', { name: 'Calendar' })).toHaveAttribute('href', '/calendar');
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
      await expect(page.getByText('1 chore selected', { exact: true })).toBeVisible();
      await page.getByRole('checkbox', { name: 'Select Chores UX bulk 2' }).click();
      await expect(page.getByText('2 chores selected', { exact: true })).toBeVisible();
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
    // Only instances of a template that currently repeats fold. Monthly on the 28th
    // keeps the generated instances out of today's To Do.
    const template = household.collection('chore-templates').doc('chores-ux-series');
    await template.set({
      task: 'Chores UX repeating',
      roomIds: ['kitchen'],
      assignedToEmail: ownerEmail,
      recurrence: { frequency: 'monthly', interval: 1, assignedToEmail: ownerEmail, monthlyOptions: { mode: 'dayOfMonth', dayOfMonth: 28 } },
    });
    await seedChore(ids[0], { task: 'Chores UX repeating', templateId: 'chores-ux-series', originalDueDate: '2026-07-29', dueDate: '2026-07-29' });
    await seedChore(ids[1], { task: 'Chores UX repeating', templateId: 'chores-ux-series', originalDueDate: '2026-07-30', dueDate: '2026-07-30' });
    try {
      await open(page, '/chores', 'Chore Chart');
      await expect(page.getByText('Chores UX repeating', { exact: true })).toHaveCount(1);
      // Scope to this series' row: seeded chores (e.g. Reset the kitchen) may fold too.
      const row = page.getByRole('listitem').filter({ hasText: 'Chores UX repeating' });
      await expect(row.getByText('+1 earlier missed')).toBeVisible();
      await expect(row.getByText('Thu, Jul 30')).toBeVisible();
    } finally {
      await template.delete();
      const generated = await household.collection('chores').where('templateId', '==', 'chores-ux-series').get();
      await Promise.all([...ids.map((id) => household.collection('chores').doc(id).delete()), ...generated.docs.map((d) => d.ref.delete())]);
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

  test('the calendar day agenda changes days by keyboard and shows upcoming medication', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const id = 'chores-ux-agenda';
    const flea = household.collection('pets').doc('pixel').collection('medication-logs').doc('flea-prevention');
    await seedChore(id, { task: 'Chores UX agenda', originalDueDate: '2026-08-02', dueDate: '2026-08-02' });
    await flea.update({ nextDueDate: '2026-08-03' });
    try {
      await open(page, '/calendar', 'Calendar');
      await page.getByRole('radio', { name: 'Day' }).click();
      const agenda = page.getByTestId('calendar-agenda');
      await expect(agenda).toHaveAttribute('data-day', '2026-08-01');
      await expect(agenda).toHaveAttribute('aria-label', /, today, /);
      // Today glows.
      await expect(agenda).toHaveClass(/ring-primary/);

      await agenda.focus();
      await page.keyboard.press('ArrowRight');
      await expect(agenda).toHaveAttribute('data-day', '2026-08-02');
      await expect(agenda.getByRole('button', { name: /Chore: Chores UX agenda/ })).toBeVisible();
      await expect(agenda).not.toHaveClass(/ring-primary/);

      // The upcoming dose, from the same countdown rule as the pet card.
      await page.getByRole('button', { name: 'Next day' }).click();
      await expect(agenda).toHaveAttribute('data-day', '2026-08-03');
      const dose = agenda.getByRole('button', { name: /^Medication due: Monthly flea prevention.*Pixel, due in 2 days/ });
      await expect(dose).toBeVisible();
      // Peek (H26): hovering an entry shows its key facts.
      await dose.hover();
      await expect(page.getByTestId('calendar-peek')).toContainText('Due in 2 days');
      await page.mouse.move(0, 0);

      await agenda.focus();
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await expect(agenda).toHaveAttribute('data-day', '2026-08-01');

    } finally {
      await household.collection('chores').doc(id).delete();
      await flea.update({ nextDueDate: FieldValue.delete() }).catch(() => undefined);
    }
  });

  test('phones open on the day agenda and swipe between days', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium');
    await open(page, '/calendar', 'Calendar');
    await expect(page.getByRole('radio', { name: 'Day' })).toHaveAttribute('aria-checked', 'true');
    const agenda = page.getByTestId('calendar-agenda');
    await expect(agenda).toHaveAttribute('data-day', '2026-08-01');
    const swipe = (dx: number) => agenda.evaluate((element, distance) => {
      const box = element.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + 40;
      const touch = (clientX: number) => new Touch({ identifier: 1, target: element, clientX, clientY: y });
      element.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(x)], changedTouches: [touch(x)] }));
      element.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [touch(x + distance)] }));
    }, dx);
    await swipe(-120);
    await expect(agenda).toHaveAttribute('data-day', '2026-08-02');
    await swipe(120);
    await swipe(120);
    await expect(agenda).toHaveAttribute('data-day', '2026-07-31');
    expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('calendar and chores fit a phone screen', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium');
    await open(page, '/chores', 'Chore Chart');
    expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
    await open(page, '/calendar', 'Calendar');
    expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
  });
});

test.describe('chore library and empty household', () => {
  test('deleting a library chore asks to confirm, then removes it and its open chores', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const task = 'Chores UX library delete';
    const template = household.collection('chore-templates').doc('chores-ux-library-delete');
    const openChore = household.collection('chores').doc('chores-ux-library-open');
    await template.set({ task, roomIds: ['kitchen'] });
    await seedChore(openChore.id, { task, templateId: template.id });
    try {
      await open(page, '/chores', 'Chore Chart');
      await page.getByRole('button', { name: 'Chore Manager' }).click();
      await page.getByRole('menuitem', { name: 'Chore library' }).click();
      const library = page.getByRole('dialog', { name: 'Chore library' });
      await expect(library.getByRole('cell', { name: task, exact: true })).toBeVisible();

      // Cancel keeps it.
      await library.getByRole('button', { name: `Delete ${task}`, exact: true }).click();
      const confirm = page.getByRole('alertdialog', { name: `Delete ${task}?` });
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText('deletes its open chores');
      await confirm.getByRole('button', { name: 'Cancel' }).click();
      await expect(confirm).toHaveCount(0);
      expect((await template.get()).exists).toBe(true);

      await library.getByRole('button', { name: `Delete ${task}`, exact: true }).click();
      await confirm.getByRole('button', { name: 'Delete Chore' }).click();
      // The toast first: it auto-dismisses, so check it before the slower Firestore polls.
      // The open library dialog is modal, so the notifications region is aria-hidden behind it.
      await expect(page.getByRole('region', { name: /notification/i, includeHidden: true }).getByText('Chore deleted', { exact: true })).toBeVisible();
      await expect.poll(async () => (await template.get()).exists).toBe(false);
      await expect.poll(async () => (await openChore.get()).exists).toBe(false);
      await expect(library.getByRole('cell', { name: task, exact: true })).toHaveCount(0);
    } finally {
      await template.delete();
      await openChore.delete();
    }
  });

  test('an empty household gets a call to action that opens Add Chore', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    // Household B (seeded with one private chore) is emptied for this test and restored after.
    const otter = adminDb.collection('households').doc('the-otter-residence-e2e');
    const [chores, templates] = await Promise.all([otter.collection('chores').get(), otter.collection('chore-templates').get()]);
    const saved = [...chores.docs, ...templates.docs].map((d) => ({ ref: d.ref, data: d.data() }));
    await Promise.all(saved.map(({ ref }) => ref.delete()));
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:9002', colorScheme: 'dark' });
    try {
      const page = await context.newPage();
      await page.clock.setFixedTime(fixedNow);
      await page.goto('/e2e-login?uid=e2e-household-b-owner-uid');
      await expect(page).toHaveURL('/');
      await open(page, '/chores', 'Chore Chart');
      await expect(page.getByRole('heading', { name: 'No chores yet', exact: true })).toBeVisible();
      const cta = page.getByRole('button', { name: 'Add your first chore', exact: true });
      await expect(cta).toBeVisible();
      await cta.click();
      const dialog = page.getByRole('dialog', { name: 'Add chore' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('Chore', { exact: true })).toBeVisible();
      // Closing without saving writes nothing.
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      expect((await otter.collection('chores').get()).size).toBe(0);
    } finally {
      await context.close();
      await Promise.all(saved.map(({ ref, data }) => ref.set(data)));
    }
  });
});
