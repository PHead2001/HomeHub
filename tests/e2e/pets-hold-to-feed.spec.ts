import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Hold to feed moved from the photo to the Feed button (owner request). On
// Android Chrome a long press on the pet photo opened the browser's image
// copy/save menu, so the photo hold never worked on the wall tablet. The photo
// is now a plain picture: holding it does nothing (no feeding, no ring, no
// navigation, no browser menu), and with a mouse it is not a link either.
// Pressing and holding Feed (500 ms) opens "When did <pet> eat?" (Feed
// earlier, covered in depth by pets-feed-earlier.spec.ts); a tap on Feed still
// feeds now.
const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const baseURL = 'http://127.0.0.1:9002';
const adminApp = getApps().find((app) => app.name === 'pets-hold-to-feed')
  || initializeApp({ projectId }, 'pets-hold-to-feed');
const household = getFirestore(adminApp).collection('households').doc(householdId);
const pixelLogs = household.collection('pets').doc('pixel').collection('feeding-logs');
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');

/** Pixel has no seeded feedings; remove anything these tests wrote. */
async function clearPixelFeedings() {
  const logs = await pixelLogs.get();
  await Promise.all(logs.docs.map((entry) => entry.ref.delete()));
  await household.collection('pets').doc('pixel').collection('feeding-state').doc('current').delete();
}

async function openPets(page: Page) {
  // Feedings carry the emulator's server time (PE-5): run the page at the real time.
  await page.clock.setFixedTime(new Date());
  await page.goto('/pets');
  await expect(page.getByRole('heading', { name: 'Your Pets', exact: true })).toBeVisible();
  const card = page.getByTestId('pet-card-pixel');
  await expect(card).toContainText('No feedings logged yet');
  return card;
}

async function touchContext(browser: Browser, viewport: { width: number; height: number }) {
  const context = await browser.newContext({ baseURL, viewport, hasTouch: true, isMobile: viewport.width < 768, storageState: 'playwright/.auth/e2e-owner.json' });
  return { context, page: await context.newPage() };
}

/** A real touch press (CDP, pointerType "touch") on a box's centre, held for `hold` ms. */
async function touchHold(page: Page, box: { x: number; y: number; width: number; height: number }, hold: number) {
  const client = await page.context().newCDPSession(page);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.waitForTimeout(hold);
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await client.detach();
}

/** The photo's long-press guards: no link, the image takes no pointer events, a contextmenu is cancelled. */
async function photoGuards(page: Page) {
  return page.getByTestId('pet-photo-pixel').evaluate((photo) => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    photo.dispatchEvent(event);
    const image = photo.querySelector('img');
    return {
      link: photo.closest('a') !== null || photo.querySelector('a') !== null,
      menuCancelled: event.defaultPrevented,
      imagePointer: image ? getComputedStyle(image).pointerEvents : 'none',
      callout: getComputedStyle(photo).getPropertyValue('-webkit-touch-callout') || 'none',
      userSelect: getComputedStyle(photo).userSelect,
    };
  });
}

test.describe('pets: the photo is a plain picture, hold Feed for Feed earlier', () => {
  test.beforeEach(async ({}, testInfo) => { if (testInfo.project.name === 'desktop-chromium') await clearPixelFeedings(); });
  test.afterEach(async ({}, testInfo) => { if (testInfo.project.name === 'desktop-chromium') await clearPixelFeedings(); });

  test('mouse: holding or clicking the photo does nothing; Feed is not described by a photo hold', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const card = await openPets(page);
    const feedButton = card.getByRole('button', { name: 'Feed Pixel, 1 can' });
    await expect(feedButton).toHaveAccessibleDescription('No feedings logged yet 0 of 2 today Next meal: morning To log an earlier feeding, use the clock button, right-click Feed, or press Shift+Enter.');

    const guards = await photoGuards(page);
    expect(guards.link, 'the photo is not a link').toBe(false);
    expect(guards.menuCancelled, 'a long press never opens the browser menu').toBe(true);
    expect(guards.imagePointer).toBe('none');
    expect(guards.userSelect).toBe('none');

    const box = (await page.getByTestId('pet-photo-pixel').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(1200);
    await page.mouse.up();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(600);
    await expect(page).toHaveURL(/\/pets$/);
    await expect(page.getByTestId('hold-to-feed-ring')).toHaveCount(0);
    await expect(page.getByText('Pixel fed', { exact: true })).toHaveCount(0);
    expect((await pixelLogs.get()).size).toBe(0);
  });

  test('touch at 1263 x 818: a long press on the photo feeds nothing; holding Feed opens Feed earlier; a tap on Feed feeds', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const { context, page } = await touchContext(browser, { width: 1263, height: 818 });
    try {
      const card = await openPets(page);
      // No one-time "Hold the photo to feed" caption any more.
      await expect(page.getByTestId('hold-caption')).toHaveCount(0);
      await expect(page.getByText('Hold the photo to feed')).toHaveCount(0);
      expect((await photoGuards(page)).link).toBe(false);

      await touchHold(page, (await page.getByTestId('pet-photo-pixel').boundingBox())!, 1200);
      await page.waitForTimeout(500);
      await expect(page).toHaveURL(/\/pets$/);
      await expect(page.getByTestId('hold-to-feed-ring')).toHaveCount(0);
      expect((await pixelLogs.get()).size).toBe(0);

      const feed = card.getByRole('button', { name: 'Feed Pixel, 1 can' });
      await expect(feed).toHaveAccessibleDescription(/Press and hold Feed to log an earlier feeding\./);
      await expect(feed).not.toHaveAccessibleDescription(/photo/);
      const dialog = page.getByTestId('feed-earlier-dialog');
      await touchHold(page, (await feed.boundingBox())!, 900);
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('When did Pixel eat?');
      await page.waitForTimeout(400);
      expect((await pixelLogs.get()).size).toBe(0);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);

      await touchHold(page, (await feed.boundingBox())!, 60);
      await expect(page.getByText('Pixel fed', { exact: true })).toBeVisible();
      await expect.poll(async () => (await pixelLogs.get()).size).toBe(1);
    } finally {
      await context.close();
    }
  });
});
