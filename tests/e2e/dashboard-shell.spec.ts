import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type DocumentReference, type QuerySnapshot } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';
import { computeChoreFacts, computePetFacts, recurringTemplateIdsFrom, roomSummary, type RawDoc } from '../../src/lib/dashboard/facts';
import { dayKey } from '../../src/lib/dashboard/dates';
import { buildMorningBrief } from '../../src/lib/dashboard/brief';
import { roomLinkName } from '../../src/lib/dashboard/touch';

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
    // HP-28b: the room link's name is the summary followed by its chore titles.
    await expect(house.getByRole('link', { name: roomLinkName(kitchen!, roomSummary(kitchen!)), exact: true })).toBeVisible();
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
    // HP-25: your chores open Chores filtered to you.
    const choresPhrase = buildMorningBrief({ chores: choreFacts }, { greeting: 'Hi' }).segments.find((segment) => segment.href === '/chores?who=me')!;
    expect(choresPhrase.text).toBe(`${choreFacts.mineDueToday} ${choreFacts.mineDueToday === 1 ? 'chore' : 'chores'} today`);
    await expect(brief.getByRole('link', { name: choresPhrase.text, exact: true })).toHaveAttribute('href', '/chores?who=me');
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
    // Item mode, never a typed "add " prefix (QA-15).
    await expect(palette.getByTestId('palette-mode-item')).toBeVisible();
    await expect(palette.getByRole('combobox')).toHaveCount(0);
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
    await expect(page.getByRole('main').getByTestId('landing')).toBeVisible();
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

/*
 * H7 (HP-33, HP-32a, HP-25): one-tap Done and Fed on the dashboard, the household summary
 * with names, and the brief's overdue link opening a filtered Chores page.
 */
test.describe('H7: dashboard one-tap actions', () => {
  const seedChore = (id: string, data: Record<string, unknown>) => household.collection('chores').doc(id).set({
    assignedToEmail: 'sam.member@example.test',
    assignedToDisplayName: 'Sam Member',
    isCompleted: false,
    roomIds: ['kitchen'],
    ...data,
  });

  test('HP-33b: Done completes on the server, credits the completer, says so offline, and Undo reopens it', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const id = 'dashboard-one-tap-done';
    const ref = household.collection('chores').doc(id);
    // The most overdue chore, so it is the tile's first row (the one shown beside the house).
    await seedChore(id, { task: 'Dashboard one tap', dueDate: '2026-06-01', originalDueDate: '2026-06-01' });
    try {
      await openDashboard(page);
      const tile = page.getByTestId('dashboard-tile-chores');
      const row = tile.getByTestId(`household-chore-${id}`);
      // HP-32a: names only, with the room and the overdue state.
      await expect(row).toContainText('Sam Member');
      await expect(row).toContainText('Kitchen');
      const summary = tile.getByTestId('household-summary');
      await expect(summary).toContainText('Sam Member: Dashboard one tap (overdue)');
      await expect(summary).not.toContainText('@');

      // Offline nothing is queued.
      const done = tile.getByTestId(`chore-done-${id}`);
      await page.context().setOffline(true);
      await done.click();
      await expect(page.getByText("You're offline. Not completed.").first()).toBeVisible();
      await expect(done).toHaveAttribute('data-state', 'failed');
      expect((await ref.get()).data()?.isCompleted).toBe(false);
      await page.context().setOffline(false);

      await done.click();
      await expect.poll(async () => (await ref.get()).data()?.isCompleted).toBe(true);
      const completed = (await ref.get()).data()!;
      expect(completed.completedByUid, 'the completer, not the assignee, is credited').toBe('e2e-owner-uid');
      expect(completed.completedAtServer).toBeTruthy();
      expect(completed.completionId).toBeTruthy();
      await expect(row).toHaveCount(0);

      await page.getByRole('button', { name: 'Undo' }).click();
      await expect.poll(async () => (await ref.get()).data()?.isCompleted).toBe(false);
      const reopened = (await ref.get()).data()!;
      expect(reopened.completionId).toBeUndefined();
      expect(reopened.completedByUid).toBeUndefined();
      await expect(row).toBeVisible();
    } finally {
      await page.context().setOffline(false);
      await ref.delete();
    }
  });

  test("HP-25: the brief's overdue count opens Chores filtered to your overdue work", async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const id = 'dashboard-brief-overdue';
    const ref = household.collection('chores').doc(id);
    await seedChore(id, { task: 'Dashboard brief overdue', assignedToEmail: ownerEmail, assignedToDisplayName: 'Alex E2E', dueDate: '2026-07-01', originalDueDate: '2026-07-01' });
    try {
      await openDashboard(page);
      const link = page.getByTestId('morning-brief').getByRole('link', { name: /^\d+ overdue/ }).first();
      await expect(link).toHaveAttribute('href', '/chores?due=overdue&who=me');
      await link.click();
      await expect(page).toHaveURL(/\/chores\?due=overdue&who=me$/);
      const main = page.getByRole('main');
      await expect(main.getByText('Dashboard brief overdue').first()).toBeVisible();
      // The owner's chore due today is not overdue; Sam's is not theirs.
      await expect(main.getByText('Reset the kitchen')).toHaveCount(0);
      await expect(main.getByText('Fold clean laundry')).toHaveCount(0);
      await expect(page.getByTestId('chores-filter-overdue')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('chores-filter-mine')).toHaveAttribute('aria-pressed', 'true');
    } finally {
      await ref.delete();
    }
  });

  test('HP-33d: Done and Fed are 48 px touch targets on phones', async ({ page }, testInfo) => {
    mobileOnly(testInfo);
    const id = 'dashboard-one-tap-touch';
    const ref = household.collection('chores').doc(id);
    await seedChore(id, { task: 'Dashboard touch target', dueDate: '2026-06-01', originalDueDate: '2026-06-01' });
    try {
      await openDashboard(page);
      const done = page.getByTestId('dashboard-tile-chores').getByTestId(`chore-done-${id}`);
      await expect(done).toBeVisible();
      const doneBox = (await done.boundingBox())!;
      expect(doneBox.height).toBeGreaterThanOrEqual(48);
      expect(doneBox.width).toBeGreaterThanOrEqual(48);
      // Pixel has no feeding in the seed, so it is hungry and its tile row offers Fed.
      const fed = page.getByTestId('dashboard-tile-pets').getByTestId('pet-fed-pixel');
      await expect(fed).toBeVisible();
      const fedBox = (await fed.boundingBox())!;
      expect(fedBox.height).toBeGreaterThanOrEqual(48);
      // HP-33c: the Shopping tile's tick is a real 48 px button beside the tile link.
      const tick = page.getByTestId('dashboard-tile-shopping').locator('[data-action-key]').first();
      await expect(tick).toBeVisible();
      const tickBox = (await tick.boundingBox())!;
      expect(tickBox.height).toBeGreaterThanOrEqual(48);
      expect(tickBox.width).toBeGreaterThanOrEqual(48);
      expect(await tick.evaluate((button) => button.closest('a') === null)).toBe(true);
    } finally {
      await ref.delete();
    }
  });

  // The oldest needed item of the first list by name (Hardware Run), so it is the tile's
  // first row: the one shown beside the house on the desktop project's wide screen.
  const seedShoppingItem = (id: string, name: string) => {
    const ref = household.collection('shopping-lists').doc('hardware-run').collection('items').doc(id);
    return ref.set({ name, quantity: 1, category: 'Other', status: 'needed', createdAt: new Date('2026-07-01T12:00:00.000Z') }).then(() => ref);
  };

  test('HP-33c: Tick on the Shopping tile buys the item as the reader through the shared tick, and Undo puts it back', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const ref = await seedShoppingItem('dashboard-tick', 'Dashboard tick');
    try {
      await openDashboard(page);
      const tile = page.getByTestId('dashboard-tile-shopping');
      const row = tile.getByTestId('dashboard-shopping-item-hardware-run-dashboard-tick');
      const tick = row.getByRole('button', { name: 'Tick Dashboard tick', exact: true });
      await expect(tick).toBeVisible();
      // A real button beside the tile link, never inside it.
      expect(await tick.evaluate((button) => button.closest('a') === null)).toBe(true);
      await tick.focus();
      await tick.press('Enter');
      await expect.poll(async () => (await ref.get()).data()?.status).toBe('purchased');
      const bought = (await ref.get()).data()!;
      expect(bought.purchasedByUid, 'the reader is the buyer').toBe('e2e-owner-uid');
      expect(bought.purchasedAt).toBeTruthy();
      expect(bought.purchaseOpId).toBeTruthy();
      await expect(row).toHaveCount(0);
      // Focus stays in the tile (the next row's tick, else the tile link), never on the page.
      await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="dashboard-tile-shopping"]')))).toBe(true);
      await expect(page.getByText('Dashboard tick is in the cart').first()).toBeVisible();

      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect.poll(async () => (await ref.get()).data()?.status).toBe('needed');
      const undone = (await ref.get()).data()!;
      expect(undone.undoOpId, 'the Undo names the tick it undoes').toBe(bought.purchaseOpId);
      expect(undone.purchasedByUid).toBeNull();
      await expect(tick).toBeEnabled();
    } finally {
      await ref.delete();
    }
  });

  test('HP-33c: the tile follows ticks made elsewhere, and an Undo after someone else bought it again is refused', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const ref = await seedShoppingItem('dashboard-tick-elsewhere', 'Dashboard elsewhere');
    try {
      await openDashboard(page);
      const tile = page.getByTestId('dashboard-tile-shopping');
      const row = tile.getByTestId('dashboard-shopping-item-hardware-run-dashboard-tick-elsewhere');
      const tick = row.getByRole('button', { name: 'Tick Dashboard elsewhere', exact: true });
      await expect(tick).toBeEnabled();

      // Bought on another device: the row leaves the tile.
      await ref.update({ status: 'purchased', purchasedByUid: 'e2e-member-uid', purchaseOpId: 'elsewhere-1' });
      await expect(row).toHaveCount(0);
      // Un-ticked there: back, with a working tick.
      await ref.update({ status: 'needed', purchasedByUid: null, purchasedAt: null });
      await expect(tick).toBeEnabled();

      // Ticked here, then un-ticked elsewhere: the control is enabled again (not stuck as done).
      await tick.click();
      await expect.poll(async () => (await ref.get()).data()?.purchasedByUid).toBe('e2e-owner-uid');
      await expect(row).toHaveCount(0);
      await ref.update({ status: 'needed', purchasedByUid: null, purchasedAt: null });
      await expect(tick).toBeEnabled();

      // Ticked here, then bought again by someone else before Undo: their purchase stays.
      await tick.click();
      await expect.poll(async () => (await ref.get()).data()?.purchasedByUid).toBe('e2e-owner-uid');
      await ref.update({ purchasedByUid: 'e2e-member-uid', purchaseOpId: 'elsewhere-2' });
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(page.getByText('Changed by someone else — not undone').first()).toBeVisible();
      const kept = (await ref.get()).data()!;
      expect(kept.status).toBe('purchased');
      expect(kept.purchaseOpId).toBe('elsewhere-2');
      expect(kept.purchasedByUid).toBe('e2e-member-uid');
    } finally {
      await ref.delete();
    }
  });

  test('HP-33c: ticking the last needed item from the keyboard leaves focus on the Shopping tile (review finding on #150)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    // One needed item in the household: the seeded ones are parked as purchased and restored after.
    const parked: DocumentReference[] = [];
    for (const list of (await household.collection('shopping-lists').get()).docs) {
      parked.push(...(await list.ref.collection('items').where('status', '==', 'needed').get()).docs.map((doc) => doc.ref));
    }
    await Promise.all(parked.map((doc) => doc.update({ status: 'purchased' })));
    const ref = await seedShoppingItem('dashboard-last-tick', 'Dashboard last tick');
    try {
      await openDashboard(page);
      const tile = page.getByTestId('dashboard-tile-shopping');
      const tick = tile.getByRole('button', { name: 'Tick Dashboard last tick', exact: true });
      await expect(tick).toBeEnabled();
      await tick.focus();
      await tick.press('Enter');
      await expect.poll(async () => (await ref.get()).data()?.status).toBe('purchased');
      // The last row's departure re-mounts the tile as a plain link: focus moves to it.
      await expect(tile.getByText('Lists are empty. Nice.')).toBeVisible();
      await expect(tile).toBeFocused();
    } finally {
      await ref.delete();
      await Promise.all(parked.map((doc) => doc.update({ status: 'needed' })));
    }
  });

  /** The focused element is inside the tile (never the page body). */
  const focusInTile = (page: Page, tileId: string) => page.evaluate((id) => {
    const active = document.activeElement;
    return Boolean(active && active !== document.body && active.closest(`[data-testid="${id}"]`));
  }, tileId);

  test('Done from the keyboard leaves focus on the next row\'s Done in the Chores tile, and Undo stays reachable', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    // Not beside the house, so the tile lists several rows with their Done.
    await page.setViewportSize({ width: 900, height: 1000 });
    const first = 'dashboard-keyboard-done-1';
    const second = 'dashboard-keyboard-done-2';
    const firstRef = household.collection('chores').doc(first);
    const secondRef = household.collection('chores').doc(second);
    // The most overdue chores, so they are the tile's first two rows.
    await seedChore(first, { task: 'Keyboard done first', dueDate: '2026-05-01', originalDueDate: '2026-05-01' });
    await seedChore(second, { task: 'Keyboard done second', dueDate: '2026-05-02', originalDueDate: '2026-05-02' });
    try {
      await openDashboard(page);
      const tile = page.getByTestId('dashboard-tile-chores');
      const done = tile.getByTestId(`chore-done-${first}`);
      await expect(done).toBeEnabled();
      await done.focus();
      await done.press('Enter');
      await expect.poll(async () => (await firstRef.get()).data()?.isCompleted).toBe(true);
      await expect(tile.getByTestId(`household-chore-${first}`)).toHaveCount(0);
      // The next row's Done takes focus; it never falls to the page body.
      await expect(tile.getByTestId(`chore-done-${second}`)).toBeFocused();
      expect(await focusInTile(page, 'dashboard-tile-chores')).toBe(true);
      // The Undo toast is still there for the keyboard.
      const undo = page.getByRole('button', { name: 'Undo', exact: true });
      await expect(undo).toBeEnabled();
      await undo.focus();
      await undo.press('Enter');
      await expect.poll(async () => (await firstRef.get()).data()?.isCompleted).toBe(false);
    } finally {
      await firstRef.delete();
      await secondRef.delete();
    }
  });

  test('Fed from the keyboard leaves focus in the Pets tile once the pet is fed for today', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    // Not beside the house: the tile's rows carry Fed there (beside it the house's chips do).
    await page.setViewportSize({ width: 900, height: 1000 });
    // Feedings carry the emulator's server time, so this test runs the browser at the real time.
    const petId = 'dashboard-keyboard-fed';
    const pet = household.collection('pets').doc(petId);
    // First by name, and fed once a day: one feeding makes it fed and its Fed leaves.
    await pet.set({ name: 'Acorn', type: 'Dog', foodSchedule: '1 cup once daily' });
    const logs = () => pet.collection('feeding-logs').get();
    try {
      await page.goto('/');
      await expect(page.getByTestId('header-search')).toBeVisible();
      const tile = page.getByTestId('dashboard-tile-pets');
      const fed = tile.getByTestId(`pet-fed-${petId}`);
      await expect(fed).toBeEnabled();
      await fed.focus();
      await fed.press('Enter');
      await expect.poll(async () => (await logs()).size).toBe(1);
      await expect(fed).toHaveCount(0);
      // The next hungry pet's Fed, else the tile link: never the page body.
      await expect.poll(() => focusInTile(page, 'dashboard-tile-pets')).toBe(true);
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
    } finally {
      const all = await logs();
      await Promise.all(all.docs.map((entry) => entry.ref.delete()));
      const state = await pet.collection('feeding-state').get();
      await Promise.all(state.docs.map((entry) => entry.ref.delete()));
      await pet.delete();
    }
  });

  test('HP-33a: Fed on a hungry pet logs through the shared feed operation, asks before a repeat, and Undo removes it', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    // Feedings carry the emulator's server time, so this test runs the browser at the real time.
    const petId = 'dashboard-fed-pet';
    const pet = household.collection('pets').doc(petId);
    await pet.set({ name: 'Biscuit', type: 'Dog', foodSchedule: '1 cup twice daily' });
    const logs = () => pet.collection('feeding-logs').get();
    try {
      await page.goto('/');
      await expect(page.getByTestId('header-search')).toBeVisible();
      const house = page.getByTestId('living-house');
      await expect(house.getByTestId(`house-pet-${petId}`)).toHaveAttribute('data-fed', 'false');
      const fed = house.getByTestId(`pet-fed-${petId}`);
      await fed.click();
      await expect.poll(async () => (await logs()).size).toBe(1);
      const log = (await logs()).docs[0].data();
      expect(log.loggedByUid).toBe('e2e-owner-uid');
      expect(log.cups).toBe(1);
      expect(log.foodType).toBe('Dry');

      await page.getByRole('button', { name: 'Undo' }).click();
      await expect.poll(async () => (await logs()).size).toBe(0);

      await fed.click();
      await expect.poll(async () => (await logs()).size).toBe(1);
      // Fed a moment ago (1 of 2 today, still hungry): the shared duplicate check asks first.
      await expect(house.getByTestId(`house-pet-${petId}`)).toHaveAttribute('data-fed', 'false');
      await fed.click();
      const dialog = page.getByTestId('feed-again-dialog');
      await expect(dialog).toContainText('Feed Biscuit again?');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      expect((await logs()).size).toBe(1);
    } finally {
      const all = await logs();
      await Promise.all(all.docs.map((entry) => entry.ref.delete()));
      const state = await pet.collection('feeding-state').get();
      await Promise.all(state.docs.map((entry) => entry.ref.delete()));
      await pet.delete();
    }
  });
});

test.describe('QA-15 / QA-1: palette modes instead of typed prefixes', () => {
  const groceries = household.collection('shopping-lists').doc('weekly-groceries');
  const namedItems = (list: typeof groceries, name: string) => list.collection('items').where('name', '==', name).get();

  test('Pets "+" opens Feeding mode with pet buttons and no text field; one tap logs a feeding with Undo', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    // Feedings carry the emulator's server time, so this test runs the browser at the real time.
    const petId = 'palette-mode-pet';
    const pet = household.collection('pets').doc(petId);
    await pet.set({ name: 'Waffle', type: 'Dog', foodSchedule: '1 cup twice daily' });
    const logs = () => pet.collection('feeding-logs').get();
    try {
      await page.goto('/');
      await expect(page.getByTestId('header-search')).toBeVisible();
      await page.getByTestId('tile-quick-add-log-feeding').click();
      const palette = page.getByRole('dialog', { name: 'Search or quick add' });
      const mode = palette.getByTestId('palette-mode-feeding');
      await expect(mode).toBeVisible();
      // No typing: no text field at all, so nothing can raise a touch keyboard.
      await expect(palette.getByRole('combobox')).toHaveCount(0);
      await expect(palette.locator('input, textarea')).toHaveCount(0);
      const button = mode.getByTestId(`palette-feed-${petId}`);
      await expect(button).toContainText('Feed Waffle');
      // No field to focus: the first pet button takes focus once the pets have loaded,
      // not "Search or type instead".
      const petButtons = mode.locator('[data-testid^="palette-feed-"]');
      await expect(petButtons.first()).toBeFocused();
      await expect(palette.getByTestId('palette-mode-type-instead')).not.toBeFocused();
      const box = (await button.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(48);

      await button.click();
      await expect.poll(async () => (await logs()).size).toBe(1);
      const log = (await logs()).docs[0].data();
      expect(log.loggedByUid).toBe('e2e-owner-uid');
      expect(log.foodType).toBe('Dry');
      await expect(palette).toHaveCount(0);
      await page.getByRole('button', { name: 'Undo' }).click();
      await expect.poll(async () => (await logs()).size).toBe(0);

      // The F shortcut opens the same mode.
      await page.keyboard.press('f');
      await expect(palette.getByTestId('palette-mode-feeding')).toBeVisible();
      await expect(palette.getByRole('combobox')).toHaveCount(0);
      await expect(palette.locator('[data-testid^="palette-feed-"]').first()).toBeFocused();
    } finally {
      const all = await logs();
      await Promise.all(all.docs.map((entry) => entry.ref.delete()));
      const state = await pet.collection('feeding-state').get();
      await Promise.all(state.docs.map((entry) => entry.ref.delete()));
      await pet.delete();
    }
  });

  test('typing a bare "fed" or "add" and Enter never saves "Fed" or "Add" as a shopping item', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openDashboard(page);
    const palette = page.getByRole('dialog', { name: 'Search or quick add' });
    const input = palette.getByRole('combobox', { name: 'Search or quick add' });

    await page.keyboard.press('Control+k');
    await input.fill('fed ');
    // The pets are offered as choices; no grocery suggestion.
    await expect(palette.getByRole('option', { name: /Log a meal for Maple/ })).toBeVisible();
    await expect(palette.getByRole('option', { name: /Add Fed/ })).toHaveCount(0);
    await expect(palette.getByTestId('palette-quick-add')).toHaveCount(0);
    await input.press('Enter');
    await expect(palette.getByTestId('quick-add-preview')).toContainText('Log a meal for');
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);

    await page.keyboard.press('Control+k');
    await input.fill('add');
    await expect(palette.getByRole('option', { name: /Add a shopping item/ })).toBeVisible();
    await expect(palette.getByRole('option', { name: /Add Add/ })).toHaveCount(0);
    await input.press('Enter');
    await expect(palette.getByTestId('palette-mode-item')).toBeVisible();
    await page.keyboard.press('Escape');

    expect((await namedItems(groceries, 'Fed')).size).toBe(0);
    expect((await namedItems(groceries, 'Add')).size).toBe(0);
  });

  test('Shopping "+" opens Item mode with a list picker; Enter saves to the chosen list', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const second = household.collection('shopping-lists').doc('palette-mode-list');
    await second.set({ name: 'E2E Mode Groceries', description: '', icon: 'ShoppingCart', type: 'Grocery', color: 'tint-3' });
    try {
      await openDashboard(page);
      await page.getByTestId('tile-quick-add-add-item').click();
      const palette = page.getByRole('dialog', { name: 'Search or quick add' });
      const mode = palette.getByTestId('palette-mode-item');
      await expect(mode).toBeVisible();
      await expect(palette.getByRole('combobox')).toHaveCount(0);
      const field = mode.getByTestId('palette-item-input');
      // Item mode needs typing, so its field has focus.
      await expect(field).toBeFocused();
      const picker = mode.getByRole('radiogroup', { name: 'Add to' });
      await expect(picker.getByRole('radio', { name: 'Weekly Groceries' })).toBeVisible();
      await picker.getByRole('radio', { name: 'E2E Mode Groceries' }).click();
      await expect(picker.getByRole('radio', { name: 'E2E Mode Groceries' })).toHaveAttribute('aria-checked', 'true');
      // The pick is kept by the palette, not the Item panel: leaving the mode
      // (as the preview does after a failed save) and coming back keeps it.
      await mode.getByTestId('palette-mode-type-instead').click();
      await expect(mode).toHaveCount(0);
      const input = palette.getByRole('combobox', { name: 'Search or quick add' });
      await input.fill('add');
      await palette.getByRole('option', { name: /Add a shopping item/ }).click();
      await expect(picker.getByRole('radio', { name: 'E2E Mode Groceries' })).toHaveAttribute('aria-checked', 'true');
      await field.fill('e2e mode towels');
      await field.press('Enter');
      await expect.poll(async () => (await namedItems(second, 'E2e mode towels')).size).toBe(1);
      expect((await namedItems(groceries, 'E2e mode towels')).size).toBe(0);
      await expect(palette).toHaveCount(0);

      // A bare verb in Item mode is refused inline, never saved.
      await page.keyboard.press('a');
      await expect(mode).toBeVisible();
      await mode.getByTestId('palette-item-input').fill('add');
      await mode.getByTestId('palette-item-input').press('Enter');
      await expect(mode).toContainText('Type what to add');
      expect((await namedItems(groceries, 'Add')).size).toBe(0);
    } finally {
      const items = await second.collection('items').get();
      await Promise.all(items.docs.map((item) => item.ref.delete()));
      await second.delete();
    }
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
