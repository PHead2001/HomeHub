import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';

const projectId = 'demo-homehub-e2e';
const householdA = 'the-foxy-residence-e2e';
const householdB = 'the-otter-residence-e2e';
const adminApp = getApps().find(app => app.name === 'ai-hardening-e2e')
  || initializeApp({ projectId }, 'ai-hardening-e2e');
const adminDb = getFirestore(adminApp);

async function emulatorIdToken(request: APIRequestContext, uid: string) {
  const tokenResponse = await request.post('/api/e2e/auth-token', { data: { uid } });
  expect(tokenResponse.ok()).toBe(true);
  const { token } = await tokenResponse.json() as { token: string };
  const exchange = await request.post('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key', {
    data: { token, returnSecureToken: true },
  });
  expect(exchange.ok()).toBe(true);
  return (await exchange.json() as { idToken: string }).idToken;
}

async function probe(request: APIRequestContext, idToken: string, body: Record<string, unknown>) {
  const response = await request.post('/api/e2e/household-probe', {
    headers: { Authorization: `Bearer ${idToken}` },
    data: body,
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function openAuthenticated(page: Page, path = '/') {
  await page.clock.setFixedTime(fixedNow);
  await page.goto(path);
  await expect(page.getByText('Sign in with Google', { exact: false })).toHaveCount(0);
}

test.describe('AI isolation, overview, and barcode hardening', () => {
  test('overview stays within 360, 390, and 412 pixel viewports', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'One Chromium project covers the explicit width matrix.');
    await page.setViewportSize({ width: 360, height: 900 });
    await openAuthenticated(page);
    await page.getByRole('button', { name: 'Generate Overview' }).click();
    await expect(page.getByTestId('home-ai-overview-result')).toBeVisible();

    for (const width of [360, 390, 412]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByRole('button', { name: 'Regenerate Overview' })).toBeVisible();
      const bounds = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(bounds.scrollWidth, `${width}px viewport overflow`).toBeLessThanOrEqual(bounds.clientWidth);
    }
  });

  test('server actions reject altered Household B context before data or fallback access', async ({ request }) => {
    const ownerToken = await emulatorIdToken(request, 'e2e-owner-uid');
    for (const operation of ['overview', 'categorize', 'recipe', 'maintenance', 'barcode']) {
      const result = await probe(request, ownerToken, {
        operation,
        householdId: householdB,
        barcode: '012345678905',
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      expect(JSON.stringify(result)).not.toContain('HOUSEHOLD-B-PRIVATE');
    }

    const householdResult = await probe(request, ownerToken, {
      operation: 'barcode',
      householdId: householdA,
      barcode: '012345678905',
    });
    expect(householdResult).toMatchObject({
      ok: true,
      data: { source: 'household', productName: 'E2E Oat Cereal' },
    });
  });

  test('legacy authority remains member-level and barcode fixtures map only supported quantities', async ({ request }) => {
    const legacyToken = await emulatorIdToken(request, 'e2e-legacy-uid');
    const legacyOverview = await probe(request, legacyToken, { operation: 'overview', householdId: householdA });
    expect(legacyOverview.ok).toBe(true);
    expect(legacyOverview.data.facts.household).toBeUndefined();

    const ownerToken = await emulatorIdToken(request, 'e2e-owner-uid');
    const cases = [
      ['008500001280', { source: 'open_food_facts', productName: 'E2E Family Juice', quantity: 128, unit: 'fl oz' }],
      ['009900045000', { source: 'open_food_facts', productName: 'E2E Yogurt Multipack', quantity: 450, unit: 'g' }],
      ['007700000006', { source: 'open_food_facts', productName: 'E2E Odd Measure' }],
      ['000000000404', { source: 'none', productName: null }],
    ] as const;
    for (const [barcode, expected] of cases) {
      const result = await probe(request, ownerToken, { operation: 'barcode', householdId: householdA, barcode });
      expect(result).toMatchObject({ ok: true, data: expected });
      if (barcode === '007700000006') {
        expect(result.data.quantity).toBeUndefined();
        expect(result.data.unit).toBeUndefined();
      }
    }
  });

  test('overview is on-demand, exact, transient, and useful through deterministic provider failures', async ({ page }, testInfo) => {
    const choreRef = adminDb.collection('households').doc(householdA).collection('chores').doc('chore-kitchen');
    await openAuthenticated(page);
    await expect(page.getByRole('button', { name: 'Generate Overview' })).toBeVisible();
    await expect(page.getByTestId('home-ai-overview-result')).toHaveCount(0);

    await page.getByRole('button', { name: 'Generate Overview' }).click();
    await expect(page.getByRole('button', { name: 'Generating...' })).toBeDisabled();
    const result = page.getByTestId('home-ai-overview-result');
    await expect(result).toBeVisible();
    const exactSeededMetrics = {
      chores: ['Your open chores', '1', '0 overdue'],
      shopping: ['Needed items', '3', '2 lists'],
      pantry: ['Expiring soon', '1', '0 expired'],
      maintenance: ['Maintenance due', '6', '0 overdue'],
      pets: ['Pets', '2', '3 recent care logs'],
      notifications: ['Unread notices', '2'],
      household: ['Pending members', '1', '4 active'],
      barcode: ['Saved products', '1'],
    };
    for (const [section, expected] of Object.entries(exactSeededMetrics)) {
      const metric = result.getByTestId(`overview-metric-${section}`);
      const expectedText = testInfo.project.name === 'desktop-chromium' ? expected : expected.slice(0, 1);
      for (const text of expectedText) {
        await expect(metric.getByText(text, { exact: true })).toBeVisible();
      }
    }
    await expect(page.getByRole('button', { name: 'Regenerate Overview' })).toBeVisible();

    for (const [scenario, message] of [
      ['rate-limit', 'rate limited'],
      ['timeout', 'took too long'],
      ['malformed', 'could not be validated'],
      ['provider-error', 'temporarily unavailable'],
    ] as const) {
      await choreRef.update({ task: `AI-TEST:${scenario} Reset the kitchen` });
      await page.getByRole('button', { name: 'Regenerate Overview' }).click();
      await expect(result.getByText(new RegExp(message, 'i'))).toBeVisible();
      await expect(result.getByText('Your open chores')).toBeVisible();
    }
    await choreRef.update({ task: 'Reset the kitchen' });

    await page.reload();
    await expect(page.getByTestId('home-ai-overview-result')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Generate Overview' })).toBeVisible();
  });

  test('limited user sees only authorized overview sections', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:9002', colorScheme: 'dark' });
    const page = await context.newPage();
    await page.clock.setFixedTime(fixedNow);
    await page.goto('/e2e-login?uid=e2e-limited-uid');
    await expect(page).toHaveURL('/');
    await page.getByRole('button', { name: 'Generate Overview' }).click();
    const result = page.getByTestId('home-ai-overview-result');
    await expect(result.getByText('Pets', { exact: true })).toBeVisible();
    await expect(result.getByText('Needed items')).toHaveCount(0);
    await expect(result.getByText('Unread notices')).toHaveCount(0);
    await expect(result.getByText('Pending members')).toHaveCount(0);
    await context.close();
  });

  test('pantry barcode fallback prefills supported quantity and leaves unsupported values editable', async ({ page }) => {
    await openAuthenticated(page, '/shopping');
    await page.getByRole('tab', { name: 'Inventory' }).click();
    await page.getByRole('button', { name: 'Add Item' }).click();
    let itemDialog = page.getByRole('dialog', { name: 'Add New Item' });
    await itemDialog.getByRole('button', { name: 'Scan Barcode' }).click();
    let scanner = page.getByRole('dialog', { name: 'Scan Barcode' });
    await scanner.getByLabel('Barcode number').fill('008500001280');
    await scanner.getByRole('button', { name: 'Use barcode' }).click();
    await expect(itemDialog.getByLabel('Item Name')).toHaveValue('E2E Family Juice');
    await expect(itemDialog.getByRole('spinbutton', { name: 'Quantity' })).toHaveValue('128');
    await expect(itemDialog.getByRole('combobox', { name: 'Unit' })).toHaveText(/fl oz/i);
    await itemDialog.getByRole('spinbutton', { name: 'Quantity' }).fill('64');
    await expect(itemDialog.getByRole('spinbutton', { name: 'Quantity' })).toHaveValue('64');
    await itemDialog.getByRole('button', { name: 'Close' }).click();
    await expect(itemDialog).toBeHidden();

    await page.getByRole('button', { name: 'Add Item' }).click();
    itemDialog = page.getByRole('dialog', { name: 'Add New Item' });
    await itemDialog.getByRole('button', { name: 'Scan Barcode' }).click();
    scanner = page.getByRole('dialog', { name: 'Scan Barcode' });
    await scanner.getByLabel('Barcode number').fill('007700000006');
    await scanner.getByRole('button', { name: 'Use barcode' }).click();
    await expect(itemDialog.getByLabel('Item Name')).toHaveValue('E2E Odd Measure');
    await expect(itemDialog.getByRole('spinbutton', { name: 'Quantity' })).toHaveValue('1');
    await expect(itemDialog.getByRole('combobox', { name: 'Unit' })).toHaveText(/items/i);
  });
});
