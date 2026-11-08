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
