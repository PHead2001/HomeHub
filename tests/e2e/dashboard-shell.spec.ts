import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type QuerySnapshot } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';
import { computeChoreFacts, computePetFacts, recurringTemplateIdsFrom, roomSummary, type RawDoc } from '../../src/lib/dashboard/facts';
import { dayKey } from '../../src/lib/dashboard/dates';
import { buildMorningBrief } from '../../src/lib/dashboard/brief';

const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const adminApp = getApps().find((app) => app.name === 'dashboard-shell')
  || initializeApp({ projectId }, 'dashboard-shell');
const household = getFirestore(adminApp).collection('households').doc(householdId);

const ownerEmail = 'alex.e2e@example.test';

/**
 * The chore facts the dashboard should show right now, computed from the live
 * emulator data with the dashboard's own pure functions (same local-day logic,
 * same pinned clock). Other specs add chores, so counts are never hard-coded.
 */
const docs = (snapshot: QuerySnapshot): RawDoc[] => snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));

async function expectedChoreFacts() {
  const [chores, rooms, templates] = await Promise.all([
    household.collection('chores').get(),
    household.collection('rooms').get(),
    household.collection('chore-templates').get(),
  ]);
  return computeChoreFacts(
    docs(chores),
    docs(rooms),
    { uid: 'e2e-owner-uid', email: ownerEmail },
    fixedNow,
    recurringTemplateIdsFrom(docs(templates), dayKey(fixedNow)),
  );
}

/** Each pet's fed state with the Pets module's own model, from every feeding (both date shapes). */
async function expectedPetFacts() {
  const pets = await household.collection('pets').get();
  const feedings = Object.fromEntries(await Promise.all(pets.docs.map(async (pet) => {
    const logs = await pet.ref.collection('feeding-logs').get();
    return [pet.id, logs.docs.map((log) => log.data() as { date: unknown })] as const;
  })));
  return computePetFacts(docs(pets), feedings, fixedNow);
}

const mobileOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'mobile-chromium');
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');

async function openDashboard(page: Page) {
  await page.clock.setFixedTime(fixedNow);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome Home', exact: true })).toBeVisible();
  // The command center (palette and shortcuts) starts listening once the member record
  // has loaded, which is also when the header search button appears. Keys pressed
  // before that are not handled.
  await expect(page.getByTestId('header-search')).toBeVisible();
}

test.describe('dashboard, shell and notifications', () => {
  test('the dashboard shows the household and live facts without generating anything', async ({ page }) => {
    await openDashboard(page);
    await expect(page.getByTestId('dashboard-household-line')).toContainText('The Foxy Residence E2E');

    // H01: the living house reflects the seeded rooms, pets and maintenance.
    const house = page.getByTestId('living-house');
    await expect(house.getByRole('heading', { name: 'The Foxy Residence E2E' })).toBeVisible();
    await expect(house.getByTestId('house-room-kitchen')).toHaveAttribute('data-room-status', 'due');
    await expect(house.getByTestId('house-room-living-room')).toHaveAttribute('data-room-status', 'due');
    await expect(house.getByTestId('house-room-garage')).toHaveAttribute('data-room-status', 'clear');
    const choreFacts = await expectedChoreFacts();
    const kitchen = choreFacts.rooms.find((room) => room.id === 'kitchen');
    expect(kitchen?.dueToday ?? 0, 'the seed has at least one Kitchen chore due today').toBeGreaterThanOrEqual(1);
    await expect(house.getByRole('link', { name: `Kitchen: ${roomSummary(kitchen!)}`, exact: true })).toBeVisible();
    const petFacts = await expectedPetFacts();
    expect(petFacts.pets.length, 'the seed has pets').toBeGreaterThanOrEqual(2);
    for (const pet of petFacts.pets) {
      await expect(house.getByTestId(`house-pet-${pet.id}`)).toHaveAttribute('data-fed', String(pet.fed));
      await expect(page.getByTestId('dashboard-tile-pets')).toContainText(pet.countLabel);
    }
    await expect(house.getByRole('link', { name: /^Heating and cooling: Replace air filter/ })).toBeVisible();
    await expect(house.getByRole('link', { name: /^Car: .+, (overdue|due today|due soon|expired|expires today|expires soon)$/ })).toBeVisible();

    // Section 3: exact tiles by default, before any AI request.
    await expect(page.getByTestId('home-ai-overview-result')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Your Dashboard' })).toBeVisible();
    await expect(page.getByTestId('dashboard-tile-shopping')).toContainText('3');
    await expect(page.getByTestId('dashboard-tile-shopping')).toContainText('Whole milk');
    // Exact text (NumberTicker keeps one text node with the final value), never a loose partial match.
    await expect(page.getByTestId('dashboard-tile-chores').getByText(`${choreFacts.todayDone} of ${choreFacts.todayTotal} done`, { exact: true })).toBeVisible();
    await expect(page.getByTestId('dashboard-tile-pets')).toContainText('Pixel');
    await expect(page.getByTestId('dashboard-tile-maintenance')).toContainText('Replace air filter');

    // H04: the brief is built from the same facts and links its nouns.
    const brief = page.getByTestId('morning-brief');
    expect(choreFacts.mineDueToday, 'the owner has at least one chore due today').toBeGreaterThanOrEqual(1);
    const choresPhrase = buildMorningBrief({ chores: choreFacts }, { greeting: 'Hi' }).segments.find((segment) => segment.href === '/chores')!;
    expect(choresPhrase.text).toBe(`${choreFacts.mineDueToday} ${choreFacts.mineDueToday === 1 ? 'chore' : 'chores'} today`);
    await expect(brief.getByRole('link', { name: choresPhrase.text, exact: true })).toHaveAttribute('href', '/chores');
  });

  test('the old carousel is gone and nothing overflows on small phones', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await page.setViewportSize({ width: 360, height: 800 });
    await openDashboard(page);
    await expect(page.getByTestId('living-house')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Previous slide' })).toHaveCount(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('H13: the command palette searches and quick-adds with a confirm step', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openDashboard(page);
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Search or quick add' });
    await expect(palette).toBeVisible();
    const input = palette.getByRole('combobox', { name: 'Search or quick add' });

    await input.fill('Maple');
    await expect(palette.getByRole('option', { name: /Maple/ }).first()).toBeVisible();
    await input.press('Enter');
    await expect(page).toHaveURL(/\/pets\/maple$/);

    await openDashboard(page);
    await page.keyboard.press('Control+k');
    await input.fill('add e2e paper towels to groceries');
    const quickAdd = palette.getByTestId('palette-quick-add');
    // Names go through the Shopping parser, which capitalizes all-lowercase names.
    await expect(quickAdd).toContainText('Add E2e paper towels');
    await expect(quickAdd).toContainText('Weekly Groceries');
    await input.press('Enter');
    await expect(palette.getByTestId('quick-add-preview')).toBeVisible();
    // Nothing is written before Confirm.
    const before = await household.collection('shopping-lists').doc('weekly-groceries').collection('items').where('name', '==', 'E2e paper towels').get();
    expect(before.size).toBe(0);
    try {
      await palette.getByTestId('quick-add-confirm').click();
      await expect(palette).toHaveCount(0);
      await expect.poll(async () => (await household.collection('shopping-lists').doc('weekly-groceries').collection('items')
        .where('name', '==', 'E2e paper towels').get()).size).toBe(1);
    } finally {
      const created = await household.collection('shopping-lists').doc('weekly-groceries').collection('items').where('name', '==', 'E2e paper towels').get();
      await Promise.all(created.docs.map((item) => item.ref.delete()));
    }
  });

  test('H13: arrow keys keep the active palette option scrolled into view', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await page.setViewportSize({ width: 1280, height: 560 });
    await openDashboard(page);
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Search or quick add' });
    const input = palette.getByRole('combobox', { name: 'Search or quick add' });
    const options = palette.getByRole('option');
    // The options render after the palette chunk and its index load; wait for them.
    await expect.poll(() => options.count()).toBeGreaterThan(3);
    const count = await options.count();
    // Up from the first option wraps to the last one, below the list's fold.
    await input.press('ArrowUp');
    const last = options.nth(count - 1);
    await expect(last).toHaveAttribute('aria-selected', 'true');
    await expect(input).toHaveAttribute('aria-activedescendant', (await last.getAttribute('id'))!);
    await expect(last).toBeInViewport();
    // And back down to the first.
    await input.press('ArrowDown');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await expect(options.first()).toBeInViewport();
  });

  test('H28: shortcuts open help and jump between modules, never while typing', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openDashboard(page);
    await page.keyboard.press('Shift+?');
    const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(help).toBeVisible();
    await expect(help.getByText('Go to Shopping')).toBeVisible();
    await page.keyboard.press('Escape');
    // Shortcuts stay off while an overlay is visible, including its closing animation.
    await expect(help).toBeHidden();

    await page.keyboard.press('g');
    await page.keyboard.press('s');
    await expect(page).toHaveURL(/\/shopping\/?$/);
  });

  test('header: calendar link gated like chores and named controls', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openDashboard(page);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Calendar' })).toHaveAttribute('href', '/calendar');
    await expect(page.getByRole('button', { name: /^Notifications/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Search or quick add' })).toBeVisible();
  });

  test('H18: the tab bar quick-add fans out and keeps B6 navigation', async ({ page }, testInfo) => {
    mobileOnly(testInfo);
    await openDashboard(page);
    const tabs = page.getByRole('navigation', { name: 'Primary' });
    await expect(tabs.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');

    const fab = tabs.getByRole('button', { name: 'Quick add' });
    await fab.click();
    await expect(fab).toHaveAttribute('aria-expanded', 'true');
    const menu = page.getByRole('menu', { name: 'Quick add' });
    await expect(menu.getByRole('menuitem', { name: 'Add chore' })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Add shopping item' }).click();
    const palette = page.getByRole('dialog', { name: 'Search or quick add' });
    await expect(palette.getByRole('combobox')).toHaveValue('add ');
    await page.keyboard.press('Escape');

    await tabs.getByRole('button', { name: 'More' }).click();
    const sheet = page.getByRole('dialog', { name: 'More' });
    await expect(sheet.getByRole('link', { name: 'Calendar' })).toHaveAttribute('href', '/calendar');
  });

  test('notifications: grouped by day, no internal names or expiry stamps', async ({ page }) => {
    await page.clock.setFixedTime(fixedNow);
    await page.goto('/notifications');
    await expect(page.getByRole('heading', { name: 'Notification Center', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(page.getByRole('heading', { name: /^(Today|This week|Earlier)$/ }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /HVAC filter due today/ })).toBeVisible();
    await expect(page.getByText(/Source:|Expires |maintenance_asset_schedule/)).toHaveCount(0);
  });

  test('H03: signed-out visitors get the landing page and no module navigation', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:9002', colorScheme: 'dark', storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByTestId('landing')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveCount(0);
    await expect(page.getByText('AI Overview')).toHaveCount(0);
    await context.close();
  });

  test('every signed-in page offers a real Sign in button to signed-out visitors', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:9002', colorScheme: 'dark', storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    for (const path of ['/chores', '/calendar', '/shopping', '/library', '/pets', '/maintenance', '/household', '/profile', '/automation']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: /^Sign in to / }), path).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sign in', exact: true }), path).toBeVisible();
      await expect(page.getByText(/Please log in/), path).toHaveCount(0);
    }
    await context.close();
  });

  test('reduced motion keeps the house static and drops the time-of-day tint', async ({ browser }) => {
    const context = await browser.newContext({
      baseURL: 'http://127.0.0.1:9002',
      colorScheme: 'dark',
      reducedMotion: 'reduce',
      storageState: 'playwright/.auth/e2e-owner.json',
    });
    const page = await context.newPage();
    await openDashboard(page);
    await expect(page.getByTestId('living-house')).toBeVisible();
    await expect(page.getByTestId('time-of-day-tint')).toHaveCount(0);
    const animated = await page.getByTestId('living-house').evaluate((element) =>
      Array.from(element.querySelectorAll('*')).filter((node) => getComputedStyle(node).animationName !== 'none').length);
    expect(animated).toBe(0);
    await context.close();
  });
});

test.describe('voice add (H14)', () => {
  test('with speech recognition the palette mic fills the input from what was said', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await page.addInitScript(() => {
      type Handler<T> = ((event: T) => void) | null;
      class FakeRecognition {
        lang = '';
        interimResults = false;
        continuous = false;
        maxAlternatives = 1;
        onresult: Handler<{ results: Array<Array<{ transcript: string }> & { isFinal: boolean }> }> = null;
        onerror: Handler<{ error?: string }> = null;
        onend: (() => void) | null = null;
        start() {
          (window as unknown as { __voiceStarts: number }).__voiceStarts += 1;
          window.setTimeout(() => {
            const alternative = Object.assign([{ transcript: 'e2e voice oat milk to groceries' }], { isFinal: true });
            this.onresult?.({ results: [alternative] });
            this.onend?.();
          }, 50);
        }
        stop() { this.onend?.(); }
        abort() {}
      }
      const w = window as unknown as Record<string, unknown>;
      w.__voiceStarts = 0;
      w.SpeechRecognition = FakeRecognition;
      w.webkitSpeechRecognition = FakeRecognition;
    });
    await openDashboard(page);
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Search or quick add' });
    await expect(palette).toBeVisible();
    const mic = palette.getByRole('button', { name: 'Speak to quick add' });
    await expect(mic).toBeVisible();
    await mic.click();
    await expect(palette.getByRole('combobox', { name: 'Search or quick add' })).toHaveValue('e2e voice oat milk to groceries');
    expect(await page.evaluate(() => (window as unknown as { __voiceStarts: number }).__voiceStarts)).toBe(1);
    // Listening ended with the phrase (nothing is added without the confirm step).
    await expect(palette.getByRole('button', { name: 'Speak to quick add' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('without speech recognition the mic is hidden', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await page.addInitScript(() => {
      // Chromium ships webkitSpeechRecognition; remove both names as an unsupported browser would.
      for (const name of ['SpeechRecognition', 'webkitSpeechRecognition']) {
        Object.defineProperty(window, name, { value: undefined, configurable: true, writable: true });
      }
    });
    await openDashboard(page);
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Search or quick add' });
    await expect(palette.getByRole('combobox', { name: 'Search or quick add' })).toBeVisible();
    await expect(palette.getByRole('button', { name: /Speak to quick add|Stop listening/ })).toHaveCount(0);
  });
});
