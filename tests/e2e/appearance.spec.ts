import { expect, test } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';

const adminApp = getApps().find((app) => app.name === 'appearance-e2e')
  || initializeApp({ projectId: 'demo-homehub-e2e' }, 'appearance-e2e');
const ownerProfile = getFirestore(adminApp).collection('users').doc('alex.e2e@example.test');

test.describe('appearance settings', () => {
  test('a new dark preset is revealed from the old theme, kept on reload and synced to the profile', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'one browser covers the appearance contract');
    const original = (await ownerProfile.get()).data()?.theme;
    try {
      await page.clock.setFixedTime(fixedNow);
      await page.goto('/profile');
      await expect(page.getByText('Appearance', { exact: true })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');

      // Record which theme <html> carries when the view transition's update callback
      // starts. The reveal only works if that is still the old theme there: the new
      // theme must not be applied before the old snapshot is captured.
      await page.evaluate(() => {
        const doc = document as Document & { startViewTransition?: (update: () => void) => unknown };
        const original = doc.startViewTransition?.bind(document);
        if (!original) return;
        (window as unknown as { __themeAtUpdate: string[] }).__themeAtUpdate = [];
        doc.startViewTransition = (update: () => void) => original(() => {
          (window as unknown as { __themeAtUpdate: string[] }).__themeAtUpdate.push(document.documentElement.getAttribute('data-theme') ?? '');
          update();
        });
      });

      await page.getByLabel(/^Hearth/).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'hearth');
      const themeAtUpdate = await page.evaluate(() => (window as unknown as { __themeAtUpdate?: string[] }).__themeAtUpdate ?? null);
      // Chromium supports View Transitions, so the reveal path must have run.
      expect(themeAtUpdate).toEqual(['midnight']);

      await expect.poll(async () => (await ownerProfile.get()).data()?.theme).toMatchObject({ version: 2, darkPreset: 'hearth' });

      // Kept on this device and re-applied on reload.
      await page.reload();
      expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('hearth');
    } finally {
      await ownerProfile.update({ theme: original ?? FieldValue.delete() });
    }
  });
});
