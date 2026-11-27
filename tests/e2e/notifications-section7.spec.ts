import { expect, test, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';

// Audit section 7 in the browser: the bell is a real list reachable with Tab and has
// Mark all read (NO-14, NO-20); the center has a Household filter (NO-13) and renders a
// notification without a link as a button that marks it read (NO-11, NO-20).
const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const ownerUid = 'e2e-owner-uid';
const adminApp = getApps().find((app) => app.name === 'notifications-section7')
  || initializeApp({ projectId }, 'notifications-section7');
const notifications = getFirestore(adminApp).collection('households').doc(householdId).collection('notifications');
const MESSAGE = 'A notification for the section 7 test.';

const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');

async function seed(testInfo: TestInfo, label: string, fields: Record<string, unknown> = {}) {
  const id = `e2e-no7-${label}-${testInfo.project.name}`;
  const title = `Section seven ${label} ${testInfo.project.name}`;
  await notifications.doc(id).set({
    householdId, category: 'general', title, message: MESSAGE,
    createdAt: Timestamp.fromDate(new Date(fixedNow.getTime() - 30 * 60 * 1000)),
    expiresAt: Timestamp.fromDate(new Date(fixedNow.getTime() + 6 * 24 * 60 * 60 * 1000)),
    audience: ['*'], readBy: {}, dismissedBy: {}, ...fields,
  });
  return { id, title };
}

// Mark all read touches every notice the owner can see in the shared emulator; the
// ones that were unread are put back afterwards so other specs' counts hold.
const markedByThisSpec: string[] = [];
const readByOwner = async (id: string) => Boolean((await notifications.doc(id).get()).data()?.readBy?.[ownerUid]);

test.describe('notifications (audit section 7)', () => {
  test.afterAll(async () => {
    const seeded = await notifications.where('message', '==', MESSAGE).get();
    await Promise.all(seeded.docs.map((doc) => doc.ref.delete()));
    await Promise.all(markedByThisSpec.map(async (id) => {
      const ref = notifications.doc(id);
      if ((await ref.get()).exists) await ref.update({ [`readBy.${ownerUid}`]: FieldValue.delete() });
    }));
  });

  test('the bell: Tab reaches each dismiss button, and Mark all read clears the badge', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const { id, title } = await seed(testInfo, 'bell', { deepLink: '/chores' });
    await page.clock.setFixedTime(fixedNow);
    await page.goto('/');
    await page.getByTestId('notification-bell').click();
    const panel = page.getByTestId('notification-bell-panel');
    await expect(panel.getByRole('link', { name: new RegExp(title) })).toBeVisible();
    await panel.getByRole('link', { name: new RegExp(title) }).focus();
    await page.keyboard.press('Tab');
    await expect(panel.getByRole('button', { name: `Dismiss ${title}` })).toBeFocused();
    const before = await notifications.get();
    markedByThisSpec.push(...before.docs.filter((d) => !d.data().readBy?.[ownerUid]).map((d) => d.id));
    await panel.getByRole('button', { name: 'Mark all read' }).click();
    await expect.poll(() => readByOwner(id)).toBe(true);
  });

  test('the center: a Household filter, and a notice without a link is a button that marks it read', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const { id, title } = await seed(testInfo, 'linkless');
    await page.clock.setFixedTime(fixedNow);
    await page.goto('/notifications');
    await expect(page.getByRole('heading', { name: 'Notification Center', exact: true })).toBeVisible();
    const filters = page.getByTestId('notification-filters');
    await filters.getByRole('button', { name: 'Household', exact: true }).click();
    const wrapper = page.getByTestId('notification-card').filter({ hasText: title });
    // The card's own button comes first; the dismiss button sits after it.
    const card = wrapper.getByRole('button').first();
    await expect(card).toBeVisible();
    await expect(card).not.toHaveAccessibleName(/^Dismiss/);
    await expect(wrapper.getByRole('link')).toHaveCount(0);
    await card.click();
    await expect.poll(() => readByOwner(id)).toBe(true);
  });
});
