import { expect, test } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

// Audit section 9 (Profile): honest saves, the Notifications card, sign out with a
// confirmation and the high-contrast pair. One browser covers each contract.
const adminApp = getApps().find((app) => app.name === 'profile-e2e')
  || initializeApp({ projectId: 'demo-homehub-e2e' }, 'profile-e2e');
const ownerProfile = getFirestore(adminApp).collection('users').doc('alex.e2e@example.test');

test.describe('profile', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'one browser covers the profile contract');
  });

  test('Save Changes is enabled only once something changed (PR-15)', async ({ page }) => {
    await page.goto('/profile');
    const save = page.getByRole('button', { name: 'Save Changes' });
    await expect(save).toBeDisabled();
    const name = page.getByLabel('Display Name');
    const original = await name.inputValue();
    await name.fill(`${original} X`);
    await expect(save).toBeEnabled();
    await name.fill(original);
    await expect(save).toBeDisabled();
  });

  test('the daily reminder is picked by the hour and saved at once (PR-4, PR-15, PR-17)', async ({ page }) => {
    const original = (await ownerProfile.get()).data()?.choreSettings;
    try {
      await ownerProfile.set({ choreSettings: { reminderEnabled: true, reminderTime: '17:17' } }, { merge: true });
      await page.goto('/profile');
      const card = page.getByTestId('notification-settings');
      await expect(card.getByRole('heading', { name: 'Notifications' })).toBeVisible();
      // An older minute choice shows as its hour.
      await expect(card.getByRole('combobox')).toHaveText('5 PM');
      await card.getByRole('combobox').click();
      await page.getByRole('option', { name: '7 PM' }).click();
      await expect.poll(async () => (await ownerProfile.get()).data()?.choreSettings).toMatchObject({ reminderEnabled: true, reminderTime: '19:00' });
      await expect(page.getByText(/around 7 PM each day/)).toBeVisible();
      await expect(card.getByTestId('push-settings')).toBeVisible();
      await expect(card.getByLabel('Alert me when a chore becomes overdue')).toBeVisible();
    } finally {
      await ownerProfile.update({ choreSettings: original ?? FieldValue.delete() });
    }
  });

  test('sign out asks first; staying signed in changes nothing (PR-16, SL-6)', async ({ page }) => {
    await page.goto('/profile');
    const account = page.getByTestId('account-card');
    await expect(account).toContainText('Signed in with Google as alex.e2e@example.test');
    await account.getByTestId('profile-sign-out').click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Sign out on this device?');
    await dialog.getByRole('button', { name: 'Stay signed in' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Personal Information' })).toBeVisible();

    await account.getByTestId('profile-sign-out').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: /sign in/i }).first()).toBeVisible({ timeout: 15_000 });
  });

  test('the high-contrast preset applies and syncs (PR-20)', async ({ page }) => {
    const original = (await ownerProfile.get()).data()?.theme;
    try {
      await page.goto('/profile');
      await page.getByLabel(/^High contrast\s*Black and white/).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'contrast');
      await expect.poll(async () => (await ownerProfile.get()).data()?.theme).toMatchObject({ version: 2, darkPreset: 'contrast' });
    } finally {
      await ownerProfile.update({ theme: original ?? FieldValue.delete() });
    }
  });
});
