import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { FieldValue } from 'firebase-admin/firestore';
import {
  KID,
  OWNER_PIN,
  TABLET_VIEWPORTS,
  createDeviceCode,
  enterPin,
  householdRef,
  openTabletContext,
  pairWithCode,
  prepareHousehold,
  removeEveryTablet,
  restoreHousehold,
  setOwnerPin,
} from './devices-helpers';

// Chores on a registered wall tablet against the emulators (docs/modules/devices/README.md,
// "Device actions"; design 9-11; WT-6a, WT-8, WT-20, WT-22, CH-12b, HP-33e): at 1263x818,
// a face-chosen person completes a chore and is credited; Undo puts it back; with the
// points-PIN setting a completion needs the person's PIN; Take; offline, then online, with
// exactly one completion stored.

const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium', 'tablet journeys run once, in their own tablet-sized browser');
const OWNER_UID = 'e2e-owner-uid';

test.describe.configure({ mode: 'serial' });

let tablet: { context: BrowserContext; page: Page } | null = null;
const tabletPage = () => tablet!.page;
const chore = (id: string) => householdRef.collection('chores').doc(id);
const seeded: string[] = [];

/** An open chore due today (the server judges eligibility by the household day). */
const seedChore = async (id: string, fields: Record<string, unknown> = {}) => {
  seeded.push(id);
  await chore(id).set({
    task: `Tablet chore ${id}`, dueDate: new Date().toISOString(), isCompleted: false, subTasks: [], completedSubTasks: [], roomIds: [],
    assignedToUid: '', assignedToDisplayName: 'Unassigned', ...fields,
  });
};

const openChores = async (page: Page) => {
  await page.getByTestId('tablet-rail-chores').click();
  await expect(page.getByTestId('tablet-view-chores')).toBeVisible();
};

const pick = async (page: Page, uid: string) => {
  await expect(page.getByTestId('who-is-here')).toBeVisible();
  await page.getByTestId(`who-person-${uid}`).click();
};

test.beforeAll(async () => {
  await prepareHousehold();
  await householdRef.update({ devicePolicy: { pointsPin: 'off' } });
});

test.afterAll(async () => {
  await tablet?.context.close();
  await removeEveryTablet();
  await Promise.all(seeded.map((id) => chore(id).delete().catch(() => undefined)));
  await householdRef.update({ devicePolicy: FieldValue.delete() }).catch(() => undefined);
  await restoreHousehold();
});

test('setup: the owner sets a tablet PIN and pairs a tablet at 1263x818', async ({ page, browser }, testInfo) => {
  desktopOnly(testInfo);
  test.setTimeout(90_000);
  await setOwnerPin(page);
  const code = await createDeviceCode(page, 'Chores tablet', 'Kitchen');
  tablet = await openTabletContext(browser, TABLET_VIEWPORTS[0]);
  await pairWithCode(tabletPage(), code);
});

test('a face-chosen kid completes a chore and gets the credit; Undo puts it back', async ({}, testInfo) => {
  desktopOnly(testInfo);
  await seedChore('tablet-credit');
  const page = tabletPage();
  await openChores(page);
  await page.getByTestId('tablet-chore-done-tablet-credit').click();
  await pick(page, KID.uid);
  await expect.poll(async () => (await chore('tablet-credit').get()).get('completedByUid'), { timeout: 15_000 }).toBe(KID.uid);
  const stored = (await chore('tablet-credit').get()).data()!;
  expect(stored.deviceAttribution?.actorUid).toBe(KID.uid);
  expect(stored.deviceAttribution?.level).toBe('face');
  // Undo within the 10 s window.
  await page.getByTestId('tablet-undo').first().click();
  await expect.poll(async () => (await chore('tablet-credit').get()).get('isCompleted'), { timeout: 15_000 }).toBe(false);
  expect((await chore('tablet-credit').get()).get('deviceAttribution')).toBeUndefined();
});

test('Take: an unassigned chore becomes the chosen person\'s', async ({}, testInfo) => {
  desktopOnly(testInfo);
  await seedChore('tablet-take');
  const page = tabletPage();
  await openChores(page);
  await page.getByTestId('tablet-chore-take-tablet-take').click();
  // The face memory from the previous action may still hold the kid; either way the take is credited to someone.
  if (await page.getByTestId('who-is-here').isVisible().catch(() => false)) await pick(page, KID.uid);
  await expect.poll(async () => (await chore('tablet-take').get()).get('assignedToUid'), { timeout: 15_000 }).toBe(KID.uid);
});

test('with the points PIN set to Everyone, a completion asks for the person\'s PIN', async ({}, testInfo) => {
  desktopOnly(testInfo);
  await householdRef.update({ devicePolicy: { pointsPin: 'everyone' } });
  await seedChore('tablet-pin');
  const page = tabletPage();
  // "Done" forgets the remembered person.
  await page.getByTestId('tablet-done').click().catch(() => undefined);
  await openChores(page);
  await page.getByTestId('tablet-chore-done-tablet-pin').click();
  await pick(page, OWNER_UID);
  await expect(page.getByTestId('pin-pad')).toBeVisible();
  await enterPin(page, OWNER_PIN);
  await expect.poll(async () => (await chore('tablet-pin').get()).get('completedByUid'), { timeout: 15_000 }).toBe(OWNER_UID);
  expect((await chore('tablet-pin').get()).get('deviceAttribution')?.level).toBe('pin');
  await householdRef.update({ devicePolicy: { pointsPin: 'off' } });
});

test('offline: the completion waits on the tablet and syncs once when the connection is back', async ({}, testInfo) => {
  desktopOnly(testInfo);
  await seedChore('tablet-offline');
  const page = tabletPage();
  await page.getByTestId('tablet-done').click().catch(() => undefined);
  await openChores(page);
  await tablet!.context.setOffline(true);
  await page.getByTestId('tablet-chore-done-tablet-offline').click();
  await pick(page, KID.uid);
  await expect(page.getByText('Saved on this tablet. It syncs when the connection is back.').first()).toBeVisible();
  expect((await chore('tablet-offline').get()).get('isCompleted')).toBe(false);
  await tablet!.context.setOffline(false);
  await expect.poll(async () => (await chore('tablet-offline').get()).get('isCompleted'), { timeout: 45_000 }).toBe(true);
  const stored = (await chore('tablet-offline').get()).data()!;
  expect(stored.completedByUid).toBe(KID.uid);
  // One completion, one ledger entry under the queued opId.
  const ops = await householdRef.collection('devices').get();
  const entries = (await Promise.all(ops.docs.map((d) => d.ref.collection('ops').where('targetPath', '==', chore('tablet-offline').path).get()))).flatMap((q) => q.docs);
  expect(entries).toHaveLength(1);
  expect(entries[0].id).toBe(stored.completionId);
  expect(entries[0].get('deviceCreatedAt')).toBeTruthy();
});
