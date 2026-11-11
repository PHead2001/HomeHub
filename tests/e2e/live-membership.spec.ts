import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

// SL-3: membership is live in an open session. Admin writes stand in for the server
// actions an owner would run (role change, approval, removal); the member's page
// follows each without a reload.
const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const householdName = 'The Foxy Residence E2E';
const ownerUid = 'e2e-owner-uid';
const adminApp = getApps().find((app) => app.name === 'live-membership-e2e')
  || initializeApp({ projectId }, 'live-membership-e2e');
const firestore = getFirestore(adminApp);
const adminAuth = getAuth(adminApp);

// A person only this spec uses (allowed by the emulator-only token route).
const LIVE = { uid: 'e2e-live-member-uid', email: 'lee.live@example.test', displayName: 'Lee Live' };
const memberRef = firestore.doc(`households/${householdId}/members/${LIVE.uid}`);
const contactRef = memberRef.collection('private').doc('contact');
const profileRef = firestore.doc(`users/${LIVE.email}`);

const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium', 'one browser is enough for membership flows');

type Seed = { role: 'member' | 'child' | 'newuser'; status: 'active' | 'pending' };

async function seedPerson({ role, status }: Seed) {
  try {
    await adminAuth.getUser(LIVE.uid);
    await adminAuth.updateUser(LIVE.uid, { email: LIVE.email, displayName: LIVE.displayName, emailVerified: true });
  } catch {
    await adminAuth.createUser({ uid: LIVE.uid, email: LIVE.email, displayName: LIVE.displayName, emailVerified: true });
  }
  await profileRef.set({
    email: LIVE.email,
    displayName: LIVE.displayName,
    firstName: 'Lee',
    lastName: 'Live',
    avatarUrl: null,
    role,
    permissions: {},
    householdId,
    uid: LIVE.uid,
  });
  // As the server writes them: no email on the record, a protected contact document.
  await memberRef.set({
    uid: LIVE.uid,
    displayName: LIVE.displayName,
    avatarUrl: null,
    role,
    status,
    permissions: {},
    joinedAt: '2026-07-30T12:00:00.000Z',
    ...(status === 'pending' ? { householdName } : { approvedAt: '2026-07-30T12:05:00.000Z', approvedByUid: ownerUid }),
  });
  await contactRef.set({ email: LIVE.email, updatedAt: '2026-07-30T12:00:00.000Z' });
}

async function cleanUp() {
  await contactRef.delete();
  await memberRef.delete();
  await profileRef.delete();
}

/** What `changeMemberRoleAction` writes (record and profile cache). */
async function changeRole(role: 'member' | 'child', approving = false) {
  await memberRef.update({
    role,
    status: 'active',
    permissions: {},
    ...(approving ? { approvedAt: '2026-08-01T12:00:00.000Z', approvedByUid: ownerUid } : {}),
  });
  await profileRef.update({ role, permissions: {} });
}

/** What `removeMemberAction` writes: record and contact deleted, profile pointer cleared. */
async function removeMember() {
  const batch = firestore.batch();
  batch.delete(contactRef);
  batch.delete(memberRef);
  batch.update(profileRef, { householdId: null, role: 'member', permissions: {} });
  await batch.commit();
}

async function signIn(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:9002', colorScheme: 'dark' });
  const page = await context.newPage();
  await page.goto(`/e2e-login?uid=${LIVE.uid}`);
  await expect(page).toHaveURL('/');
  return { context, page };
}

/** Marks the page; the mark is gone after any reload. */
const markPage = (page: Page) => page.evaluate(() => { (window as unknown as { __slMark?: number }).__slMark = 1; });
const pageWasNotReloaded = async (page: Page) => {
  expect(await page.evaluate(() => (window as unknown as { __slMark?: number }).__slMark)).toBe(1);
};

const shoppingLink = (page: Page) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Shopping' });

test.describe('live membership', () => {
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.project.name === 'desktop-chromium') await cleanUp();
  });

  test('a role change hides and shows gated controls in the open page', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    await seedPerson({ role: 'member', status: 'active' });
    const { context, page } = await signIn(browser);
    try {
      await expect(shoppingLink(page)).toBeVisible();
      await markPage(page);

      // Member -> Child: Child has no shopping access.
      await changeRole('child');
      await expect(shoppingLink(page)).toHaveCount(0);
      await expect(page.getByText('Your role changed').first()).toBeVisible();

      // Child -> Member: it comes back.
      await changeRole('member');
      await expect(shoppingLink(page)).toBeVisible();
      await pageWasNotReloaded(page);
    } finally {
      await context.close();
    }
  });

  test('a pending person who is approved enters the app without a reload', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    await seedPerson({ role: 'newuser', status: 'pending' });
    const { context, page } = await signIn(browser);
    try {
      const waiting = page.getByRole('dialog', { name: 'Waiting for approval' });
      await expect(waiting).toBeVisible();
      await expect(waiting).toContainText(householdName);
      await expect(shoppingLink(page)).toHaveCount(0);
      await markPage(page);

      await changeRole('member', true);
      await expect(waiting).toHaveCount(0);
      await expect(shoppingLink(page)).toBeVisible();
      await expect(page.getByText("You're in").first()).toBeVisible();
      await pageWasNotReloaded(page);
    } finally {
      await context.close();
    }
  });

  test('a removed member is taken out, with nothing of the household left on screen', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    await seedPerson({ role: 'member', status: 'active' });
    const { context, page } = await signIn(browser);
    try {
      await page.goto('/shopping');
      await expect(page.getByRole('heading', { name: 'Shopping Center', exact: true })).toBeVisible();
      await markPage(page);

      await removeMember();
      const notice = page.getByRole('dialog', { name: "You're no longer in this household" });
      await expect(notice).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Shopping Center', exact: true })).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
      await expect(page.getByText(householdName)).toHaveCount(0);
      // The dashboard's last-known house is gone from this device.
      expect(await page.evaluate(() => window.localStorage.getItem('homehub.house-rooms'))).toBeNull();
      await pageWasNotReloaded(page);

      await notice.getByRole('button', { name: 'Continue' }).click();
      await expect(page).toHaveURL('/');
      await expect(page.getByRole('dialog', { name: 'Welcome to HomeHub!' })).toBeVisible();
      await expect(page.getByText(householdName)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
