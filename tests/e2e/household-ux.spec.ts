import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';

const adminApp = getApps().find((app) => app.name === 'household-ux')
  || initializeApp({ projectId: 'demo-homehub-e2e' }, 'household-ux');
const household = getFirestore(adminApp).collection('households').doc('the-foxy-residence-e2e');

const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');
const mobileOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'mobile-chromium');

async function openHousehold(page: Page, tab?: string) {
  await page.clock.setFixedTime(fixedNow);
  await page.goto(tab ? `/household?tab=${tab}` : '/household');
  await expect(page.getByRole('heading', { name: 'Manage Household', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible();
}

test.describe('household governance UX', () => {
  test('overview is live: no Refresh button and the household ID is not an input', async ({ page }) => {
    await openHousehold(page);
    await expect(page.getByRole('button', { name: /refresh/i })).toHaveCount(0);
    await expect(page.locator('input[value="the-foxy-residence-e2e"]')).toHaveCount(0);
    await expect(page.getByText('the-foxy-residence-e2e', { exact: true })).toBeVisible();

    // A rename from elsewhere shows up without reloading.
    const original = (await household.get()).data()?.name as string;
    try {
      await household.update({ name: 'The Foxy Residence E2E (live)' });
      await expect(page.getByText('The Foxy Residence E2E (live)', { exact: true }).first()).toBeVisible();
    } finally {
      await household.update({ name: original });
    }
  });

  test('an empty household name is explained inline, not in a toast', async ({ page }) => {
    await openHousehold(page);
    const field = page.getByLabel('Display name');
    await field.fill('   ');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Give your household a name.')).toBeVisible();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('region', { name: /notification/i }).getByText('Give your household a name.')).toHaveCount(0);
  });

  test('a long household name wraps inside its stat card', async ({ page }) => {
    const original = (await household.get()).data()?.name as string;
    const longName = 'The Auditors Big Test Residence With An Extremely Long Name That Goes On And On';
    try {
      await household.update({ name: longName });
      await openHousehold(page);
      const value = page.getByText(longName, { exact: true }).first();
      await expect(value).toBeVisible();
      const overflow = await value.evaluate((el) => {
        const card = el.closest('[class*="rounded"]') as HTMLElement;
        return card.scrollWidth - card.clientWidth;
      });
      expect(overflow).toBeLessThanOrEqual(0);
    } finally {
      await household.update({ name: original });
    }
  });

  test('phone stat cards form a 2×2 grid', async ({ page }, testInfo) => {
    mobileOnly(testInfo);
    await openHousehold(page);
    const tops = await page.getByRole('tabpanel').getByText(/^(Household|Members|Your role|Active invites)$/).evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().top)));
    expect(tops).toHaveLength(4);
    expect(tops[0]).toBe(tops[1]);
    expect(tops[2]).toBe(tops[3]);
    expect(tops[2]).toBeGreaterThan(tops[0]);
  });

  test('members are cards; a pending member is an approval banner', async ({ page }) => {
    await openHousehold(page, 'members');
    const banner = page.getByRole('region', { name: 'Approve Jamie?' });
    await expect(banner).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Approve' })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Deny' })).toBeVisible();
    await expect(page.getByText('newuser', { exact: false })).toHaveCount(0);

    // Deny asks first and Cancel keeps the request.
    await banner.getByRole('button', { name: 'Deny' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Deny Jamie Pending?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(banner).toBeVisible();

    // Rare actions are in a menu; the owner's own card has none.
    await expect(page.getByRole('button', { name: 'Actions for Alex E2E' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Actions for Sam Member' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitemradio', { name: 'Member' })).toHaveAttribute('aria-checked', 'true');
    await expect(menu.getByRole('menuitem', { name: 'Customize permissions' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Make owner' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Remove from household' })).toBeVisible();

    // Customize opens the living matrix for that member.
    await menu.getByRole('menuitem', { name: 'Customize permissions' }).click();
    await expect(page.getByRole('tab', { name: 'Roles' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('checkbox', { name: 'Delete shopping for Sam Member' })).toBeVisible();
  });

  test('the permission matrix toggles from the keyboard and discards cleanly', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openHousehold(page, 'roles');
    const matrix = page.locator('[data-permission-matrix]');
    await expect(matrix.getByRole('columnheader', { name: 'Owner' })).toBeVisible();
    await expect(matrix.getByRole('columnheader', { name: 'Guest' })).toBeVisible();

    await page.getByLabel('Show').click();
    await page.getByRole('option', { name: 'Sam Member (Member)' }).click();
    // The Select hands focus back to its trigger as it closes; wait for that, or the
    // Space below can land on the trigger and reopen the list.
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(page.getByLabel('Show')).toBeFocused();
    const cell = page.getByRole('checkbox', { name: 'Delete shopping for Sam Member' });
    await expect(cell).toHaveAttribute('aria-checked', 'false');
    await cell.focus();
    await expect(cell).toBeFocused();
    await page.keyboard.press('Space');
    await expect(cell).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('1 unsaved change.')).toBeVisible();
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(cell).toHaveAttribute('aria-checked', 'false');

    // Owner-only permissions are locked for everyone else.
    await expect(page.getByRole('checkbox', { name: 'Delete household for Sam Member' })).toHaveCount(0);
  });
});

test.describe('profile and automation', () => {
  test('profile shows the current avatar', async ({ page }) => {
    await page.clock.setFixedTime(fixedNow);
    await page.goto('/profile');
    await expect(page.getByRole('heading', { name: 'Your Profile', exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Alex E2E' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^(Add|Change) photo$/ })).toBeVisible();
    // The Appearance card stays in the settings column.
    await expect(page.getByText('Appearance', { exact: true })).toBeVisible();
  });

  test('automation explains it is read-only and offers the connect form to the owner', async ({ page }) => {
    await page.clock.setFixedTime(fixedNow);
    await page.goto('/automation');
    await expect(page.getByText(/never switches anything/)).toBeVisible();
    await expect(page.getByText('Connect Home Assistant')).toBeVisible();
    await expect(page.getByPlaceholder('https://your-home.ui.nabu.casa')).toBeVisible();
  });
});
