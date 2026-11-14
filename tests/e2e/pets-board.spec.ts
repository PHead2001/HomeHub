import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

/*
 * P4 Pets views on the seeded e2e household: the status-first board at the wall
 * tablet's sizes (PE-9, D-P14), phone row cards (PE-13a/b), the touch hold with
 * real touch events (PE-12c) and its caption (PE-12a), touch-only due dates and
 * "+N" chips (PE-16), and 48 px hit areas on the pet page (PE-14). Every test
 * removes the pets and entries it adds.
 */

const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const baseURL = 'http://127.0.0.1:9002';
const adminApp = getApps().find((app) => app.name === 'pets-board') || initializeApp({ projectId }, 'pets-board');
const db = getFirestore(adminApp);
const household = db.collection('households').doc(householdId);
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');

const EXTRA = ['pet-e2eBoardA', 'pet-e2eBoardB', 'pet-e2eBoardC', 'pet-e2eBoardD'];
const LONG_NAME = 'Bartholomew-Fluffington-the-Magnificent-of-Maple-Street';

async function seedExtraPets(count = EXTRA.length) {
  await Promise.all(EXTRA.slice(0, count).map((id, index) => household.collection('pets').doc(id).set({
    name: index === 0 ? LONG_NAME : `Board pet ${index + 1}`, type: 'Cat', photoUrl: '', dataAiHint: 'cat', foodSchedule: 'twice daily', feedingsPerDay: 2,
  })));
}

async function restore() {
  await Promise.all(EXTRA.map((id) => db.recursiveDelete(household.collection('pets').doc(id))));
  for (const petId of ['maple', 'pixel']) {
    const pet = household.collection('pets').doc(petId);
    const meds = await pet.collection('medication-logs').where('notes', '==', 'e2e-board').get();
    await Promise.all(meds.docs.map((entry) => entry.ref.delete()));
  }
  const feedings = await household.collection('pets').doc('pixel').collection('feeding-logs').get();
  await Promise.all(feedings.docs.map((entry) => entry.ref.delete()));
  await household.collection('pets').doc('pixel').collection('feeding-state').doc('current').delete();
}

/** A legacy medication countdown on a pet, `days` from today (negative: overdue). */
async function seedMedication(petId: string, name: string, days: number) {
  const due = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  await household.collection('pets').doc(petId).collection('medication-logs').add({
    date: new Date(Date.now() - 30 * 86_400_000).toISOString(), medication: name, dosage: '1 dose', notes: 'e2e-board', nextDueDate: due,
  });
}

async function touchContext(browser: Browser, viewport: { width: number; height: number }, extra: { reducedMotion?: 'reduce'; colorScheme?: 'dark' | 'light' } = {}) {
  const context = await browser.newContext({ baseURL, viewport, hasTouch: true, isMobile: viewport.width < 768, storageState: 'playwright/.auth/e2e-owner.json', ...extra });
  return { context, page: await context.newPage() };
}

async function openPets(page: Page) {
  await page.goto('/pets');
  await expect(page.getByRole('heading', { name: 'Your Pets', exact: true })).toBeVisible();
}

const noPageScroll = (page: Page) => page.evaluate(() => ({
  vertical: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
}));

test.describe('pets: board, rows, touch and targets (P4)', () => {
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.project.name === 'desktop-chromium') await restore();
  });

  for (const viewport of [{ width: 1263, height: 818 }, { width: 1263, height: 722 }, { width: 1264, height: 843 }]) {
    test(`board at ${viewport.width}x${viewport.height}: six pets, every status on screen, no page scroll (PE-9a/b/e/f/g)`, async ({ browser }, testInfo) => {
      desktopOnly(testInfo);
      await seedExtraPets();
      await seedMedication('maple', 'Heartworm', -2);
      const { context, page } = await touchContext(browser, viewport);
      try {
        await openPets(page);
        const board = page.getByTestId('pets-board');
        await expect(board).toBeVisible();
        // The subtitle is gone on the board (PE-9f).
        await expect(page.getByText('Feedings, medication and care for every pet, at a glance.')).toHaveCount(0);
        const cards = board.locator('[data-layout="board"]');
        await expect(cards).toHaveCount(6);
        for (const card of await cards.all()) {
          const band = card.getByTestId('pet-status-band');
          const line = card.getByTestId('pet-status-line');
          await expect(band).not.toHaveText('');
          await expect(line).toBeVisible();
          const lineBox = (await line.boundingBox())!;
          expect(lineBox.y + Math.min(lineBox.height, 24)).toBeLessThanOrEqual(viewport.height);
          // The status is the most prominent text: 20-24 px and larger than the name.
          const sizes = await card.evaluate((element) => ({
            line: parseFloat(getComputedStyle(element.querySelector('[data-testid="pet-status-line"]')!).fontSize),
            name: parseFloat(getComputedStyle(element.querySelector('h2')!).fontSize),
          }));
          expect(sizes.line).toBeGreaterThanOrEqual(20);
          expect(sizes.line).toBeGreaterThan(sizes.name);
        }
        // Red band with its text label for an overdue medication (PE-9b).
        await expect(page.getByTestId('pet-card-maple').getByTestId('pet-status-band')).toHaveAttribute('data-band', 'overdue');
        await expect(page.getByTestId('pet-card-maple').getByTestId('pet-status-band')).toContainText('Medication overdue');
        // A long name without spaces clamps instead of overflowing (PE-20d, PE-9g).
        const long = page.getByTestId(`pet-card-${EXTRA[0]}`).locator('h2');
        expect(await long.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        const scroll = await noPageScroll(page);
        expect(scroll.vertical).toBeLessThanOrEqual(1);
        expect(scroll.sideways).toBeLessThanOrEqual(0);
      } finally {
        await context.close();
      }
    });
  }

  test('board with two pets: cards grow to use the screen (PE-9d); dark theme, reduced motion and 130% text still fit', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const { context, page } = await touchContext(browser, { width: 1263, height: 818 }, { reducedMotion: 'reduce', colorScheme: 'dark' });
    try {
      await page.addInitScript(() => { document.documentElement.style.fontSize = '130%'; });
      await openPets(page);
      const cards = page.getByTestId('pets-board').locator('[data-layout="board"]');
      await expect(cards).toHaveCount(2);
      const box = (await cards.first().boundingBox())!;
      expect(box.width).toBeGreaterThan(1263 / 2 - 80);
      expect(box.height).toBeGreaterThan(400);
      for (const card of await cards.all()) await expect(card.getByTestId('pet-status-line')).toBeInViewport();
      const scroll = await noPageScroll(page);
      expect(scroll.vertical).toBeLessThanOrEqual(1);
      expect(scroll.sideways).toBeLessThanOrEqual(0);
    } finally {
      await context.close();
    }
  });

  test('phone (390 x 844): compact rows, several on one screen, the first Feed above the fold, Add Pet in the header (PE-13a/b)', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    await seedExtraPets(3);
    const { context, page } = await touchContext(browser, { width: 390, height: 844 });
    try {
      await openPets(page);
      const rows = page.getByTestId('pets-rows').locator('[data-layout="rows"]');
      await expect(rows).toHaveCount(5);
      const avatar = (await page.getByTestId('pet-photo-maple').boundingBox())!;
      expect(Math.round(avatar.width)).toBe(64);
      expect(Math.round(avatar.height)).toBe(64);
      let onScreen = 0;
      for (const row of await rows.all()) {
        const box = (await row.boundingBox())!;
        if (box.y + box.height <= 844) onScreen += 1;
      }
      expect(onScreen).toBeGreaterThanOrEqual(3);
      const feed = (await rows.first().getByRole('button', { name: /^Feed / }).boundingBox())!;
      expect(feed.y + feed.height).toBeLessThanOrEqual(844);
      expect(feed.height).toBeGreaterThanOrEqual(48);
      const title = (await page.getByRole('heading', { name: 'Your Pets', exact: true }).boundingBox())!;
      const add = (await page.getByRole('button', { name: 'Add Pet' }).boundingBox())!;
      expect(add.y).toBeLessThan(title.y + title.height);
      expect(add.width).toBeLessThan(390 / 2);
      expect((await noPageScroll(page)).sideways).toBeLessThanOrEqual(0);
    } finally {
      await context.close();
    }
  });

  test('touch: one hold logs exactly one feeding, a scroll that starts on the photo logs none, and the caption goes after the first hold (PE-12a/c, PE-11a)', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const { context, page } = await touchContext(browser, { width: 1263, height: 818 });
    try {
      await page.clock.setFixedTime(new Date());
      await openPets(page);
      await expect(page.getByTestId('hold-caption')).toHaveText(/Hold the photo to feed/);
      const card = page.getByTestId('pet-card-pixel');
      await expect(card).toContainText('No feedings logged yet');
      const box = (await page.getByTestId('pet-photo-pixel').boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const client = await context.newCDPSession(page);
      const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number }[]) => client.send('Input.dispatchTouchEvent', { type, touchPoints: points });

      // A tap on the photo never navigates on touch (PE-11a).
      await touch('touchStart', [{ x, y }]);
      await touch('touchEnd', []);
      await page.waitForTimeout(400);
      await expect(page).toHaveURL(/\/pets$/);

      // A scroll that starts on the photo: the finger moves off it and keeps going past the hold time.
      await touch('touchStart', [{ x, y }]);
      for (let step = 1; step <= 12; step += 1) {
        await touch('touchMove', [{ x, y: y - step * 15 }]);
        await page.waitForTimeout(80);
      }
      await touch('touchEnd', []);
      await page.waitForTimeout(500);
      expect((await household.collection('pets').doc('pixel').collection('feeding-logs').get()).size).toBe(0);

      // One hold, held past the end: exactly one feeding, still on /pets.
      await touch('touchStart', [{ x, y }]);
      await expect(page.getByTestId('pet-photo-pixel')).toHaveAttribute('data-hold-phase', 'complete', { timeout: 3000 });
      await page.waitForTimeout(700);
      await touch('touchEnd', []);
      await expect.poll(async () => (await household.collection('pets').doc('pixel').collection('feeding-logs').get()).size).toBe(1);
      await page.waitForTimeout(800);
      expect((await household.collection('pets').doc('pixel').collection('feeding-logs').get()).size).toBe(1);
      await expect(page).toHaveURL(/\/pets$/);
      // The caption is done, and stays done after a reload (remembered per browser, D-P17).
      await expect(page.getByTestId('hold-caption')).toHaveCount(0);
      expect(await page.evaluate(() => window.localStorage.getItem('homehub.pets.holdCaptionDone'))).toBe('1');
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Your Pets', exact: true })).toBeVisible();
      await expect(page.getByTestId('pet-card-pixel')).toBeVisible();
      await expect(page.getByTestId('hold-caption')).toHaveCount(0);
      // The keyboard hint is never shown on touch (PE-12d).
      await page.getByTestId('pet-card-pixel').getByRole('button', { name: /^Feed Pixel/ }).focus();
      await page.waitForTimeout(600);
      await expect(page.getByTestId('shortcut-hint-log-feeding')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('chips: the whole status shows, the due date shows on touch, "+N" lists the rest on a tap (PE-16a-c)', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    await seedMedication('maple', 'An extremely long medication name that never fits on a chip', 3);
    await seedMedication('maple', 'Joint support', 9);
    await seedMedication('maple', 'Dental chew', 19);
    await seedMedication('maple', 'Ear drops', 25);
    const { context, page } = await touchContext(browser, { width: 1263, height: 818 });
    try {
      await openPets(page);
      const chips = page.getByTestId('pet-card-maple').getByTestId('medication-chips');
      const first = chips.getByRole('link').first();
      await expect(first.getByTestId('chip-status')).toHaveText('Due in 3 days');
      await expect(first.getByTestId('chip-date')).toBeVisible();
      expect(await first.getByTestId('chip-status').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      const more = chips.getByTestId('medication-chips-more');
      await expect(more).toHaveText(/\+\d/);
      await more.click();
      await expect(chips.getByRole('link')).toHaveCount(5);
    } finally {
      await context.close();
    }
  });

  test('pet page at 1263 x 818 on touch: tabs, log delete, form controls have 48 px hit areas that do not overlap (PE-14c-f)', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const { context, page } = await touchContext(browser, { width: 1263, height: 818 });
    try {
      await page.goto('/pets/maple?tab=care');
      await expect(page.getByRole('tab', { name: /Care/ })).toHaveAttribute('data-state', 'active');
      const boxes: { name: string; box: { x: number; y: number; width: number; height: number } }[] = [];
      for (const tab of await page.getByRole('tab').all()) boxes.push({ name: (await tab.textContent()) ?? 'tab', box: (await tab.boundingBox())! });
      const deleteButton = page.getByRole('button', { name: /Delete .* care log/ }).first();
      boxes.push({ name: 'care delete', box: (await deleteButton.boundingBox())! });
      await page.getByRole('tab', { name: /Feeding/ }).click();
      await page.getByRole('button', { name: 'Log with details' }).click();
      await page.getByText('Use current time').click();
      for (const name of ['AM', 'PM', 'Dry', 'Wet', 'Mix']) {
        boxes.push({ name, box: (await page.locator('label', { hasText: new RegExp(`^${name}$`) }).first().boundingBox())! });
      }
      boxes.push({ name: 'use current time', box: (await page.locator('label[for="useCurrentTime"]').boundingBox())! });
      for (const { name, box } of boxes) expect(box.height, name).toBeGreaterThanOrEqual(48);
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i].box;
          const b = boxes[j].box;
          const overlap = a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
          expect(overlap, `${boxes[i].name} overlaps ${boxes[j].name}`).toBe(false);
        }
      }
    } finally {
      await context.close();
    }
  });

  test('phone pet page: the tabs come before the photo and Info cards (PE-13c)', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const { context, page } = await touchContext(browser, { width: 390, height: 844 });
    try {
      await page.goto('/pets/maple');
      const tabs = (await page.getByTestId('pet-tabs-column').boundingBox())!;
      const info = (await page.getByRole('heading', { name: 'Info' }).boundingBox())!;
      expect(tabs.y).toBeLessThan(info.y);
      expect(tabs.y).toBeLessThan(844);
      await expect(page.getByRole('heading', { level: 1, name: 'Maple' })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
