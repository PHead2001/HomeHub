import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';

// H11: swipe to dismiss on phones with a five-second Undo; buttons on desktop.
const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const ownerUid = 'e2e-owner-uid';
const adminApp = getApps().find((app) => app.name === 'notifications-swipe')
  || initializeApp({ projectId }, 'notifications-swipe');
const notifications = getFirestore(adminApp).collection('households').doc(householdId).collection('notifications');

const mobileOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'mobile-chromium');
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');

/** A fresh notification of this test's own, so dismissing it never affects other specs. */
async function seedNotification(testInfo: TestInfo, label: string) {
  const id = `e2e-swipe-${label}-${testInfo.project.name}`;
  const title = `Swipe check ${label} ${testInfo.project.name}`;
  await notifications.doc(id).set({
    householdId,
    category: 'chores',
    title,
    message: 'A notification for the swipe test.',
    createdAt: Timestamp.fromDate(new Date(fixedNow.getTime() - 60 * 60 * 1000)),
    expiresAt: Timestamp.fromDate(new Date(fixedNow.getTime() + 6 * 24 * 60 * 60 * 1000)),
    deepLink: '/chores',
    readBy: {},
    dismissedBy: {},
  });
  return { id, title };
}

const isDismissed = async (id: string) => Boolean((await notifications.doc(id).get()).data()?.dismissedBy?.[ownerUid]);

async function openCenter(page: Page, title: string) {
  await page.clock.setFixedTime(fixedNow);
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: 'Notification Center', exact: true })).toBeVisible();
  const link = page.getByRole('link', { name: new RegExp(title) });
  await link.scrollIntoViewIfNeeded();
  await expect(link).toBeVisible();
  return link;
}

/** Drags a finger left across the card; `release` false leaves the finger down. */
async function touchSwipe(page: Page, box: { x: number; y: number; width: number; height: number }, distance: number, release = true) {
  const touch = await page.context().newCDPSession(page);
  const y = box.y + box.height / 2;
  const startX = box.x + box.width - 20;
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: startX - distance, y }] });
  const end = async () => {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await touch.detach();
  };
  if (release) await end();
  return end;
}

test.describe('notification swipe to dismiss', () => {
  test.afterAll(async () => {
    const seeded = await notifications.where('message', '==', 'A notification for the swipe test.').get();
    await Promise.all(seeded.docs.map((doc) => doc.ref.delete()));
  });

  test('phones: the card slides, its hit target stays, and Undo restores it', async ({ page }, testInfo) => {
    mobileOnly(testInfo);
    const { id, title } = await seedNotification(testInfo, 'undo');
    const link = await openCenter(page, title);
    const card = link.locator('..');
    // Touch screens always show the button alternative.
    await expect(page.getByRole('button', { name: `Dismiss ${title}` })).toBeVisible();

    const before = (await link.boundingBox())!;
    const release = await touchSwipe(page, before, 110, false);
    await expect.poll(async () => card.locator('[data-swipe-visual]').getAttribute('style')).toContain('translateX(-110px)');
    // Only the visual layer moved: the link (the tap target) is where it was.
    expect(await link.boundingBox()).toEqual(before);
    await release();

    await expect.poll(() => isDismissed(id)).toBe(true);
    await expect(page.getByText('Notification dismissed', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => isDismissed(id)).toBe(false);
    await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible();
  });

  test('phones: a short drag springs back without dismissing', async ({ page }, testInfo) => {
    mobileOnly(testInfo);
    const { id, title } = await seedNotification(testInfo, 'short');
    const link = await openCenter(page, title);
    await touchSwipe(page, (await link.boundingBox())!, 30);
    await expect.poll(async () => link.locator('[data-swipe-visual]').getAttribute('style')).not.toContain('translateX(-');
    expect(await isDismissed(id)).toBe(false);
    await expect(link).toBeVisible();
  });

  test('phones with reduced motion: nothing slides, the swipe still dismisses', async ({ page }, testInfo) => {
    mobileOnly(testInfo);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { id, title } = await seedNotification(testInfo, 'reduced');
    const link = await openCenter(page, title);
    const release = await touchSwipe(page, (await link.boundingBox())!, 110, false);
    expect(await link.locator('[data-swipe-visual]').getAttribute('style') ?? '').not.toContain('translateX');
    await release();
    await expect.poll(() => isDismissed(id)).toBe(true);
  });

  test('desktop: a mouse drag does nothing; the dismiss button works by mouse and keyboard', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const { id, title } = await seedNotification(testInfo, 'desktop');
    const link = await openCenter(page, title);
    const box = (await link.boundingBox())!;
    await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 160, box.y + box.height / 2, { steps: 5 });
    expect(await link.locator('[data-swipe-visual]').getAttribute('style') ?? '').not.toContain('translateX');
    await page.mouse.up();
    expect(await isDismissed(id)).toBe(false);

    // Keyboard: focusing the card reveals its dismiss button, which is reachable with Tab.
    await page.goto('/notifications');
    await page.getByRole('link', { name: new RegExp(title) }).focus();
    await page.keyboard.press('Tab');
    const dismiss = page.getByRole('button', { name: `Dismiss ${title}` });
    await expect(dismiss).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => isDismissed(id)).toBe(true);
    await expect(page.getByText('Notification dismissed', { exact: true })).toBeVisible();
    await notifications.doc(id).update({ [`dismissedBy.${ownerUid}`]: FieldValue.delete() });
  });
});
