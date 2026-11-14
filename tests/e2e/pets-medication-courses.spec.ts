import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { Timestamp, getFirestore } from 'firebase-admin/firestore';

/*
 * Medication courses (P3: PE-24, PE-27, D-P7, D-P8) on the seeded e2e household
 * (time zone: the server default, America/Chicago). Doses carry the emulator's
 * server time, so these tests run at the real time; the seeded course gives a
 * dose every two hours, so a scheduled dose is always within an hour of now.
 * Every test removes the courses and doses it wrote.
 */

const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const ownerUid = 'e2e-owner-uid';
const baseURL = 'http://127.0.0.1:9002';
const TZ = 'America/Chicago';
const adminApp = getApps().find((app) => app.name === 'pets-medication-courses') || initializeApp({ projectId }, 'pets-medication-courses');
const household = getFirestore(adminApp).collection('households').doc(householdId);

const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');
const COURSE_ID = 'e2e-course-apoquel';
const SEEDED_LOGS = new Set(['flea-prevention']);

/** The household (Chicago) day, offset by `days`. */
function chicagoDay(days = 0): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(Date.now() + days * 86_400_000));
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Seeds an active course on Maple, as a member would have saved it. */
async function seedCourse(overrides: Record<string, unknown> = {}) {
  await household.collection('pets').doc('maple').collection('medication-courses').doc(COURSE_ID).set({
    name: 'Apoquel',
    dosage: '1 tablet',
    schedule: { kind: 'hours', everyHours: 2, firstTime: '00:00' },
    startDay: chicagoDay(-2),
    endDay: null,
    status: 'active',
    legacyKeys: [],
    lastDose: null,
    prevDose: null,
    coveredUntil: null,
    createdAt: Timestamp.now(),
    createdByUid: ownerUid,
    createdByName: 'Alex',
    updatedAt: Timestamp.now(),
    updatedByUid: ownerUid,
    updatedByName: 'Alex',
    ...overrides,
  });
}

async function courseDoses(petId = 'maple') {
  const logs = await household.collection('pets').doc(petId).collection('medication-logs').get();
  return logs.docs.filter((entry) => entry.get('courseId')).map((entry) => ({ id: entry.id, ...entry.data() }));
}

async function courseDoc(id = COURSE_ID, petId = 'maple') {
  return (await household.collection('pets').doc(petId).collection('medication-courses').doc(id).get()).data();
}

/** Removes every course and every dose these tests wrote (the seeded legacy entry stays). */
async function restore() {
  for (const petId of ['maple', 'pixel']) {
    const pet = household.collection('pets').doc(petId);
    const [logs, courses] = await Promise.all([pet.collection('medication-logs').get(), pet.collection('medication-courses').get()]);
    await Promise.all([
      ...logs.docs.filter((entry) => !SEEDED_LOGS.has(entry.id)).map((entry) => entry.ref.delete()),
      ...courses.docs.map((entry) => entry.ref.delete()),
    ]);
  }
}

async function openMedicationTab(page: Page, petId = 'maple', query = '') {
  await page.goto(`/pets/${petId}?tab=medication${query}`);
  await expect(page.getByRole('tab', { name: /Medication/ })).toHaveAttribute('data-state', 'active');
}

const giveDoseDialog = (page: Page) => page.getByTestId('give-dose-dialog');
/** The toast list (Radix also repeats each toast's text in a live region, so page-wide text matches twice). */
const toasts = (page: Page) => page.getByRole('region', { name: /^Notifications/ });
const toastText = (page: Page, text: string) => toasts(page).getByText(text, { exact: true });
/** A toast in the Notifications region by its title (as chores-ux.spec.ts finds one). */
const toastItem = (page: Page, title: string) => toasts(page).getByRole('status').filter({ hasText: title });

async function openContext(browser: Browser, viewport: { width: number; height: number }) {
  const context = await browser.newContext({ baseURL, viewport, hasTouch: true, reducedMotion: 'reduce', storageState: 'playwright/.auth/e2e-owner.json' });
  return { context, page: await context.newPage() };
}

test.describe('pets: medication courses (P3)', () => {
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.project.name === 'desktop-chromium') await restore();
  });

  test('a member creates a twice-daily course; the preview and the stored schedule come only from what was entered (PE-27a)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openMedicationTab(page);
    await page.getByRole('button', { name: 'New course' }).click();
    const dialog = page.getByTestId('course-form-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Medication').fill('Carprofen');
    await dialog.getByLabel('Dosage').fill('25 mg');
    await dialog.getByText('Set times of day').click();
    await dialog.getByLabel('Every how many days').fill('1');
    await dialog.getByLabel('Dose time 1', { exact: true }).fill('08:00');
    await dialog.getByRole('button', { name: 'Add a time' }).click();
    await dialog.getByLabel('Dose time 2', { exact: true }).fill('20:00');
    await expect(dialog.getByTestId('course-preview')).toContainText('Every day at 8:00 AM and 8:00 PM');
    await dialog.getByRole('button', { name: 'Add course' }).click();
    await expect(dialog).toBeHidden();

    const row = page.getByTestId('medication-course').filter({ hasText: 'Carprofen' });
    await expect(row).toContainText('Every day at 8:00 AM and 8:00 PM');
    await expect(row.getByRole('button', { name: 'Give dose' })).toBeVisible();
    const courses = await household.collection('pets').doc('maple').collection('medication-courses').where('name', '==', 'Carprofen').get();
    expect(courses.size).toBe(1);
    const course = courses.docs[0].data();
    expect(course.schedule).toEqual({ kind: 'days', everyDays: 1, times: ['08:00', '20:00'] });
    expect(course.status).toBe('active');
    expect(course.createdByUid).toBe(ownerUid);
    // A second active course with the same name is refused (typo protection, PE-4c).
    await page.getByRole('button', { name: 'New course' }).click();
    await dialog.getByLabel('Medication').fill(' carprofen ');
    await dialog.getByLabel('Dosage').fill('25 mg');
    await dialog.getByRole('button', { name: 'Add course' }).click();
    await expect(dialog).toContainText('already has an active course');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('Give dose from the Medication tab is prefilled from the plan, records once, and asks before a repeat (PE-24b/c/j/k)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await seedCourse();
    await openMedicationTab(page);
    const row = page.getByTestId('medication-course').filter({ hasText: 'Apoquel' });
    await row.getByRole('button', { name: 'Give dose' }).click();
    const dialog = giveDoseDialog(page);
    await expect(dialog.getByRole('heading', { name: 'Give Apoquel' })).toBeVisible();
    // Prefilled from the saved plan: the dosage, one scheduled time chosen, the next dose read-only.
    await expect(dialog).toContainText('1 tablet');
    await expect(dialog.getByTestId('last-dose')).toHaveText('No dose recorded yet.');
    await expect(dialog.getByRole('radio', { checked: true })).toHaveCount(2); // the dose time and "Just now"
    await expect(dialog.getByTestId('next-after')).toContainText('(from the schedule)');
    await dialog.getByRole('button', { name: 'Record dose' }).click();
    await expect(dialog).toBeHidden();
    await expect(toastText(page, 'Apoquel recorded')).toBeVisible();
    await expect.poll(async () => (await courseDoses()).length).toBe(1);
    const [dose] = await courseDoses();
    expect(dose).toMatchObject({ courseId: COURSE_ID, medication: 'Apoquel', dosage: '1 tablet', repeat: 'none', loggedByUid: ownerUid });
    expect(typeof (dose as { occurrence?: unknown }).occurrence).toBe('string');
    await expect.poll(async () => (await courseDoc())?.lastDose?.logId).toBe(dose.id);

    // Opening Give dose again right after: the given time is prefilled, so recording asks first.
    await row.getByRole('button', { name: 'Give dose' }).click();
    await expect(dialog.getByTestId('last-dose')).toContainText('Last given');
    await expect(dialog.getByTestId('last-dose')).toContainText('by you');
    await dialog.getByRole('button', { name: 'Record dose' }).click();
    const again = dialog.getByTestId('dose-again');
    await expect(again).toContainText('Already given?');
    await expect(again).toContainText('You recorded');
    await again.getByRole('button', { name: "Don't record" }).click();
    await expect(dialog).toBeHidden();
    expect((await courseDoses()).length).toBe(1);

    // Answering "Record again" records exactly one more, bound to the dose it named.
    await row.getByRole('button', { name: 'Give dose' }).click();
    await dialog.getByRole('button', { name: 'Record dose' }).click();
    await dialog.getByTestId('dose-again').getByRole('button', { name: 'Record again' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await courseDoses()).length).toBe(2);
    const repeat = (await courseDoses()).find((entry) => entry.id !== dose.id)!;
    expect(repeat).toMatchObject({ repeat: 'confirmed', confirmOf: dose.id });
  });

  test("Undo removes the dose record (never claims the dose was undone) and restores the course's latest dose (PE-24l)", async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await seedCourse();
    await openMedicationTab(page);
    await page.getByTestId('medication-course').filter({ hasText: 'Apoquel' }).getByRole('button', { name: 'Give dose' }).click();
    await giveDoseDialog(page).getByRole('button', { name: 'Record dose' }).click();
    await expect.poll(async () => (await courseDoses()).length).toBe(1);
    await toastItem(page, 'Apoquel recorded').getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(toastText(page, 'Dose record removed')).toBeVisible();
    await expect(toastText(page, 'Only the record is removed. If the dose was given, it still counts.')).toBeVisible();
    await expect.poll(async () => (await courseDoses()).length).toBe(0);
    await expect.poll(async () => (await courseDoc())?.lastDose ?? null).toBeNull();
  });

  test('Give dose from the pet card chip and from a reminder deep link opens prefilled (PE-24b, PE-24i)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await seedCourse();
    // The card chip is a button that opens Give dose for its course.
    await page.goto('/pets');
    await expect(page.getByRole('heading', { name: 'Your Pets', exact: true })).toBeVisible();
    const chip = page.getByTestId('pet-card-maple').getByRole('button', { name: /^Give Apoquel, / });
    await expect(chip).toBeVisible();
    await chip.click();
    const dialog = giveDoseDialog(page);
    await expect(dialog.getByRole('heading', { name: 'Give Apoquel' })).toBeVisible();
    await expect(dialog).toContainText('1 tablet');
    await expect(page).toHaveURL(/\/pets$/);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect((await courseDoses()).length).toBe(0);

    // A reminder's link: the Medication tab with Give dose open; `dose` leaves the URL once handled.
    await openMedicationTab(page, 'maple', `&dose=${COURSE_ID}`);
    await expect(dialog.getByRole('heading', { name: 'Give Apoquel' })).toBeVisible();
    await expect(page).not.toHaveURL(/dose=/);
    await dialog.getByRole('button', { name: 'Record dose' }).click();
    await expect.poll(async () => (await courseDoses()).length).toBe(1);
  });

  test('Finish course ends the countdown and keeps the history; Undo brings it back (PE-24f)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await seedCourse();
    await openMedicationTab(page);
    const row = page.getByTestId('medication-course').filter({ hasText: 'Apoquel' });
    await row.getByRole('button', { name: 'Give dose' }).click();
    await giveDoseDialog(page).getByRole('button', { name: 'Record dose' }).click();
    await expect.poll(async () => (await courseDoses()).length).toBe(1);

    await row.getByRole('button', { name: 'Give dose' }).click();
    const dialog = giveDoseDialog(page);
    await dialog.getByRole('button', { name: 'Finish course' }).click();
    await expect(dialog.getByRole('heading', { name: 'Finish Apoquel?' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Finish course' }).click();
    await expect(toastText(page, 'Apoquel finished')).toBeVisible();
    await expect(row).toHaveCount(0);
    await expect(page.getByText('Finished courses (1)', { exact: true })).toBeVisible();
    await expect.poll(async () => (await courseDoc())?.status).toBe('finished');
    expect((await courseDoses()).length).toBe(1);
    await expect(page.getByTestId('medication-entry').filter({ hasText: 'Apoquel' })).toHaveCount(1);

    await toastItem(page, 'Apoquel finished').getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await courseDoc())?.status).toBe('active');
    await expect(page.getByTestId('medication-course').filter({ hasText: 'Apoquel' })).toBeVisible();
  });

  test('a legacy medication keeps counting down until its schedule is confirmed in the card (D-P8)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    // Two legacy doses 30 days apart, each with a next due date 30 days on: consistent history.
    const logs = household.collection('pets').doc('maple').collection('medication-logs');
    const due = chicagoDay(3);
    const dayBefore = (offset: number) => new Date(Date.parse(`${due}T17:00:00Z`) - offset * 86_400_000).toISOString();
    await logs.doc('e2e-legacy-1').set({ date: dayBefore(60), medication: 'Heartworm', dosage: '1 chew', notes: '', nextDueDate: new Date(Date.parse(`${due}T12:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10) });
    await logs.doc('e2e-legacy-2').set({ date: dayBefore(30), medication: 'Heartworm', dosage: '1 chew', notes: '', nextDueDate: due });

    await openMedicationTab(page);
    const card = page.getByTestId('legacy-medication-card').filter({ hasText: 'Heartworm' });
    await expect(card).toContainText('every 30 days (a suggestion to check)');
    // Nothing was converted: no course exists yet, and the legacy countdown still shows.
    expect((await household.collection('pets').doc('maple').collection('medication-courses').get()).size).toBe(0);
    await card.getByRole('button', { name: 'Confirm schedule' }).click();
    const dialog = page.getByTestId('course-form-dialog');
    await expect(dialog.getByTestId('legacy-suggestion')).toContainText('Suggested from what was entered before');
    await expect(dialog.getByTestId('course-preview')).toContainText('Every 30 days');
    await dialog.getByRole('button', { name: 'Confirm schedule' }).click();
    await expect(dialog).toBeHidden();
    await expect(card).toHaveCount(0);

    const courses = await household.collection('pets').doc('maple').collection('medication-courses').get();
    expect(courses.size).toBe(1);
    const course = courses.docs[0].data();
    expect(course).toMatchObject({ name: 'Heartworm', legacyKeys: ['heartworm'], startDay: due, schedule: { kind: 'days', everyDays: 30, times: [] } });
    await expect(page.getByTestId('medication-course').filter({ hasText: 'Heartworm' })).toContainText('Due in 3 days');
    // The legacy entries stay as history.
    await expect(page.getByTestId('medication-entry').filter({ hasText: 'Heartworm' })).toHaveCount(2);
  });

  test('phone (390 x 844): Give dose fits, its controls are 48 px on touch, and the reminder link lands on the tab (PE-13d)', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    await seedCourse();
    const { context, page } = await openContext(browser, { width: 390, height: 844 });
    try {
      await openMedicationTab(page, 'maple', `&dose=${COURSE_ID}`);
      const dialog = giveDoseDialog(page);
      await expect(dialog.getByRole('heading', { name: 'Give Apoquel' })).toBeVisible();
      const box = await dialog.boundingBox();
      expect(box!.width).toBeLessThanOrEqual(390);
      for (const name of ['Record dose', 'Cancel', 'Finish course']) {
        const control = await dialog.getByRole('button', { name }).boundingBox();
        expect(control!.height, name).toBeGreaterThanOrEqual(44);
      }
      const option = await dialog.getByRole('radio').first().locator('xpath=ancestor::label').boundingBox();
      expect(option!.height).toBeGreaterThanOrEqual(48);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      // The Medication tab content is on screen after the deep link.
      const tabs = await page.getByRole('tablist').boundingBox();
      expect(tabs!.y).toBeLessThan(844);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    } finally {
      await context.close();
    }
  });

  test('wall tablet (1263 x 818): course chips are 48 px buttons and Give dose fits the screen', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    await seedCourse();
    const { context, page } = await openContext(browser, { width: 1263, height: 818 });
    try {
      await page.goto('/pets');
      await expect(page.getByRole('heading', { name: 'Your Pets', exact: true })).toBeVisible();
      const chip = page.getByTestId('pet-card-maple').getByRole('button', { name: /^Give Apoquel, / });
      const chipBox = await chip.boundingBox();
      expect(chipBox!.height).toBeGreaterThanOrEqual(48);
      expect(chipBox!.y + chipBox!.height).toBeLessThanOrEqual(818);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await chip.click();
      const dialog = giveDoseDialog(page);
      await expect(dialog.getByRole('heading', { name: 'Give Apoquel' })).toBeVisible();
      const box = await dialog.boundingBox();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(818);
      const record = await dialog.getByRole('button', { name: 'Record dose' }).boundingBox();
      expect(record!.height).toBeGreaterThanOrEqual(48);
      await dialog.getByRole('button', { name: 'Record dose' }).click();
      await expect.poll(async () => (await courseDoses()).length).toBe(1);
    } finally {
      await context.close();
    }
  });
});
