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

test.describe('household tabs and invites', () => {
  test('B8: ?tab= opens that tab directly and choosing a tab updates the URL', async ({ page }) => {
    await openHousehold(page, 'members');
    await expect(page.getByRole('tab', { name: /^Members/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('region', { name: 'Approve Jamie?' })).toBeVisible();

    await openHousehold(page, 'roles');
    await expect(page.getByRole('tab', { name: 'Roles' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'false');

    // Choosing a tab replaces the URL (Overview has no parameter) and survives a reload.
    await page.getByRole('tab', { name: 'Danger Zone' }).click();
    await expect(page).toHaveURL(/\/household\?tab=danger$/);
    await page.getByRole('tab', { name: 'Overview' }).click();
    await expect(page).toHaveURL(/\/household$/);
    await page.getByRole('tab', { name: /^Members/ }).click();
    await expect(page).toHaveURL(/\/household\?tab=members$/);
    await page.reload();
    await expect(page.getByRole('tab', { name: /^Members/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('region', { name: 'Approve Jamie?' })).toBeVisible();
  });

  test('B3: a blocked clipboard still reports the invite as created and shows its code', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    // Both copy paths fail, as on iOS after an await: the Clipboard API rejects and
    // the legacy execCommand fallback copies nothing.
    await page.addInitScript(() => {
      const w = window as unknown as { __clipboardWrites: number };
      w.__clipboardWrites = 0;
      Object.defineProperty(Navigator.prototype, 'clipboard', {
        configurable: true,
        get: () => ({
          writeText: () => {
            w.__clipboardWrites += 1;
            return Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
          },
        }),
      });
      Document.prototype.execCommand = () => false;
    });
    const invites = getFirestore(adminApp).collection('inviteCodes');
    const before = new Set((await invites.where('householdId', '==', 'the-foxy-residence-e2e').get()).docs.map((d) => d.id));
    try {
      // No pinned clock here: the rules compare the invite's expiry with the server's time.
      await page.goto('/household?tab=invites');
      await expect(page.getByRole('tab', { name: 'Invite Codes' })).toHaveAttribute('aria-selected', 'true');
      // Enabled only once the household and permissions have loaded (never a silent no-op).
      const create = page.getByRole('button', { name: 'Create invite code', exact: true });
      await expect(create).toBeEnabled();
      await create.click();

      const toasts = page.getByRole('region', { name: /notification/i });
      await expect(toasts.getByText('Invite code ready', { exact: true })).toBeVisible();
      const description = toasts.getByText(/^Share [A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{2} within 30 minutes\. It is also listed below\.$/);
      await expect(description).toBeVisible();
      expect(await page.evaluate(() => (window as unknown as { __clipboardWrites: number }).__clipboardWrites)).toBeGreaterThan(0);
      await expect(toasts.getByText('Could not create an invite code')).toHaveCount(0);

      // The code in the toast is the one that was created and is listed on the tab.
      const code = (await description.textContent())!.match(/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{2}/)![0];
      await expect(page.getByRole('tabpanel').getByText(code, { exact: true })).toBeVisible();
      await expect.poll(async () => (await invites.doc(code).get()).exists).toBe(true);
    } finally {
      const after = await invites.where('householdId', '==', 'the-foxy-residence-e2e').get();
      await Promise.all(after.docs.filter((d) => !before.has(d.id)).map((d) => d.ref.delete()));
    }
  });
});

test.describe('View household unticked (HO-2a)', () => {
  test('a member without household.view sees no Household Manager data and no error', async ({ browser }) => {
    // The seeded guest, granted the manager permissions but with View household
    // unticked: the rules deny invite codes, the activity log and contact documents,
    // and the page must not open a listener for them.
    const limited = household.collection('members').doc('e2e-limited-uid');
    const original = (await limited.get()).data()?.permissions ?? {};
    await limited.update({
      permissions: {
        ...original,
        'household.view': false,
        'household.manageInvites': true,
        'household.manageMembers': true,
      },
    });
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:9002', colorScheme: 'dark' });
    try {
      const page = await context.newPage();
      const problems: string[] = [];
      page.on('console', (message) => {
        if (['error', 'warning'].includes(message.type()) && /permission|insufficient|invite|audit/i.test(message.text())) {
          problems.push(message.text());
        }
      });
      page.on('pageerror', (error) => problems.push(error.message));
      await page.clock.setFixedTime(fixedNow);
      await page.goto('/e2e-login?uid=e2e-limited-uid');
      await expect(page).toHaveURL('/');

      await page.goto('/household?tab=invites');
      await expect(page.getByText('Household settings are not available to you')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Manage Household', exact: true })).toHaveCount(0);
      await expect(page.getByRole('tab')).toHaveCount(0);
      await expect(page.getByText(/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{2}/)).toHaveCount(0);
      await expect(page.getByText('@example.test')).toHaveCount(0);
      await expect(page.getByRole('region', { name: /notification/i }).getByText(/couldn.t|failed|error/i)).toHaveCount(0);
      // Give any listener time to fail before checking the console.
      await page.waitForTimeout(1500);
      expect(problems).toEqual([]);
    } finally {
      await context.close();
      await limited.update({ permissions: original });
    }
  });
});
