import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { fixedNow } from './test-helpers';

// /chores?room=<roomId> (needed by H01's room → Chores morph): the URL drives the
// existing room filter, the filter writes back to the URL, and client navigation
// (Next.js links, Back) keeps both in step.
const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const ownerEmail = 'alex.e2e@example.test';
const adminApp = getApps().find((app) => app.name === 'chores-room-filter')
  || initializeApp({ projectId }, 'chores-room-filter');
const household = getFirestore(adminApp).collection('households').doc(householdId);
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');

const KITCHEN_TASK = 'Room filter kitchen task';
const LIVING_TASK = 'Room filter living room task';
const CHORES = [
  ['room-filter-kitchen', KITCHEN_TASK, 'kitchen'],
  ['room-filter-living', LIVING_TASK, 'living-room'],
] as const;

async function seed() {
  await Promise.all(CHORES.map(([id, task, room]) => household.collection('chores').doc(id).set({
    task,
    assignedToEmail: ownerEmail,
    assignedToDisplayName: 'Alex E2E',
    dueDate: '2026-08-01',
    originalDueDate: '2026-08-01',
    isCompleted: false,
    roomIds: [room],
  })));
}

async function cleanup() {
  await Promise.all(CHORES.map(([id]) => household.collection('chores').doc(id).delete()));
}

async function open(page: Page, path: string) {
  await page.clock.setFixedTime(fixedNow);
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Chore Chart', exact: true })).toBeVisible();
}

const filterButton = (page: Page) => page.getByRole('main').getByRole('button', { name: /^(All Rooms|General|Kitchen|Living Room|Garage|Filter)$/ });

test.describe('chores: ?room= filter', () => {
  test.beforeEach(async ({}, testInfo) => { if (testInfo.project.name === 'desktop-chromium') await seed(); });
  test.afterEach(async ({}, testInfo) => { if (testInfo.project.name === 'desktop-chromium') await cleanup(); });

  test('opens filtered to the room, with the shared-element target', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/chores?room=kitchen');
    const main = page.getByRole('main');
    await expect(main.getByText(KITCHEN_TASK).first()).toBeVisible();
    await expect(main.getByText(LIVING_TASK)).toHaveCount(0);
    await expect(filterButton(page)).toHaveText('Kitchen');
    const container = page.getByTestId('chores-page');
    await expect(container).toHaveAttribute('data-room-filter', 'kitchen');
    expect(await container.evaluate((el) => getComputedStyle(el).viewTransitionName)).toBe('room-kitchen');
  });

  test('changing and clearing the filter updates the URL', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/chores?room=kitchen');
    await filterButton(page).click();
    await page.getByRole('menuitemradio', { name: 'Living Room' }).click();
    await expect(page).toHaveURL(/\/chores\?room=living-room$/);
    await expect(page.getByRole('main').getByText(LIVING_TASK).first()).toBeVisible();
    await expect(page.getByRole('main').getByText(KITCHEN_TASK)).toHaveCount(0);

    await filterButton(page).click();
    await page.getByRole('menuitemradio', { name: 'All Rooms' }).click();
    await expect(page).toHaveURL(/\/chores$/);
    await expect(filterButton(page)).toHaveText('All Rooms');
    await expect(page.getByRole('main').getByText(KITCHEN_TASK).first()).toBeVisible();
    await expect(page.getByRole('main').getByText(LIVING_TASK).first()).toBeVisible();
    expect(await page.getByTestId('chores-page').evaluate((el) => getComputedStyle(el).viewTransitionName)).toBe('none');
  });

  test('follows client navigation and Back', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/chores?room=garage');
    await expect(filterButton(page)).toHaveText('Garage');
    await expect(page.getByRole('main').getByText(KITCHEN_TASK)).toHaveCount(0);

    // Client-side navigation through the header's Next.js link to plain /chores.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Chores' }).click();
    await expect(page).toHaveURL(/\/chores$/);
    await expect(filterButton(page)).toHaveText('All Rooms');
    await expect(page.getByRole('main').getByText(KITCHEN_TASK).first()).toBeVisible();

    // Back (popstate, still client-side) restores the room filter.
    await page.goBack();
    await expect(page).toHaveURL(/\/chores\?room=garage$/);
    await expect(filterButton(page)).toHaveText('Garage');
    await expect(page.getByRole('main').getByText(KITCHEN_TASK)).toHaveCount(0);
  });

  test('an unknown room falls back to All Rooms', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/chores?room=no-such-room');
    await expect(filterButton(page)).toHaveText('All Rooms');
    await expect(page.getByRole('main').getByText(KITCHEN_TASK).first()).toBeVisible();
  });
});

// GOAL-filters (HP-25): `?due=overdue` and `?who=me` filter the page like `?room=`, stay in
// the URL when changed on the page, combine with the room filter and survive reload and Back.
test.describe('chores: ?due= and ?who= filters', () => {
  const MINE_OVERDUE = 'Filter mine overdue';
  const MINE_TODAY = 'Filter mine today';
  const SAM_OVERDUE = 'Filter Sam overdue';
  const FILTER_CHORES = [
    ['filter-mine-overdue', MINE_OVERDUE, ownerEmail, 'Alex E2E', '2026-07-20', 'kitchen'],
    ['filter-mine-today', MINE_TODAY, ownerEmail, 'Alex E2E', '2026-08-01', 'kitchen'],
    ['filter-sam-overdue', SAM_OVERDUE, 'sam.member@example.test', 'Sam Member', '2026-07-20', 'living-room'],
  ] as const;
  test.beforeEach(async ({}, testInfo) => {
    if (testInfo.project.name !== 'desktop-chromium') return;
    await Promise.all(FILTER_CHORES.map(([id, task, email, name, day, room]) => household.collection('chores').doc(id).set({
      task, assignedToEmail: email, assignedToDisplayName: name, dueDate: day, originalDueDate: day, isCompleted: false, roomIds: [room],
    })));
  });
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.project.name !== 'desktop-chromium') return;
    await Promise.all(FILTER_CHORES.map(([id]) => household.collection('chores').doc(id).delete()));
  });

  test('opens filtered to your overdue chores and keeps the filters in the URL', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await open(page, '/chores?due=overdue&who=me');
    const main = page.getByRole('main');
    await expect(main.getByText(MINE_OVERDUE).first()).toBeVisible();
    await expect(main.getByText(MINE_TODAY)).toHaveCount(0);
    await expect(main.getByText(SAM_OVERDUE)).toHaveCount(0);
    const overdue = page.getByTestId('chores-filter-overdue');
    const mine = page.getByTestId('chores-filter-mine');
    await expect(overdue).toHaveAttribute('aria-pressed', 'true');
    await expect(mine).toHaveAttribute('aria-pressed', 'true');
    // Static labels: the state is announced by aria-pressed, not by the text (HP-28a).
    await expect(overdue).toHaveText('Overdue');

    // Everyone's overdue work.
    await mine.click();
    await expect(page).toHaveURL(/\/chores\?due=overdue$/);
    await expect(main.getByText(SAM_OVERDUE).first()).toBeVisible();
    await expect(main.getByText(MINE_TODAY)).toHaveCount(0);

    // Reload keeps it.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Chore Chart', exact: true })).toBeVisible();
    await expect(page.getByTestId('chores-filter-overdue')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('chores-filter-mine')).toHaveAttribute('aria-pressed', 'false');
    await expect(main.getByText(SAM_OVERDUE).first()).toBeVisible();

    // The room filter combines with it and keeps it.
    await filterButton(page).click();
    await page.getByRole('menuitemradio', { name: 'Kitchen' }).click();
    await expect(page).toHaveURL(/\/chores\?room=kitchen&due=overdue$/);
    await expect(main.getByText(MINE_OVERDUE).first()).toBeVisible();
    await expect(main.getByText(SAM_OVERDUE)).toHaveCount(0);

    // Clearing the overdue filter shows today's work again.
    await page.getByTestId('chores-filter-overdue').click();
    await expect(page).toHaveURL(/\/chores\?room=kitchen$/);
    await expect(main.getByText(MINE_TODAY).first()).toBeVisible();
  });
});
