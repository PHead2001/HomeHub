import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { fixedNow } from './test-helpers';

const mobileOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'mobile-chromium');
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');

async function open(page: Page, path: string, heading: string) {
  await page.clock.setFixedTime(fixedNow);
  await page.goto(path);
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
}

async function documentOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe('navigation and layout regressions', () => {
  test('B6: every module is one tap away on a phone', async ({ page }, testInfo) => {
    mobileOnly(testInfo);
    await open(page, '/', 'Welcome Home');
    const tabs = page.getByRole('navigation', { name: 'Primary' });
    await expect(tabs).toBeVisible();

    await tabs.getByRole('link', { name: 'Chores' }).click();
    await expect(page).toHaveURL(/\/chores\/?$/);
    await expect(tabs.getByRole('link', { name: 'Chores' })).toHaveAttribute('aria-current', 'page');

    await tabs.getByRole('button', { name: 'More' }).click();
    const sheet = page.getByRole('dialog', { name: 'More' });
    for (const label of ['Maintenance', 'Automation', 'Household', 'Barcode Library', 'Profile']) {
      await expect(sheet.getByRole('link', { name: label })).toBeVisible();
    }
    await sheet.getByRole('link', { name: 'Maintenance' }).click();
    await expect(page).toHaveURL(/\/maintenance\/?$/);
    await expect(sheet).toHaveCount(0);
    await expect(tabs.getByRole('button', { name: 'More' })).toHaveAttribute('aria-current', 'page');

    // The bar never covers the end of the page once it has settled (the page-enter
    // transition moves content by a few pixels while it runs).
    await expect.poll(async () => {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const barTop = await tabs.evaluate((el) => el.getBoundingClientRect().top);
      const mainBottom = await page.locator('main').evaluate((el) => {
        const last = el.lastElementChild?.getBoundingClientRect();
        return last ? last.bottom : 0;
      });
      return mainBottom - barTop;
    }).toBeLessThanOrEqual(1);
  });

  test('B6: the tab bar is hidden on desktop', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/', 'Welcome Home');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeHidden();
  });

  test('B7: Home Assets cards hug their content and the page never scrolls sideways', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await page.setViewportSize({ width: 1009, height: 900 });
    await open(page, '/maintenance', 'Maintenance Center');
    await page.getByRole('tab', { name: 'Home Assets' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Home Assets' });
    await expect(panel.getByText('Main HVAC System').first()).toBeVisible();
    const card = panel.getByRole('button', { name: /Main HVAC System/ }).first();
    const height = await card.evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeLessThan(250);
    expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('MA-17/MA-18: every Maintenance tab fits the tablet, WT-25 and desktop sizes; the detail column bottom is reachable', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    test.setTimeout(180_000);
    const sizes = [
      [1263, 818], [1263, 722], [1264, 843], [1024, 768], [1180, 820], [1200, 800], [1280, 800], [1340, 800],
      [1366, 1024], [1024, 600], [1440, 900], [390, 844],
    ] as const;
    await open(page, '/maintenance', 'Maintenance Center');
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      for (const tab of ['overview', 'assets', 'vehicles', 'reminders', 'logs'] as const) {
        await page.goto(tab === 'overview' ? '/maintenance' : `/maintenance?tab=${tab}`);
        await expect(page.getByRole('heading', { name: 'Maintenance Center', exact: true })).toBeVisible();
        await expect(page.getByText(/Main HVAC System|Family SUV|Engine oil and filter/).first()).toBeVisible();
        expect(await documentOverflow(page), `${tab} at ${width}x${height}: no sideways scroll`).toBeLessThanOrEqual(0);
        // The tab row is one row at every size.
        const tops = await page.locator('[data-maintenance-tabs] [role="tab"]').evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top)));
        expect(new Set(tops).size, `${tab} at ${width}x${height}: one tab row`).toBe(1);
        if ((tab === 'assets' || tab === 'vehicles') && width >= 1024) {
          // The sticky detail column scrolls on its own: its last control can be brought into view.
          const detail = page.getByTestId(tab === 'assets' ? 'asset-detail' : 'vehicle-detail');
          await expect(detail).toBeVisible();
          // Scroll the page to its real end: the page can still grow while it settles (late images, counts), so
          // scroll again until the bottom is reached.
          for (let i = 0; i < 10; i++) {
            const atEnd = await page.evaluate(() => {
              window.scrollTo(0, document.documentElement.scrollHeight);
              return Math.ceil(scrollY + innerHeight) >= document.documentElement.scrollHeight - 1;
            });
            await page.waitForTimeout(150);
            if (atEnd && await page.evaluate(() => Math.ceil(scrollY + innerHeight) >= document.documentElement.scrollHeight - 1)) break;
          }
          // Reachable means: at the page's end the scrolling column is wholly on screen, and its own
          // content scrolls to its last line inside it (measured together, after any re-render).
          const reach = await detail.evaluate((element) => {
            const column = element.parentElement!;
            column.scrollTop = column.scrollHeight;
            const box = column.getBoundingClientRect();
            return {
              columnBottom: Math.round(box.bottom),
              contentEnd: Math.round(element.getBoundingClientRect().bottom),
              docH: document.documentElement.scrollHeight, scrollY: Math.round(scrollY), colTop: Math.round(box.top), colH: Math.round(box.height),
            };
          });
          expect(reach.columnBottom, `${tab} at ${width}x${height}: the detail column is wholly on screen ${JSON.stringify(reach)}`).toBeLessThanOrEqual(height + 1);
          expect(reach.contentEnd, `${tab} at ${width}x${height}: the detail scrolls to its end inside the column ${JSON.stringify(reach)}`).toBeLessThanOrEqual(reach.columnBottom + 1);
        }
      }
    }
  });

  test('L10: unknown paths, including dotted probe paths, answer 404 with the not-found page', async ({ page }) => {
    for (const path of ['/this-page-does-not-exist', '/.env.save', '/.aws/config']) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
      const notFound = page.getByTestId('not-found');
      await expect(notFound.getByRole('heading', { name: "We couldn't find that page" })).toBeVisible();
      await expect(notFound.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/');
    }
    await page.getByTestId('not-found').getByRole('link', { name: 'Go home' }).click();
    await expect(page).toHaveURL(/\/$/);
  });
});

test.describe('app shell, audit section 11', () => {
  test('SL-6: Sign out in the account menu asks first, and Stay signed in keeps the session', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/', 'Welcome Home');
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByTestId('header-sign-out').click();
    const confirm = page.getByRole('alertdialog', { name: 'Sign out on this device?' });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await confirm.getByRole('button', { name: 'Stay signed in' }).click();
    await expect(confirm).toHaveCount(0);
    // The page still takes clicks after the dialog (opened from a menu item) closed.
    await page.getByTestId('header-search').click();
    const palette = page.getByRole('dialog', { name: 'Search or quick add' });
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    // Still signed in: the header keeps its signed-in controls after a reload.
    await page.reload();
    await expect(page.getByTestId('header-search')).toBeVisible();
  });
});
