import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';

/*
 * Wave 4 shell gaps: natural-language quick add that really creates the repeating
 * chore and the maintenance log (H13, deterministic parser and the AI fallback),
 * shortcut hints (H28), tab and route transitions plus stagger (D09/H12), the AI
 * rewrite of the morning brief (H04), and the visual/a11y checks the verification
 * could not settle (long household name, dialog close names).
 */

const projectId = 'demo-homehub-e2e';
const adminApp = getApps().find((app) => app.name === 'shell-wave4')
  || initializeApp({ projectId }, 'shell-wave4');
const household = getFirestore(adminApp).collection('households').doc('the-foxy-residence-e2e');

const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');

async function openDashboard(page: Page) {
  await page.clock.setFixedTime(fixedNow);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome Home', exact: true })).toBeVisible();
  await expect(page.getByTestId('header-search')).toBeVisible();
}

async function openPalette(page: Page) {
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Search or quick add' });
  await expect(palette).toBeVisible();
  return { palette, input: palette.getByRole('combobox', { name: 'Search or quick add' }) };
}

async function removeTemplates(task: string) {
  const templates = await household.collection('chore-templates').where('task', '==', task).get();
  for (const template of templates.docs) {
    const [chores, notes] = await Promise.all([
      household.collection('chores').where('templateId', '==', template.id).get(),
      household.collection('notifications').where('sourceId', '==', template.id).get(),
    ]);
    await Promise.all([...chores.docs, ...notes.docs].map((entry) => entry.ref.delete()));
    await template.ref.delete();
  }
}

async function removeLogs(title: string) {
  const logs = await household.collection('maintenance').where('title', '==', title).get();
  await Promise.all(logs.docs.map((log) => log.ref.delete()));
}

test.describe('H13: natural-language quick add writes what it says', () => {
  test('"trash every Tuesday for Sam" creates the repeating chore after Confirm', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await removeTemplates('Trash');
    try {
      await openDashboard(page);
      const { palette, input } = await openPalette(page);
      await input.fill('trash every Tuesday for Sam');
      const suggestion = palette.getByTestId('palette-quick-add');
      await expect(suggestion).toContainText('Repeating chore: Trash');
      await expect(suggestion).toContainText('every Tuesday');
      await input.press('Enter');
      const preview = palette.getByTestId('quick-add-preview');
      await expect(preview).toBeVisible();
      await expect(preview).toContainText('for Sam Member');
      await expect(preview.getByRole('combobox', { name: 'Assign to' })).toHaveValue('sam.member@example.test');
      // Nothing is written before Confirm.
      expect((await household.collection('chore-templates').where('task', '==', 'Trash').get()).size).toBe(0);
      await preview.getByRole('combobox', { name: 'Room' }).selectOption('garage');
      await preview.getByTestId('quick-add-confirm').click();
      await expect(palette).toHaveCount(0);
      await expect.poll(async () => (await household.collection('chore-templates').where('task', '==', 'Trash').get()).size).toBe(1);
      const template = (await household.collection('chore-templates').where('task', '==', 'Trash').get()).docs[0].data();
      expect(template).toMatchObject({
        task: 'Trash',
        roomIds: ['garage'],
        assignedToEmail: 'sam.member@example.test',
        recurrence: { frequency: 'weekly', interval: 1, weeklyOptions: { daysOfWeek: [2] }, assignedToEmail: 'sam.member@example.test' },
      });
    } finally {
      await removeTemplates('Trash');
    }
  });

  test('"oil change 48,200 miles" logs maintenance with the odometer for the vehicle', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await removeLogs('Oil change');
    try {
      await openDashboard(page);
      const { palette, input } = await openPalette(page);
      await input.fill('oil change 48,200 miles');
      await expect(palette.getByTestId('palette-quick-add')).toContainText('Log maintenance: Oil change');
      await input.press('Enter');
      const preview = palette.getByTestId('quick-add-preview');
      // The household's only vehicle is preselected; the reading is below its odometer, so the card says so.
      await expect(preview.getByRole('combobox', { name: 'Vehicle' })).toHaveValue('vehicle:family-suv');
      await expect(preview.getByTestId('quick-add-mileage-note')).toContainText('48,750');
      expect((await household.collection('maintenance').where('title', '==', 'Oil change').get()).size).toBe(0);
      // The index has loaded and a vehicle is chosen, so nothing blocks Confirm.
      await expect(preview.getByTestId('quick-add-blocker')).toHaveCount(0);
      await expect(preview.getByTestId('quick-add-confirm')).toBeEnabled();
      await preview.getByTestId('quick-add-confirm').click();
      await expect(palette).toHaveCount(0);
      await expect.poll(async () => (await household.collection('maintenance').where('title', '==', 'Oil change').get()).size).toBe(1);
      const log = (await household.collection('maintenance').where('title', '==', 'Oil change').get()).docs[0].data();
      expect(log).toMatchObject({ targetType: 'vehicle', vehicleId: 'family-suv', mileage: 48_200, type: 'routine', item: 'Oil change' });
    } finally {
      await removeLogs('Oil change');
    }
  });

  test('a sentence the parser cannot read is read by AI on request, previewed, then saved', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await removeTemplates('Recycling');
    try {
      await openDashboard(page);
      const { palette, input } = await openPalette(page);
      await input.fill('could sam deal with the recycling on tuesdays');
      const ask = palette.getByRole('option', { name: /with AI/ });
      await expect(ask).toBeVisible();
      await ask.click();
      const preview = palette.getByTestId('quick-add-preview');
      await expect(preview).toBeVisible();
      await expect(preview.getByTestId('quick-add-ai-marker')).toBeVisible();
      await expect(preview).toContainText('Repeating chore: Recycling');
      expect((await household.collection('chore-templates').where('task', '==', 'Recycling').get()).size).toBe(0);
      await preview.getByTestId('quick-add-confirm').click();
      await expect(palette).toHaveCount(0);
      await expect.poll(async () => (await household.collection('chore-templates').where('task', '==', 'Recycling').get()).size).toBe(1);
    } finally {
      await removeTemplates('Recycling');
    }
  });
});

test.describe('H28: shortcut hints in tooltips', () => {
  test('header search and dashboard quick-add buttons show their keys from the shortcut map', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openDashboard(page);
    const search = page.getByTestId('header-search');
    await expect(search).toHaveAttribute('aria-keyshortcuts', 'Control+K Meta+K');
    await search.hover();
    await expect(page.getByTestId('shortcut-hint-palette')).toContainText('Ctrl / ⌘');
    await page.mouse.move(0, 0);

    const addChore = page.getByTestId('tile-quick-add-new-chore');
    await expect(addChore).toHaveAttribute('aria-keyshortcuts', 'N');
    await addChore.focus();
    await expect(page.getByTestId('shortcut-hint-new-chore')).toContainText('N');
    await expect(page.getByTestId('tile-quick-add-add-item')).toHaveAttribute('aria-keyshortcuts', 'A');
    await expect(page.getByTestId('tile-quick-add-log-feeding')).toHaveAttribute('aria-keyshortcuts', 'F');

    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Chores' }).hover();
    await expect(page.getByTestId('shortcut-hint-go-chores')).toContainText('then');

    await addChore.click();
    await expect(page.getByRole('dialog', { name: 'Search or quick add' }).getByRole('combobox')).toHaveValue('chore ');
  });
});

test.describe('H12/D09: motion', () => {
  test('tab panels fade in on switch, instantly under reduced motion', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await page.clock.setFixedTime(fixedNow);
    await page.goto('/household');
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible();
    // The first panel does not animate (the page itself is entering).
    expect(await page.getByRole('tabpanel').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    await page.getByRole('tab', { name: 'Roles' }).click();
    expect(await page.getByRole('tabpanel').evaluate((el) => getComputedStyle(el).animationName)).toMatch(/tab-enter/);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('tab', { name: 'Overview' }).click();
    expect(await page.getByRole('tabpanel').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  });

  test('route changes use a view transition with the header outside it', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await page.addInitScript(() => {
      const w = window as unknown as { __vt: Array<{ header: string; page: string | null }> };
      w.__vt = [];
      const original = document.startViewTransition?.bind(document);
      if (!original) return;
      document.startViewTransition = ((update: () => Promise<void>) => {
        const header = document.querySelector('[data-site-header]');
        const content = document.querySelector('[data-page-transition]');
        w.__vt.push({
          header: header ? getComputedStyle(header).viewTransitionName : 'missing',
          page: content ? getComputedStyle(content).viewTransitionName : null,
        });
        return original(update);
      }) as typeof document.startViewTransition;
    });
    await openDashboard(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Pets' }).click();
    await expect(page).toHaveURL(/\/pets$/);
    const calls = await page.evaluate(() => (window as unknown as { __vt: Array<{ header: string; page: string | null }> }).__vt);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ header: 'site-header', page: 'page-content' });
    await expect.poll(() => page.evaluate(() => document.documentElement.hasAttribute('data-route-transition'))).toBe(false);
    // Outside a route transition nothing is named (the theme reveal needs one snapshot).
    expect(await page.locator('[data-site-header]').evaluate((el) => getComputedStyle(el).viewTransitionName)).toBe('none');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Chores' }).click();
    await expect(page).toHaveURL(/\/chores$/);
    expect(await page.evaluate(() => (window as unknown as { __vt: unknown[] }).__vt.length)).toBe(1);
  });

  test('dashboard tiles and household members enter staggered, settled under reduced motion', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openDashboard(page);
    const grid = page.getByTestId('dashboard-grid');
    await expect(grid).toHaveAttribute('data-stagger', /entering|settled/);
    await expect(grid).toHaveAttribute('data-stagger', 'settled');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/household?tab=members');
    await expect(page.getByTestId('household-member-list')).toHaveAttribute('data-stagger', 'settled');
  });
});

test.describe('H04: the brief rewrites with AI on demand', () => {
  test('the sparkle rewrites the brief, marks it AI-written and goes back to the plain brief', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openDashboard(page);
    await expect(page.getByRole('button', { name: 'Generate Overview' })).toHaveCount(0);
    await expect(page.getByTestId('morning-brief')).toHaveAttribute('data-brief-source', 'plain');
    await page.getByRole('button', { name: 'Rewrite the brief with AI' }).click();
    await expect(page.getByTestId('brief-ai-marker')).toBeVisible();
    await expect(page.getByTestId('morning-brief')).toHaveAttribute('data-brief-source', 'ai');
    await expect(page.getByTestId('home-ai-overview-result').getByTestId('overview-metric-chores')).toBeVisible();
    await page.getByRole('button', { name: 'Show plain brief' }).click();
    await expect(page.getByTestId('morning-brief')).toHaveAttribute('data-brief-source', 'plain');
    await expect(page.getByTestId('home-ai-overview-result')).toHaveCount(0);
  });
});

test.describe('visual and a11y checks the verification could not settle', () => {
  test('a very long household name stays inside its stat card', async ({ page }) => {
    const original = (await household.get()).data()?.name as string;
    // The longest name allowed (HOUSEHOLD_NAME_MAX, 80) with no spaces, so only overflow-wrap can keep it inside.
    const longName = `TheExtraordinarilyLongHouseholdName${'Residence'.repeat(5)}`;
    expect(longName).toHaveLength(80);
    try {
      await household.update({ name: longName });
      await page.clock.setFixedTime(fixedNow);
      await page.goto('/household');
      const card = page.getByTestId('household-stat-household');
      await expect(card.getByText(longName, { exact: true })).toBeVisible();
      const geometry = await card.evaluate((el) => {
        const value = el.querySelector('[data-testid="household-stat-value"]') as HTMLElement;
        const box = el.getBoundingClientRect();
        const text = value.getBoundingClientRect();
        const next = el.nextElementSibling?.getBoundingClientRect();
        return {
          valueRight: text.right,
          cardRight: box.right,
          valueOverflow: value.scrollWidth - value.clientWidth,
          cardOverflow: el.scrollWidth - el.clientWidth,
          overlapsNext: next ? next.top < box.bottom && next.left < box.right && next.left >= box.left : false,
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      expect(geometry.valueRight).toBeLessThanOrEqual(geometry.cardRight + 0.5);
      expect(geometry.valueOverflow).toBeLessThanOrEqual(0);
      expect(geometry.cardOverflow).toBeLessThanOrEqual(0);
      expect(geometry.overlapsNext).toBe(false);
      expect(geometry.pageOverflow).toBeLessThanOrEqual(0);
    } finally {
      await household.update({ name: original });
    }
  });

  test('dialog and sheet close buttons have an accessible name', async ({ page }, testInfo) => {
    // Every close button the shared Dialog and Sheet render is named "Close" (its icon is hidden).
    const checkDialog = async () => {
      const dialog = page.getByRole('dialog').last();
      await expect(dialog).toBeVisible();
      const closes = dialog.locator('[data-dialog-close]');
      expect(await closes.count()).toBeGreaterThan(0);
      for (let index = 0; index < await closes.count(); index += 1) {
        await expect(closes.nth(index)).toHaveAccessibleName('Close');
      }
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    };

    await page.clock.setFixedTime(fixedNow);
    await page.goto('/household');
    await page.getByRole('tab', { name: 'Danger Zone' }).click();
    await page.getByRole('button', { name: 'Delete household' }).click();
    await checkDialog();

    await page.goto('/chores');
    await page.getByRole('button', { name: 'Add Chore' }).first().click();
    await checkDialog();

    if (testInfo.project.name === 'desktop-chromium') {
      await openDashboard(page);
      await page.keyboard.press('Shift+?');
      await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
      await checkDialog();
    } else {
      // The phone tab bar's More sheet.
      await openDashboard(page);
      await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: /More/ }).click();
      await checkDialog();
    }
  });
});
