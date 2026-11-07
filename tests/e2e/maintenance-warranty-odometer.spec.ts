import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { fixedNow } from './test-helpers';

// H10: each asset's warranty shows a countdown ring (days left of the term) and
// vehicle mileage rolls like an odometer. Read-only against the seeded household:
// Main HVAC System (bought 2022-05-12, warranty to 2026-08-10) and the Family SUV
// at 48,750 miles; the clock is fixed at 2026-08-01.
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');

async function open(page: Page, path: string) {
  await page.clock.setFixedTime(fixedNow);
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Maintenance Center', exact: true })).toBeVisible();
}

test.describe('maintenance: warranty ring and odometer (H10)', () => {
  test('asset cards show a warranty countdown ring', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/maintenance?tab=assets');
    const hvac = page.getByTestId('asset-card-hvac-main');
    const ring = hvac.getByTestId('warranty-ring');
    await expect(ring).toHaveAttribute('data-days-left', '9');
    await expect(ring).toHaveAttribute('data-term-days', '1551');
    await expect(hvac.getByRole('img', { name: 'Main HVAC System: Warranty: 9 days left of 1,551' })).toBeVisible();
    await expect(ring).toContainText('9d');
    // An asset without a warranty end date has no ring.
    await expect(page.getByTestId('asset-card-dishwasher').getByTestId('warranty-ring')).toHaveCount(0);
  });

  test('vehicle mileage rolls like an odometer with a plain text value', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/maintenance?tab=vehicles');
    const odometer = page.getByTestId('odometer').first();
    await expect(odometer).toHaveAttribute('data-value', '48750');
    await expect(odometer).toContainText('48,750 miles');
    const wheels = odometer.locator('[data-digit]');
    await expect(wheels).toHaveCount(6);
    expect(await wheels.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-digit')).join(''))).toBe('048750');
    // Each wheel settles on its digit (the strip's visible row).
    await expect.poll(async () => wheels.evaluateAll((nodes) => nodes.map((node) => {
      const wheel = node.getBoundingClientRect();
      const row = [...node.querySelectorAll(':scope > span > span')].find((digit) => {
        const box = digit.getBoundingClientRect();
        return Math.abs(box.top - wheel.top) < 1;
      });
      return row?.textContent ?? '?';
    }).join(''))).toBe('048750');
    // The vehicle card's accessible name carries the value.
    await expect(page.getByRole('button', { name: /Family SUV.*48,750 miles/ })).toBeVisible();
  });

  test('under reduced motion the odometer shows its final digits at once', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const context = await browser.newContext({
      baseURL: 'http://127.0.0.1:9002', colorScheme: 'dark', reducedMotion: 'reduce', storageState: 'playwright/.auth/e2e-owner.json',
    });
    const page = await context.newPage();
    try {
      await open(page, '/maintenance?tab=vehicles');
      const strip = page.getByTestId('odometer').first().locator('[data-digit="7"] > span');
      await expect(strip).toBeVisible();
      expect(await strip.evaluate((el) => el.style.transform)).toContain('-70%');
    } finally {
      await context.close();
    }
  });
});
