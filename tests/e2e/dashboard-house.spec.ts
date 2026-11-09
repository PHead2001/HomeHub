import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';
import { computeChoreStats } from '../../src/lib/chores/stats';
import type { ChoreRecord } from '../../src/lib/chores/dates';
import { streakMembersFrom, streakTileModel } from '../../src/lib/dashboard/streaks';
import { FINAL_STAGE, LANDING_STEPS } from '../../src/lib/dashboard/landing-scene';

const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const ownerEmail = 'alex.e2e@example.test';
const adminApp = getApps().find((app) => app.name === 'dashboard-house')
  || initializeApp({ projectId }, 'dashboard-house');
const firestore = getFirestore(adminApp);
const household = firestore.collection('households').doc(householdId);

const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');

async function openDashboard(page: Page) {
  await page.clock.setFixedTime(fixedNow);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome Home', exact: true })).toBeVisible();
  await expect(page.getByTestId('header-search')).toBeVisible();
}

// Landing locators are scoped to <main>: under a slow dev server React can leave the streamed
// landing behind in its hidden <div hidden id="S:0"> holding area after the client has rendered
// it, a duplicate no visitor sees. Production (inline swap script) was checked: one copy, no leftover.
test.describe('dashboard house (H01, H02, H22, H03)', () => {
  test('H01: clicking a room zooms into it and opens Chores filtered to that room', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openDashboard(page);
    const kitchen = page.getByTestId('living-house').getByTestId('house-room-kitchen');
    await expect(kitchen).toHaveAttribute('href', '/chores?room=kitchen');
    await kitchen.click();
    await expect(page).toHaveURL(/\/chores\?room=kitchen$/);
  });

  test('H01: rooms are reachable room by room from the keyboard, with text names', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openDashboard(page);
    const house = page.getByTestId('living-house');
    const rooms = house.getByRole('list', { name: 'Rooms' }).getByRole('link');
    // count() does not wait: let the chore listeners deliver the rooms first.
    await expect(house.getByTestId('house-room-kitchen')).toBeVisible();
    const count = await rooms.count();
    expect(count).toBeGreaterThanOrEqual(3);
    await rooms.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(rooms.nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(rooms.nth(count - 1)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(rooms.first()).toBeFocused();
    // Every room link names the room and its state in words.
    for (let index = 0; index < count; index += 1) {
      await expect(rooms.nth(index)).toHaveAttribute('aria-label', /^.+: .+/);
    }
  });

  test('H01: under reduced motion a room click is a plain navigation (no zoom)', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const context = await browser.newContext({
      baseURL: 'http://127.0.0.1:9002',
      reducedMotion: 'reduce',
      storageState: 'playwright/.auth/e2e-owner.json',
    });
    const page = await context.newPage();
    await openDashboard(page);
    const kitchen = page.getByTestId('house-room-kitchen');
    await kitchen.click();
    await expect(page).toHaveURL(/\/chores\?room=kitchen$/);
    await context.close();
  });

  test('H22: the streaks tile shows Chores streak stats exactly', async ({ page }) => {
    const [completed, members] = await Promise.all([
      household.collection('chores').where('isCompleted', '==', true).get(),
      household.collection('members').get(),
    ]);
    const model = streakTileModel(computeChoreStats(
      completed.docs.map((d) => ({ id: d.id, ...d.data() }) as unknown as ChoreRecord),
      streakMembersFrom(members.docs.map((d) => d.data())),
      fixedNow,
    ));
    await openDashboard(page);
    const tile = page.getByTestId('dashboard-tile-streaks');
    await expect(tile).toHaveAttribute('href', '/chores');
    await expect(tile.getByTestId('streaks-week')).toHaveText(`${model.weekCompleted} done this week`);
    const week = `${model.weekCompleted} ${model.weekCompleted === 1 ? 'chore' : 'chores'} done this week.`;
    if (model.longest > 0) {
      const days = `${model.longest} ${model.longest === 1 ? 'day' : 'days'}`;
      const others = model.running > 1 ? ` and ${model.running - 1} more on a streak` : '';
      // The number ticks in visually; the tile's text equivalent states it in full.
      await expect(tile.getByTestId('streaks-summary')).toHaveText(`Best streak: ${days}, ${model.top[0].name}${others}. ${week}`);
      await expect(tile).toContainText(`${model.longest === 1 ? 'day' : 'days'} best streak`);
      await expect(tile.getByTestId('streaks-leader')).toHaveText(`${model.top[0].name}${others}`);
    } else {
      await expect(tile.getByTestId('streaks-summary')).toHaveText(`No streaks yet. ${week}`);
    }
  });

  test('H22: with the Chores leaderboard turned off there is no streaks tile', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const prefs = household.collection('chore-settings').doc('preferences');
    const before = await prefs.get();
    await prefs.set({ leaderboardEnabled: false, updatedAt: new Date().toISOString() });
    try {
      await openDashboard(page);
      // Wait for the rest of the grid, then make sure nothing ranks members.
      await expect(page.getByTestId('dashboard-tile-chores')).toBeVisible();
      await expect(page.getByTestId('dashboard-tile-streaks')).toHaveCount(0);
      await expect(page.getByTestId('streaks-summary')).toHaveCount(0);
      await expect(page.getByText(/best streak|on a streak/)).toHaveCount(0);
    } finally {
      if (before.exists) await prefs.set(before.data()!);
      else await prefs.delete();
    }
  });

  test('H02: live weather is opt-in, sends only the city, persists and fills the weather tile', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const requests: URL[] = [];
    await page.route(/geocoding-api\.open-meteo\.com/, (route) => {
      requests.push(new URL(route.request().url()));
      return route.fulfill({ json: { results: [{ name: 'Austin', latitude: 30.27, longitude: -97.74 }] } });
    });
    await page.route(/api\.open-meteo\.com\/v1\/forecast/, (route) => {
      requests.push(new URL(route.request().url()));
      return route.fulfill({ json: { current: { temperature_2m: 64.2, weather_code: 61, is_day: 1 } } });
    });
    const userDoc = firestore.collection('users').doc(ownerEmail);
    try {
      await openDashboard(page);
      await expect(page.getByTestId('dashboard-tile-weather')).toHaveCount(0);
      const toggle = page.getByTestId('weather-toggle');
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      expect(requests).toHaveLength(0);

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await page.getByLabel('City for weather (optional)').fill('Austin');
      await page.getByTestId('weather-city-form').getByRole('button', { name: 'Save' }).click();

      const tile = page.getByTestId('dashboard-tile-weather');
      await expect(tile).toContainText('64°F');
      await expect(tile).toContainText('Rain in Austin');
      await expect(page.getByTestId('weather-house')).toHaveAttribute('data-effect', 'rain');
      await expect(page.getByTestId('weather-shell')).toHaveAttribute('data-effect', 'rain');

      // Only the city name, then the geocoded coordinates, leave the app.
      const geocode = requests.find((url) => url.hostname.startsWith('geocoding-api'))!;
      expect([...geocode.searchParams.keys()].sort()).toEqual(['count', 'format', 'language', 'name']);
      expect(geocode.searchParams.get('name')).toBe('Austin');
      const forecast = requests.find((url) => url.pathname === '/v1/forecast')!;
      expect([...forecast.searchParams.keys()].sort()).toEqual(['current', 'latitude', 'longitude', 'temperature_unit', 'timezone']);

      // Stored per user on the profile, and kept on reload (served from the 30-minute cache).
      await expect.poll(async () => (await userDoc.get()).get('preferences.weather')).toEqual({ enabled: true, city: 'Austin' });
      const before = requests.length;
      await openDashboard(page);
      await expect(page.getByTestId('weather-toggle')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('dashboard-tile-weather')).toContainText('64°F');
      expect(requests.length).toBe(before);

      // Turning it off hides the weather everywhere.
      await page.getByTestId('weather-toggle').click();
      await expect(page.getByTestId('dashboard-tile-weather')).toHaveCount(0);
      await expect(page.getByTestId('weather-shell')).toHaveCount(0);
    } finally {
      await userDoc.update({ 'preferences.weather': FieldValue.delete() }).catch(() => undefined);
    }
  });

  test('H02: a weather failure hides the weather quietly', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await page.route(/open-meteo\.com/, (route) => route.fulfill({ status: 503, body: 'down' }));
    const userDoc = firestore.collection('users').doc(ownerEmail);
    await userDoc.set({ preferences: { weather: { enabled: true, city: 'Atlantis' } } }, { merge: true });
    try {
      await openDashboard(page);
      await expect(page.getByTestId('weather-toggle')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('dashboard-tile-weather')).toHaveCount(0);
      await expect(page.getByTestId('weather-house')).toHaveCount(0);
      // No error toast and no error announcement (Next's route announcer is an empty alert).
      await expect(page.getByRole('region', { name: /^Notifications/ }).locator('li')).toHaveCount(0);
      await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);
    } finally {
      await userDoc.update({ 'preferences.weather': FieldValue.delete() }).catch(() => undefined);
    }
  });

  test('H03: the sample house assembles as you scroll, ending on the one call to action', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:9002', storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto('/');
    const house = page.getByRole('main').getByTestId('landing-house');
    await expect(house).toBeVisible();
    const last = LANDING_STEPS[LANDING_STEPS.length - 1].module;
    expect(Number(await house.getAttribute('data-stage'))).toBeLessThan(FINAL_STAGE);
    await expect(page.getByRole('main').getByTestId(`landing-chip-${last}`)).toHaveAttribute('data-on', 'false');
    for (const step of LANDING_STEPS) {
      // Scroll the way a reader does: each step up to the middle of the screen.
      await page.getByRole('main').getByTestId(`landing-step-${step.module}`).evaluate((element) => element.scrollIntoView({ block: 'center' }));
      await expect(page.getByRole('main').getByTestId(`landing-chip-${step.module}`)).toHaveAttribute('data-on', 'true');
    }
    await expect(house).toHaveAttribute('data-stage', String(FINAL_STAGE));
    await expect(page.getByRole('button', { name: 'Sign in with Google' })).toHaveCount(1);
    await page.getByRole('button', { name: 'Sign in with Google' }).scrollIntoViewIfNeeded();
    // Scrolling back up never takes the house apart.
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(house).toHaveAttribute('data-stage', String(FINAL_STAGE));
    await context.close();
  });

  test('sign-in: the landing button opens the Auth emulator popup and signs the visitor in', async ({ browser }) => {
    // Real signInWithPopup (CI otherwise signs in with custom tokens): catches a broken
    // popup resolver, which rejects before any popup opens. Runs on both projects; the
    // mobile one emulates a mobile user agent, which takes Firebase's proactive path.
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:9002', storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    // The app reads the Google profile after sign-in; answer for Google, never the network.
    await context.route(/people\.googleapis\.com/, (route) => route.fulfill({
      json: { names: [{ displayName: 'Popup Tester', givenName: 'Popup', familyName: 'Tester' }], photos: [] },
    }));
    await page.goto('/');
    const signIn = page.getByRole('button', { name: 'Sign in with Google' });
    await expect(signIn).toBeEnabled();

    const [popup] = await Promise.all([page.waitForEvent('popup'), signIn.click()]);
    await popup.waitForLoadState();
    expect(new URL(popup.url()).host).toBe('127.0.0.1:9099');
    expect(new URL(popup.url()).pathname).toContain('/emulator/auth/handler');
    expect(pageErrors).toEqual([]);

    // The emulator's account chooser: add an account with generated details.
    await popup.getByRole('button', { name: /add new account/i }).click();
    await popup.getByRole('button', { name: /auto-generate user information/i }).click();
    await popup.getByRole('button', { name: /sign in with google\.com/i }).click();
    await popup.waitForEvent('close');

    // Signed in: a brand-new member gets the create-or-join screen, not the landing.
    await expect(page.getByText('Welcome to HomeHub!', { exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByTestId('landing')).toHaveCount(0);
    await expect(page.getByText('Login Failed')).toHaveCount(0);
    expect(pageErrors).toEqual([]);
    await context.close();
  });

  test('H03: a stale signed-in hint never leaves a signed-out visitor on the skeleton', async ({ browser }) => {
    const context = await browser.newContext({
      baseURL: 'http://127.0.0.1:9002',
      storageState: { cookies: [], origins: [{ origin: 'http://127.0.0.1:9002', localStorage: [{ name: 'homehub.session', value: '1' }] }] },
    });
    const page = await context.newPage();
    await page.goto('/');
    // The hint picks the skeleton before auth resolves; signed out, the landing must win.
    await expect(page.getByRole('main').getByTestId('landing')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Welcome Home', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeEnabled();
    // And the stale hint is cleared for next time.
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem('homehub.session'))).toBeNull();
    await context.close();
  });

  test('H03: under reduced motion the landing shows the finished house at once', async ({ browser }) => {
    const context = await browser.newContext({
      baseURL: 'http://127.0.0.1:9002',
      reducedMotion: 'reduce',
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    await page.goto('/');
    const house = page.getByRole('main').getByTestId('landing-house');
    await expect(house).toHaveAttribute('data-stage', String(FINAL_STAGE));
    for (const piece of ['foundation', 'rooms', 'roof', 'pets', 'details']) {
      await expect(house.locator(`[data-piece="${piece}"]`)).toHaveCSS('opacity', '1');
    }
    for (const step of LANDING_STEPS) {
      await expect(page.getByRole('main').getByTestId(`landing-chip-${step.module}`)).toHaveAttribute('data-on', 'true');
      await expect(page.getByRole('main').getByTestId(`landing-chip-${step.module}`)).toHaveCSS('opacity', '1');
    }
    await context.close();
  });
});
