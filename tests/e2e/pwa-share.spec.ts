import { expect, test } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';

const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const adminApp = getApps().find((app) => app.name === 'pwa-share-e2e')
  || initializeApp({ projectId }, 'pwa-share-e2e');
const groceryItems = getFirestore(adminApp)
  .collection('households').doc(householdId)
  .collection('shopping-lists').doc('weekly-groceries')
  .collection('items');

async function deleteItemsNamed(name: string) {
  const snapshot = await groceryItems.where('name', '==', name).get();
  await Promise.all(snapshot.docs.map((document) => document.ref.delete()));
}

const sharePath = (title: string, url: string) =>
  `/share?${new URLSearchParams({ title, text: `${title} ${url}`, url }).toString()}`;

test.describe('installable app manifest', () => {
  test('manifest declares icons, shortcuts and the share target', async ({ request }) => {
    const response = await request.get('/manifest.webmanifest');
    expect(response.ok()).toBe(true);
    const manifest = await response.json();

    expect(manifest).toMatchObject({
      name: 'HomeHub',
      short_name: 'HomeHub',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      share_target: {
        action: '/share',
        method: 'GET',
        params: { title: 'title', text: 'text', url: 'url' },
      },
    });
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);

    const icons = manifest.icons as { src: string; sizes: string; purpose?: string }[];
    expect(icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: '/icons/icon-192.png', sizes: '192x192' }),
      expect.objectContaining({ src: '/icons/icon-512.png', sizes: '512x512' }),
      expect.objectContaining({ src: '/icons/maskable-512.png', sizes: '512x512', purpose: 'maskable' }),
    ]));
    for (const icon of icons) {
      const iconResponse = await request.get(icon.src);
      expect(iconResponse.ok(), `${icon.src} should be served`).toBe(true);
    }

    const shortcuts = manifest.shortcuts as { name: string; url: string }[];
    expect(shortcuts.map(({ name, url }) => ({ name, url }))).toEqual([
      { name: 'Add to shopping', url: '/shopping?quickAdd=1' },
      { name: 'Log feeding', url: '/pets' },
      { name: 'My chores', url: '/chores' },
    ]);
  });
});

test.describe('share target signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('asks the visitor to sign in and offers no save action', async ({ page }) => {
    await page.goto(sharePath('E2E shared signed-out item', 'https://example.com/signed-out'));
    await expect(page.getByRole('heading', { name: 'Add to a shopping list', exact: true })).toBeVisible();
    await expect(page.getByText('Sign in to save this', { exact: true })).toBeVisible();
    await expect(page.getByText('E2E shared signed-out item', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add to list' })).toHaveCount(0);
  });
});

test.describe('share target signed in', () => {
  test('writes nothing until the member picks a list and confirms', async ({ page }, testInfo) => {
    const itemName = `E2E shared oat milk ${testInfo.project.name}`;
    const sourceUrl = 'https://example.com/oat-milk';
    await deleteItemsNamed(itemName);

    try {
      await page.clock.setFixedTime(fixedNow);
      await page.goto(sharePath(itemName, sourceUrl));
      await expect(page.getByRole('heading', { name: 'Add to a shopping list', exact: true })).toBeVisible();
      await expect(page.getByText('Nothing is saved until you tap Add to list.')).toBeVisible();
      await expect(page.getByLabel('Item name')).toHaveValue(itemName);

      const confirm = page.getByRole('button', { name: 'Add to list' });
      await expect(confirm).toBeDisabled();
      expect((await groceryItems.where('name', '==', itemName).get()).size).toBe(0);

      await page.getByRole('radio', { name: /Weekly Groceries/ }).click();
      await expect(confirm).toBeEnabled();
      expect((await groceryItems.where('name', '==', itemName).get()).size).toBe(0);

      await confirm.click();
      await expect(page.getByText('Added to your list', { exact: true })).toBeVisible();

      const saved = await groceryItems.where('name', '==', itemName).get();
      expect(saved.size).toBe(1);
      expect(saved.docs[0].data()).toMatchObject({ status: 'needed', quantity: 1, sourceUrl });
    } finally {
      await deleteItemsNamed(itemName);
    }
  });
});
