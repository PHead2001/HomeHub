import { expect, test, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

/*
 * P4 Pets views on the seeded e2e household: the board at the wall tablet's
 * sizes (PE-9, D-P14) and phone row cards (PE-13a/b) with the owner's layout
 * (the pet's name is each card's header, above and bigger than the status; no
 * card scrolls inside itself, the page scrolls when the cards need more than
 * the screen), at 100% and 130% text (the app's own Appearance setting),
 * touch-only due dates and "+N" chips (PE-16), 44 px (mouse) and 48 px (touch)
 * hit areas on the cards and the pet page (PE-14). Hold to feed on the photo is
 * gone (pets-hold-to-feed.spec.ts). Every test removes the pets and entries it adds.
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

/** Board pets: the first has a very long name without spaces; with `slots` the second has confirmed meal times (Breakfast, Dinner). */
async function seedExtraPets(count = EXTRA.length, { slots = false } = {}) {
  await Promise.all(EXTRA.slice(0, count).map((id, index) => household.collection('pets').doc(id).set({
    name: index === 0 ? LONG_NAME : `Board pet ${index + 1}`, type: 'Cat', photoUrl: '', dataAiHint: 'cat', foodSchedule: 'twice daily', feedingsPerDay: 2,
    ...(slots && index === 1 ? {
      mealPlan: {
        slots: [
          { id: 'breakfast', name: 'Breakfast', time: '07:00', amount: 1, unit: 'Cups' },
          { id: 'dinner', name: 'Dinner', time: '18:00', amount: 0.5, unit: 'Cans' },
        ],
        effectiveFrom: '2026-01-01', confirmedAt: Timestamp.now(), confirmedByUid: 'e2e-owner-uid', confirmedByName: 'Alex',
      },
    } : {}),
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

/** The household's day (America/Chicago), `days` from today: the day the chips count from, never UTC's. */
function householdDay(days = 0): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(Date.now() + days * 86_400_000));
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** A legacy medication countdown on a pet, `days` household days from today (negative: overdue). */
async function seedMedication(petId: string, name: string, days: number) {
  const due = householdDay(days);
  await household.collection('pets').doc(petId).collection('medication-logs').add({
    date: new Date(Date.now() - 30 * 86_400_000).toISOString(), medication: name, dosage: '1 dose', notes: 'e2e-board', nextDueDate: due,
  });
}

type ContextExtra = { reducedMotion?: 'reduce'; colorScheme?: 'dark' | 'light'; textScale?: 115 | 130 };

/** A browser context; `textScale` is the app's own Appearance text size (stored per device, applied before paint). */
async function makeContext(browser: Browser, viewport: { width: number; height: number }, touch: boolean, { textScale, ...extra }: ContextExtra = {}) {
  const context = await browser.newContext({
    baseURL, viewport, storageState: 'playwright/.auth/e2e-owner.json', ...extra,
    ...(touch ? { hasTouch: true, isMobile: viewport.width < 768 } : {}),
  });
  if (textScale) {
    await context.addInitScript((value) => {
      const key = 'homehub.appearance';
      let stored: Record<string, unknown> = {};
      try { stored = JSON.parse(window.localStorage.getItem(key) ?? '{}') ?? {}; } catch { stored = {}; }
      window.localStorage.setItem(key, JSON.stringify({ ...stored, textScale: value }));
    }, textScale);
  }
  return { context, page: await context.newPage(), textScale };
}

const touchContext = (browser: Browser, viewport: { width: number; height: number }, extra: ContextExtra = {}) => makeContext(browser, viewport, true, extra);
const mouseContext = (browser: Browser, viewport: { width: number; height: number }, extra: ContextExtra = {}) => makeContext(browser, viewport, false, extra);

async function openPets(page: Page, textScale?: 115 | 130) {
  await page.goto('/pets');
  await expect(page.getByRole('heading', { name: 'Your Pets', exact: true })).toBeVisible();
  if (textScale) await expect(page.locator('html')).toHaveAttribute('data-text-scale', String(textScale));
}

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

/**
 * One card's layout, read in one pass: inner scrolling (the card and its body),
 * the name against the status line, and every control's box (links and buttons).
 */
function auditCard(card: Locator) {
  return card.evaluate((element) => {
    const rect = (node: Element) => node.getBoundingClientRect();
    const box = rect(element);
    const body = element.querySelector('[data-testid="pet-card-body"]');
    const name = element.querySelector('h2')!;
    const line = element.querySelector('[data-testid="pet-status-line"]')!;
    const controls = [...element.querySelectorAll('a[href], button')]
      .filter((node) => rect(node).width > 0 && rect(node).height > 0)
      .map((node) => {
        const r = rect(node);
        return {
          label: node.getAttribute('aria-label') ?? node.textContent?.trim() ?? node.tagName,
          box: { x: r.x, y: r.y, width: r.width, height: r.height },
          inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5,
        };
      });
    return {
      cardOverflow: element.scrollHeight - element.clientHeight,
      bodyOverflow: body ? body.scrollHeight - body.clientHeight : 0,
      sideways: element.scrollWidth - element.clientWidth,
      nameSize: parseFloat(getComputedStyle(name).fontSize),
      lineSize: parseFloat(getComputedStyle(line).fontSize),
      nameAboveLine: rect(name).bottom <= rect(line).top + 0.5,
      controls,
    };
  });
}

/** Checks a card: no inner scrollbar, the name above and bigger than the status, controls inside, apart and at least `min` px. */
async function expectCardFits(card: Locator, min: number, label: string) {
  const audit = await auditCard(card);
  expect(audit.cardOverflow, `${label}: the card does not scroll inside`).toBeLessThanOrEqual(1);
  expect(audit.bodyOverflow, `${label}: the card body does not scroll inside`).toBeLessThanOrEqual(1);
  expect(audit.sideways, `${label}: nothing sticks out sideways`).toBeLessThanOrEqual(1);
  expect(audit.nameSize, `${label}: the name is bigger than the status line`).toBeGreaterThan(audit.lineSize);
  expect(audit.nameAboveLine, `${label}: the name is above the status line`).toBe(true);
  for (const control of audit.controls) {
    expect(control.inside, `${label}: ${control.label} is inside the card`).toBe(true);
    expect(control.box.height, `${label}: ${control.label} height`).toBeGreaterThanOrEqual(min);
    expect(control.box.width, `${label}: ${control.label} width`).toBeGreaterThanOrEqual(min);
  }
  for (let i = 0; i < audit.controls.length; i += 1) {
    for (let j = i + 1; j < audit.controls.length; j += 1) {
      expect(overlaps(audit.controls[i].box, audit.controls[j].box), `${label}: ${audit.controls[i].label} overlaps ${audit.controls[j].label}`).toBe(false);
    }
  }
}

/** Words (3+ letters) that a line break split in two: each word's range must sit on one line. */
function brokenWords(locator: Locator) {
  return locator.evaluateAll((elements) => {
    const broken: string[] = [];
    for (const element of elements) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        for (const match of text.matchAll(/[A-Za-z]{3,}/g)) {
          const range = document.createRange();
          range.setStart(node, match.index!);
          range.setEnd(node, match.index! + match[0].length);
          const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
          if (tops.size > 1) broken.push(match[0]);
        }
      }
    }
    return broken;
  });
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
    for (const textScale of [undefined, 130] as const) {
      test(`board at ${viewport.width}x${viewport.height}${textScale ? ` at ${textScale}% text` : ''}: six pets, the name heads each card, no card scrolls inside, nothing clipped or overlapping (owner request, PE-9b/g)`, async ({ browser }, testInfo) => {
        desktopOnly(testInfo);
        await seedExtraPets(EXTRA.length, { slots: true });
        await seedMedication('maple', 'Heartworm', -2);
        const { context, page } = await touchContext(browser, viewport, { textScale });
        try {
          await openPets(page, textScale);
          const board = page.getByTestId('pets-board');
          await expect(board).toBeVisible();
          // The subtitle is gone on the board (PE-9f).
          await expect(page.getByText('Feedings, medication and care for every pet, at a glance.')).toHaveCount(0);
          const cards = board.locator('[data-layout="board"]');
          await expect(cards).toHaveCount(6);
          // Maple's overdue dose puts the needs-attention strip above the board (PE-26a); measure once it is there.
          await expect(page.getByTestId('pets-attention')).toBeVisible();
          // The legacy pets show Set meal times to the owner once their feedings load.
          await expect.poll(() => board.getByTestId('set-meal-times').count()).toBeGreaterThanOrEqual(EXTRA.length - 1);
          // The slot pet's meals are on the card (one compact line).
          await expect(page.getByTestId(`pet-card-${EXTRA[1]}`).locator('[data-slot-phase]')).toHaveCount(2);
          for (const card of await cards.all()) {
            await expect(card.getByTestId('pet-status-band')).not.toHaveText('');
            await card.scrollIntoViewIfNeeded();
            await expect(card.getByTestId('pet-status-line')).toBeInViewport();
            await expectCardFits(card, 48, (await card.getAttribute('data-testid')) ?? 'card');
          }
          // The board itself never scrolls inside either: when the cards need more than the screen, the page scrolls.
          expect(await board.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
          // The cards in one row line up: each grid row is as tall as its tallest card, none overlaps the next row.
          const boxes = [];
          for (const card of await cards.all()) boxes.push((await card.boundingBox())!);
          for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) expect(overlaps(boxes[i], boxes[j])).toBe(false);
          // Maple's medication chip takes the tap (48 px, inside the card).
          const chip = page.getByTestId('pet-card-maple').getByTestId('medication-chips').getByRole('button').first();
          await chip.scrollIntoViewIfNeeded();
          await expect(chip).toBeInViewport();
          expect(await chip.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return Boolean(hit && element.contains(hit));
          }), 'the medication chip receives the tap').toBe(true);
          // Red band with its text label for an overdue medication (PE-9b).
          await expect(page.getByTestId('pet-card-maple').getByTestId('pet-status-band')).toHaveAttribute('data-band', 'overdue');
          await expect(page.getByTestId('pet-card-maple').getByTestId('pet-status-band')).toContainText('Medication overdue');
          // A long name without spaces wraps and clamps instead of overflowing (PE-20d, PE-9g).
          const long = page.getByTestId(`pet-card-${EXTRA[0]}`).locator('h2');
          expect(await long.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
          // Sideways never; vertically the page may scroll when six cards need more than the screen.
          expect((await noPageScroll(page)).sideways).toBeLessThanOrEqual(0);
        } finally {
          await context.close();
        }
      });
    }
  }

  test('board with two pets: cards grow to use the screen (PE-9d); dark theme, reduced motion and 130% text still fit without page scroll', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const { context, page } = await touchContext(browser, { width: 1263, height: 818 }, { reducedMotion: 'reduce', colorScheme: 'dark', textScale: 130 });
    try {
      await openPets(page, 130);
      const cards = page.getByTestId('pets-board').locator('[data-layout="board"]');
      await expect(cards).toHaveCount(2);
      const box = (await cards.first().boundingBox())!;
      expect(box.width).toBeGreaterThan(1263 / 2 - 80);
      expect(box.height).toBeGreaterThan(400);
      for (const card of await cards.all()) {
        await expect(card.getByTestId('pet-status-line')).toBeInViewport();
        await expectCardFits(card, 48, (await card.getAttribute('data-testid')) ?? 'card');
      }
      const scroll = await noPageScroll(page);
      expect(scroll.vertical).toBeLessThanOrEqual(1);
      expect(scroll.sideways).toBeLessThanOrEqual(0);
    } finally {
      await context.close();
    }
  });

  test('board with a mouse at 1263 x 818: the actions menu, Details chevron and medication chip are at least 44 x 44 (production matrix)', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    await seedExtraPets(1);
    await seedMedication('maple', 'Heartworm', 3);
    const { context, page } = await mouseContext(browser, { width: 1263, height: 818 });
    try {
      await openPets(page);
      const cards = page.getByTestId('pets-board').locator('[data-layout="board"]');
      await expect(cards).toHaveCount(3);
      await expect(page.getByTestId('pet-card-maple').getByTestId('medication-chips').getByRole('button').first()).toBeVisible();
      for (const card of await cards.all()) await expectCardFits(card, 44, (await card.getAttribute('data-testid')) ?? 'card');
      const maple = page.getByTestId('pet-card-maple');
      for (const control of [
        maple.getByRole('button', { name: 'Open actions for Maple' }),
        maple.getByTestId('pet-details-maple'),
        maple.getByTestId('medication-chips').getByRole('button').first(),
      ]) {
        const box = (await control.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
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
      // Each row keeps the actions menu (Edit, Delete) as a 48 px button that overlaps nothing in the row.
      for (const row of await rows.all()) {
        const menu = row.getByRole('button', { name: /^Open actions for / });
        await expect(menu).toBeVisible();
        const boxes = [
          (await menu.boundingBox())!,
          (await row.getByRole('button', { name: /^Feed / }).boundingBox())!,
          (await row.locator('[data-testid^="pet-details-"]').boundingBox())!,
          (await row.locator('[data-testid^="pet-name-"]').boundingBox())!,
        ];
        expect(boxes[0].width).toBeGreaterThanOrEqual(48);
        expect(boxes[0].height).toBeGreaterThanOrEqual(48);
        for (const other of boxes.slice(1)) {
          const [a, b] = [boxes[0], other];
          expect(a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5).toBe(false);
        }
      }
      await page.getByRole('button', { name: 'Open actions for Maple' }).click();
      await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
      await page.keyboard.press('Escape');
      const title = (await page.getByRole('heading', { name: 'Your Pets', exact: true }).boundingBox())!;
      const add = (await page.getByRole('button', { name: 'Add Pet' }).boundingBox())!;
      expect(add.y).toBeLessThan(title.y + title.height);
      expect(add.width).toBeLessThan(390 / 2);
      expect((await noPageScroll(page)).sideways).toBeLessThanOrEqual(0);
    } finally {
      await context.close();
    }
  });

  for (const width of [390, 360]) {
    test(`phone (${width} x 844): the feeding headline has its own line under a "Medication overdue" pill (Codex P2 on #187)`, async ({ browser }, testInfo) => {
      desktopOnly(testInfo);
      await seedMedication('maple', 'Heartworm', -2);
      const { context, page } = await touchContext(browser, { width, height: 844 });
      try {
        await openPets(page);
        const row = page.getByTestId('pets-rows').getByTestId('pet-card-maple');
        const pill = row.locator('[data-band]');
        await expect(pill).toHaveText('Medication overdue');
        const headline = row.getByTestId('pet-status-headline');
        await expect(headline).toBeVisible();
        await expect(headline).not.toHaveText('');
        const shown = await headline.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const pillBox = element.parentElement!.querySelector('[data-band]')!.getBoundingClientRect();
          return {
            width: box.width,
            // Up to two lines, none cut: the whole headline is shown.
            fits: element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1,
            below: box.top >= pillBox.bottom - 0.5,
          };
        });
        expect(shown.width).toBeGreaterThan(80);
        expect(shown.fits).toBe(true);
        expect(shown.below).toBe(true);
        // The pill itself stays inside the row.
        const [rowBox, pillBox] = [(await row.boundingBox())!, (await pill.boundingBox())!];
        expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
        expect((await noPageScroll(page)).sideways).toBeLessThanOrEqual(0);
      } finally {
        await context.close();
      }
    });
  }

  for (const textScale of [100, 115, 130] as const) {
    test(`phone (390 x 844) at ${textScale}% text: rows wrap without clipping: whole name, whole Feed label, no mid-word breaks, attention strip names in full`, async ({ browser }, testInfo) => {
      desktopOnly(testInfo);
      await seedExtraPets(3, { slots: true });
      await seedMedication('maple', 'Heartworm', -2);
      const scale = textScale === 100 ? undefined : textScale;
      const { context, page } = await touchContext(browser, { width: 390, height: 844 }, { textScale: scale });
      try {
        await openPets(page, scale);
        const rows = page.getByTestId('pets-rows').locator('[data-layout="rows"]');
        await expect(rows).toHaveCount(5);
        await expect(page.getByTestId(`pet-card-${EXTRA[1]}`).locator('[data-slot-phase]')).toHaveCount(2);
        for (const row of await rows.all()) {
          const label = (await row.getAttribute('data-testid')) ?? 'row';
          await row.scrollIntoViewIfNeeded();
          await expectCardFits(row, 48, label);
          // Feed keeps its whole label (never "Fe…").
          expect(await row.locator('[data-feed-button] span.truncate').evaluate((element) => element.scrollWidth <= element.clientWidth + 1), `${label}: Feed label`).toBe(true);
          // The status, today's meals and Feed break between words only.
          expect(await brokenWords(row.locator('[data-testid="pet-status-line"], [aria-label="Today\'s meals"], [data-feed-button], [data-band]')), `${label}: words split`).toEqual([]);
          // Feed sits under the info, on its own line.
          const info = (await row.getByTestId('pet-status-line').boundingBox())!;
          const feed = (await row.locator('[data-feed-button]').boundingBox())!;
          expect(feed.y, `${label}: Feed under the status`).toBeGreaterThanOrEqual(info.y + info.height - 0.5);
        }
        // The very long name shows in full in its row (wrapped, never clamped or cut).
        const longName = page.getByTestId(`pet-name-${EXTRA[0]}`).locator('span');
        expect(await longName.evaluate((element) => element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1), 'long name in full').toBe(true);
        expect(await longName.evaluate((element) => getComputedStyle(element).webkitLineClamp)).toBe('none');
        // Short names are never clipped or split in the rows.
        expect(await brokenWords(page.getByTestId('pet-name-maple'))).toEqual([]);
        expect(await page.getByTestId('pet-name-maple').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        // The needs-attention strip names the pet in full ("Maple", never "M…").
        const strip = page.getByTestId('pets-attention-maple');
        await expect(strip).toContainText('Maple');
        expect(await strip.evaluate((element) => [...element.querySelectorAll('span')].every((span) => span.scrollWidth <= span.clientWidth + 1))).toBe(true);
        expect(await brokenWords(strip)).toEqual([]);
        expect((await noPageScroll(page)).sideways).toBeLessThanOrEqual(0);
      } finally {
        await context.close();
      }
    });
  }

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
      const first = chips.getByRole('button').first();
      await expect(first.getByTestId('chip-status')).toHaveText('Due in 3 days');
      await expect(first.getByTestId('chip-date')).toBeVisible();
      expect(await first.getByTestId('chip-status').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      const more = chips.getByTestId('medication-chips-more');
      await expect(more).toHaveText(/\+\d/);
      await more.click();
      // Maple has exactly the four countdowns seeded above: two chips and "+2", then all four chips (buttons, PE-24b).
      await expect(chips.locator('[data-medication-state]')).toHaveCount(4);
      await expect(chips.getByTestId('medication-chips-more')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('/pets at 1263 x 818 on touch: the name links, chevrons, menus and Feed buttons are 48 px and do not overlap (WT-28, PE-11b)', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    await seedExtraPets(2);
    const { context, page } = await touchContext(browser, { width: 1263, height: 818 });
    try {
      await openPets(page);
      const boxes: { name: string; box: { x: number; y: number; width: number; height: number } }[] = [];
      for (const petId of ['maple', 'pixel', EXTRA[0], EXTRA[1]]) {
        const card = page.getByTestId(`pet-card-${petId}`);
        boxes.push({ name: `${petId} name`, box: (await card.getByTestId(`pet-name-${petId}`).boundingBox())! });
        boxes.push({ name: `${petId} details`, box: (await card.getByTestId(`pet-details-${petId}`).boundingBox())! });
        boxes.push({ name: `${petId} feed`, box: (await card.getByRole('button', { name: /^Feed / }).boundingBox())! });
        const menu = card.getByRole('button', { name: /^Open actions for / });
        if (await menu.count()) boxes.push({ name: `${petId} menu`, box: (await menu.boundingBox())! });
      }
      for (const { name, box } of boxes) {
        expect(box.height, name).toBeGreaterThanOrEqual(48);
        expect(box.width, name).toBeGreaterThanOrEqual(48);
      }
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

  test('pet page at 1263 x 818 on touch: tabs, log delete, form controls have 48 px hit areas that do not overlap (PE-14c-f)', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const { context, page } = await touchContext(browser, { width: 1263, height: 818 });
    try {
      await page.goto('/pets/maple?tab=care');
      await expect(page.getByRole('tab', { name: /Care/ })).toHaveAttribute('data-state', 'active');
      const boxes: { name: string; box: { x: number; y: number; width: number; height: number } }[] = [];
      for (const tab of await page.getByRole('tab').all()) boxes.push({ name: (await tab.textContent()) ?? 'tab', box: (await tab.boundingBox())! });
      // Back to All Pets and the pet page's own menu are measured with them.
      boxes.push({ name: 'back', box: (await page.getByRole('link', { name: /Back to All Pets/ }).boundingBox())! });
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

  test('phone (390 x 844): Log with details with a chosen time keeps AM/PM inside the form, 48 px, no sideways scroll (PE-14e)', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const { context, page } = await touchContext(browser, { width: 390, height: 844 });
    try {
      await page.goto('/pets/maple?tab=feeding');
      await page.getByRole('tab', { name: /Feeding/ }).click();
      await page.getByRole('button', { name: 'Log with details' }).click();
      await page.getByText('Use current time').click();
      const form = page.getByRole('form', { name: 'Log a feeding with details' });
      const formBox = (await form.boundingBox())!;
      for (const name of ['AM', 'PM']) {
        const label = page.locator('label', { hasText: new RegExp(`^${name}$`) }).first();
        const option = (await label.locator('xpath=..').boundingBox())!;
        expect((await label.boundingBox())!.height, name).toBeGreaterThanOrEqual(48);
        expect(option.x, `${name} starts inside the form`).toBeGreaterThanOrEqual(formBox.x - 0.5);
        expect(option.x + option.width, `${name} ends inside the form`).toBeLessThanOrEqual(formBox.x + formBox.width + 0.5);
      }
      expect(await form.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), 'the form does not overflow sideways').toBe(true);
      expect((await noPageScroll(page)).sideways).toBeLessThanOrEqual(0);
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
      // The Info card's title is a CardTitle (a div, not a heading role).
      const info = (await page.getByText('Info', { exact: true }).boundingBox())!;
      expect(tabs.y).toBeLessThan(info.y);
      expect(tabs.y).toBeLessThan(844);
      await expect(page.getByRole('heading', { level: 1, name: 'Maple' })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('Feed never truncates to "Feed …": the meal and portion show whole or drop out (six pets with Set meal times, 1263 x 722)', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    await seedExtraPets(4);
    const { context, page } = await makeContext(browser, { width: 1263, height: 722 }, true);
    try {
      await page.goto('/pets');
      await page.locator('[data-feed-label]').nth(5).waitFor({ timeout: 30_000 });
      const labels = await page.locator('[data-feed-label]').evaluateAll((boxes) => boxes.map((box) => {
        const outer = box.getBoundingClientRect();
        const [word, rest] = [...box.children].map((child) => child.getBoundingClientRect());
        return {
          wordWhole: (box.children[0] as HTMLElement).scrollWidth <= (box.children[0] as HTMLElement).clientWidth + 1 && word.right <= outer.right + 1,
          restWholeOrHidden: (rest.top >= outer.top - 1 && rest.bottom <= outer.bottom + 1 && rest.right <= outer.right + 1) || rest.top >= outer.bottom - 1,
        };
      }));
      expect(labels.length).toBe(6);
      for (const label of labels) expect(label).toEqual({ wordWhole: true, restWholeOrHidden: true });
    } finally {
      await context.close();
      await restore();
    }
  });
});
