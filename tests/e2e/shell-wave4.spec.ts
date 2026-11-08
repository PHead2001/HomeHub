import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { resolve } from 'node:path';
import { build } from 'esbuild';
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

/**
 * NumberTicker inside labels: one real text node with the final value at every
 * moment, so textContent, innerText and the accessible name are exact, both while
 * the digits count and after. Rendered from the real component (bundled with
 * esbuild) with page.setContent, so no app data is involved.
 */
async function tickerHarness() {
  const result = await build({
    entryPoints: [resolve('tests/e2e/fixtures/number-ticker-harness.tsx')],
    bundle: true,
    write: false,
    outdir: 'out',
    format: 'iife',
    jsx: 'automatic',
    tsconfig: resolve('tsconfig.json'),
    loader: { '.module.css': 'local-css' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
    plugins: [{
      // The harness has no AppearanceProvider; reduced motion falls back to the media query.
      name: 'appearance-stub',
      setup(builder) {
        builder.onResolve({ filter: /appearance-provider$/ }, () => ({ path: 'appearance-stub', namespace: 'stub' }));
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const useOptionalAppearance = () => null;', loader: 'js' }));
      },
    }],
  });
  const js = result.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
  const css = result.outputFiles.find((file) => file.path.endsWith('.css'))?.text ?? '';
  return `<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
}

test.describe('H12: NumberTicker keeps labels exact', () => {
  test('text and accessible names read the final value while counting and after', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const html = await tickerHarness();
    const read = (selector: string) => page.locator(selector).evaluate((element) => ({
      text: element.textContent,
      inner: (element as HTMLElement).innerText,
      counting: element.querySelector('[data-counting]') !== null,
    }));

    await page.setContent(html);
    const todo = page.getByRole('button', { name: 'To Do (1)', exact: true });
    await expect(todo).toBeVisible();
    // Mid-animation: the button's ticker counts up from 0 on mount.
    const during = await read('#todo');
    expect(during.counting, 'still counting when first read').toBe(true);
    expect(during).toMatchObject({ text: 'To Do (1)', inner: 'To Do (1)' });
    await expect(page.getByRole('button', { name: 'Future (1)', exact: true })).toBeVisible();
    expect(await read('#pets')).toMatchObject({ text: '1 of 2 today', inner: '1 of 2 today' });

    // After the animation.
    await expect.poll(async () => (await read('#todo')).counting).toBe(false);
    expect(await read('#todo')).toMatchObject({ text: 'To Do (1)', inner: 'To Do (1)', counting: false });

    // A change ticks; the label already says the new value while it counts.
    await page.evaluate(() => window.__setCount?.(5));
    const changing = await read('#future');
    expect(changing).toMatchObject({ text: 'Future (5)', inner: 'Future (5)', counting: true });
    await expect(page.getByRole('button', { name: 'Future (5)', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'To Do (5)', exact: true })).toBeVisible();
    expect(await read('#big')).toMatchObject({ text: '5,000 points', inner: '5,000 points' });

    // No width change while counting (the drawn digits add no width).
    await page.evaluate(() => window.__setCount?.(1));
    await expect.poll(async () => (await read('#todo')).counting).toBe(false);
    const rest = await page.locator('#todo').evaluate((element) => element.getBoundingClientRect().width);
    await page.evaluate(() => window.__setCount?.(9));
    await expect.poll(async () => (await read('#todo')).counting).toBe(false);
    const after = await page.locator('#todo').evaluate((element) => element.getBoundingClientRect().width);
    await page.evaluate(() => window.__setCount?.(1));
    await page.evaluate(() => window.__setCount?.(9));
    const mid = await page.locator('#todo').evaluate((element) => ({ width: element.getBoundingClientRect().width, counting: element.querySelector('[data-counting]') !== null }));
    expect(mid.counting).toBe(true);
    expect(Math.abs(mid.width - after)).toBeLessThan(0.5);
    expect(Math.abs(rest - after)).toBeLessThan(0.5);
  });

  test('reduced motion shows the final value at once', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setContent(await tickerHarness());
    await expect(page.getByRole('button', { name: 'To Do (1)', exact: true })).toBeVisible();
    expect(await page.locator('[data-counting]').count()).toBe(0);
  });
});

test.describe('H12: entrances never move a click target', () => {
  const box = (page: import('@playwright/test').Page, testId: string) => page.getByTestId(testId).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const transforms = [element, element.parentElement, element.closest('[role="tabpanel"]')]
      .filter((node): node is Element => Boolean(node))
      .map((node) => getComputedStyle(node).transform);
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, transforms };
  });

  test('staggered rows keep their box from the first frame of the entrance to the end', async ({ page }) => {
    await page.setContent(await tickerHarness());
    const list = page.getByTestId('stagger-list');
    await expect(list).toHaveAttribute('data-stagger', 'entering');
    // Row 11 is mid-entrance (330 ms delay, 220 ms fade) when first measured.
    const first = await box(page, 'row-11');
    const opacity = await page.getByTestId('row-11').evaluate((element) => Number(getComputedStyle(element.parentElement!).opacity));
    expect(opacity, 'still entering when measured').toBeLessThan(1);
    expect(first.transforms.every((value) => value === 'none')).toBe(true);
    await expect(list).toHaveAttribute('data-stagger', 'settled');
    const last = await box(page, 'row-11');
    expect(last).toEqual(first);
  });

  test('a tab panel fades in without moving its buttons', async ({ page }) => {
    await page.setContent(await tickerHarness());
    await page.getByRole('tab', { name: 'Two' }).click();
    const panel = page.getByRole('tabpanel');
    await expect(panel).toHaveAttribute('data-tab-enter', '');
    const during = await box(page, 'panel-two-button');
    expect(during.transforms.every((value) => value === 'none')).toBe(true);
    await page.waitForTimeout(250);
    expect(await box(page, 'panel-two-button')).toEqual(during);
  });
});
