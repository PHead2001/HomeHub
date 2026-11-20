import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { Timestamp, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

/*
 * P5 owner additions and quality on the seeded e2e household: notes (PE-29),
 * vet contact and weight (PE-28), rename keeping the id (PE-30), the server
 * delete cascade (D-P12), photo downscale into the pet's folder (PE-21e/f),
 * history pagination (PE-21h), and the phone (390 x 844) and wall tablet
 * (1263 x 818) layouts. Every test works on its own pet, removed afterwards.
 */

const projectId = 'demo-homehub-e2e';
const householdId = 'the-foxy-residence-e2e';
const ownerUid = 'e2e-owner-uid';
const baseURL = 'http://127.0.0.1:9002';
const adminApp = getApps().find((app) => app.name === 'pets-owner-additions')
  || initializeApp({ projectId, storageBucket: `${projectId}.appspot.com` }, 'pets-owner-additions');
const db = getFirestore(adminApp);
const household = db.collection('households').doc(householdId);
const bucket = getStorage(adminApp).bucket();

const PET = 'pet-e2eP5OwnerAdditionsA';
const petRef = () => household.collection('pets').doc(PET);
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');

async function seedPet(overrides: Record<string, unknown> = {}) {
  await petRef().set({ name: 'Biscuit', type: 'Dog', photoUrl: '', dataAiHint: 'dog', foodSchedule: '1 cup twice daily', ...overrides });
}

async function removePet(petId = PET) {
  await db.recursiveDelete(household.collection('pets').doc(petId));
  await bucket.deleteFiles({ prefix: `households/${householdId}/pets/${petId}/` }).catch(() => undefined);
}

async function openPet(page: Page, tab?: string) {
  await page.goto(`/pets/${PET}${tab ? `?tab=${tab}` : ''}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

async function openEdit(page: Page, name: string) {
  await page.getByRole('button', { name: `Open actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: `Edit ${name}` });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openContext(browser: Browser, viewport: { width: number; height: number }) {
  const context = await browser.newContext({ baseURL, viewport, hasTouch: true, reducedMotion: 'reduce', storageState: 'playwright/.auth/e2e-owner.json' });
  return { context, page: await context.newPage() };
}

/** PNG width and height from the IHDR chunk. */
const pngSize = (bytes: Buffer) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });

test.describe('pets: owner additions and quality (P5)', () => {
  test.beforeEach(async ({}, testInfo) => {
    if (testInfo.project.name === 'desktop-chromium') await seedPet();
  });
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.project.name === 'desktop-chromium') await removePet();
  });

  test('notes: pin a fact (shown on the card), add a tagged behaviour entry, unpin (PE-29a-d)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openPet(page, 'notes');
    await expect(page.getByRole('tab', { name: /Notes/ })).toHaveAttribute('data-state', 'active');
    await page.getByRole('button', { name: 'Pin a note' }).click();
    await page.getByLabel('Fact to pin').fill('Allergic to chicken');
    await page.getByRole('button', { name: 'Pin note' }).click();
    const pinned = page.getByTestId('pinned-notes');
    await expect(pinned).toContainText('Allergic to chicken');
    await expect(page.getByTestId(`pinned-note-${PET}`)).toContainText('Allergic to chicken');

    await page.getByRole('button', { name: 'Add entry' }).click();
    await page.getByLabel('What happened').fill('Barked at the mail carrier');
    await page.getByLabel('Tag').click();
    await page.getByRole('option', { name: 'Behaviour' }).click();
    await page.getByRole('button', { name: 'Add entry' }).last().click();
    const log = page.getByRole('region', { name: 'Behaviour log' }).or(page.locator(`section[aria-labelledby="behaviour-log-${PET}"]`));
    await expect(log).toContainText('Barked at the mail carrier');
    await expect(log).toContainText('Behaviour');
    await expect(log).toContainText('by ');

    const notes = await petRef().collection('notes').get();
    expect(notes.size).toBe(2);
    const fact = notes.docs.find((entry) => entry.get('pinned') === true)!;
    expect(fact.get('loggedByUid')).toBe(ownerUid);
    expect(fact.get('pinnedAt')).toBeTruthy();

    // The card on /pets shows the pinned line too.
    await page.goto('/pets');
    await expect(page.getByTestId(`pet-card-${PET}`).getByTestId(`pinned-note-${PET}`)).toContainText('Allergic to chicken');

    // Unpin: the fact moves to the log and leaves the card.
    await openPet(page, 'notes');
    await page.getByRole('button', { name: 'Unpin "Allergic to chicken"' }).click();
    await expect(page.getByText('Nothing pinned yet.', { exact: false })).toBeVisible();
    await expect(page.getByTestId(`pinned-note-${PET}`)).toHaveCount(0);
    await expect.poll(async () => (await petRef().collection('notes').doc(fact.id).get()).get('pinned')).toBe(false);
  });

  test('vet contact is saved with the pet and calls through a tel: link (PE-28a)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openPet(page);
    await expect(page.getByTestId('vet-contact')).toContainText('No vet saved.');
    const dialog = await openEdit(page, 'Biscuit');
    await dialog.getByLabel('Clinic').fill('Riverside Animal Hospital');
    await dialog.getByLabel('Veterinarian').fill('Dr. Rivera');
    await dialog.getByLabel('Phone').fill('call me');
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(dialog.getByText('Use digits, spaces, brackets or dashes', { exact: false })).toBeVisible();
    await dialog.getByLabel('Phone').fill('(512) 555-0134');
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(dialog).toBeHidden();
    const vet = page.getByTestId('vet-contact');
    await expect(vet).toContainText('Riverside Animal Hospital');
    await expect(vet).toContainText('Dr. Rivera');
    await expect(vet.getByRole('link', { name: /Call Riverside Animal Hospital/ })).toHaveAttribute('href', 'tel:5125550134');
    const stored = (await petRef().get()).data()!;
    expect(stored.vetPhone).toBe('(512) 555-0134');
  });

  test('a weight entry is logged once and the trend reads in words in the pet unit (PE-28b/c)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await petRef().collection('weights').doc('older').set({
      value: 4, unit: 'kg', date: Timestamp.fromDate(new Date(Date.now() - 20 * 86_400_000)), loggedAt: Timestamp.now(), loggedByUid: ownerUid, loggedByName: 'Alex',
    });
    await openPet(page);
    const card = page.getByTestId('weight-card');
    await expect(card.getByTestId('weight-trend')).toContainText('First weighing');
    await card.getByRole('button', { name: 'Log weight' }).click();
    await card.getByLabel('Weight', { exact: true }).fill('4.5');
    await card.getByRole('button', { name: 'Save weight' }).click();
    await expect(card.getByTestId('weight-trend')).toContainText('4.5 kg');
    await expect(card.getByTestId('weight-trend')).toContainText(/Up 0\.5 kg since/);
    expect((await petRef().collection('weights').get()).size).toBe(2);
    // An entry logged in pounds is converted to the pet's unit.
    await card.getByRole('button', { name: 'Log weight' }).click();
    await card.getByLabel('Weight', { exact: true }).fill('11');
    await card.getByRole('combobox', { name: 'Weight unit' }).click();
    await page.getByRole('option', { name: 'lb' }).click();
    await card.getByRole('button', { name: 'Save weight' }).click();
    await expect(card).toContainText('(logged as 11 lb)');
    await expect(card.getByTestId('weight-trend')).toContainText('4.99 kg');
  });

  test('a rename keeps the id and the history; another pet\'s name is refused (PE-30a-c)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await petRef().collection('care-logs').doc('walk').set({ date: new Date().toISOString(), activity: 'Long walk', notes: '', loggedByUid: ownerUid, loggedByName: 'Alex' });
    await openPet(page, 'care');
    await expect(page.getByText('Long walk')).toBeVisible();
    const dialog = await openEdit(page, 'Biscuit');
    await dialog.getByLabel('Name').fill('maple');
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(dialog.getByText('You already have a pet named maple.')).toBeVisible();
    await dialog.getByLabel('Name').fill('Biscotti');
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: 'Biscotti' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/pets/${PET}`));
    await expect(page.getByText('Long walk')).toBeVisible();
    expect((await petRef().get()).get('name')).toBe('Biscotti');
    expect((await household.collection('pets').where('name', '==', 'Biscotti').get()).docs.map((entry) => entry.id)).toEqual([PET]);
    // The list and the dashboard index read the new name by the same id.
    await page.goto('/pets');
    await expect(page.getByTestId(`pet-card-${PET}`)).toContainText('Biscotti');
  });

  test('deleting a pet asks first, then removes it with everything under it on the server (D-P12)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await petRef().collection('care-logs').doc('walk').set({ date: new Date().toISOString(), activity: 'Walk', notes: '' });
    await petRef().collection('notes').doc('n1').set({ text: 'Shy', pinned: true });
    await petRef().collection('weights').doc('w1').set({ value: 4, unit: 'kg' });
    await petRef().collection('medication-courses').doc('c1').set({ name: 'Apoquel' });
    await bucket.file(`households/${householdId}/pets/${PET}/old.png`).save(Buffer.from('x'), { contentType: 'image/png' });
    await openPet(page);
    await page.getByRole('button', { name: 'Open actions for Biscuit' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Delete Biscuit?' });
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    expect((await petRef().get()).exists).toBe(true);
    await page.getByRole('button', { name: 'Open actions for Biscuit' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('alertdialog', { name: 'Delete Biscuit?' }).getByRole('button', { name: 'Delete Pet' }).click();
    await expect(page).toHaveURL(/\/pets$/);
    await expect(page.getByText('Pet deleted', { exact: true })).toBeVisible();
    await expect.poll(async () => (await petRef().get()).exists).toBe(false);
    for (const name of ['care-logs', 'notes', 'weights', 'medication-courses']) {
      await expect.poll(async () => (await petRef().collection(name).get()).size, name).toBe(0);
    }
    await expect.poll(async () => (await bucket.file(`households/${householdId}/pets/${PET}/old.png`).exists())[0]).toBe(false);
    const audit = await household.collection('auditLogs').where('action', '==', 'pet.deleted').get();
    expect(audit.docs.some((entry) => entry.get('details')?.petId === PET)).toBe(true);
    await Promise.all(audit.docs.filter((entry) => entry.get('details')?.petId === PET).map((entry) => entry.ref.delete()));
  });

  test('a large photo is shrunk to 1024 px before upload, into the pet\'s own folder; the replaced one is removed (PE-21e/f)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const oldPath = `households/${householdId}/pets/${PET}/old.png`;
    await bucket.file(oldPath).save(Buffer.from('old photo'), { contentType: 'image/png' });
    await petRef().update({ photoUrl: `http://127.0.0.1:9199/v0/b/${bucket.name}/o/${encodeURIComponent(oldPath)}?alt=media` });
    await openPet(page);
    // A 3000 x 2000 PNG made in the page.
    const base64 = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 3000;
      canvas.height = 2000;
      const context = canvas.getContext('2d')!;
      const gradient = context.createLinearGradient(0, 0, 3000, 2000);
      gradient.addColorStop(0, '#c0392b');
      gradient.addColorStop(1, '#2980b9');
      context.fillStyle = gradient;
      context.fillRect(0, 0, 3000, 2000);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    const dialog = await openEdit(page, 'Biscuit');
    await dialog.locator('input[type="file"]').setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') });
    await expect(dialog.getByText('Shrinking the photo…')).toBeHidden();
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => String((await petRef().get()).get('photoUrl'))).toContain(encodeURIComponent(`households/${householdId}/pets/${PET}/`));
    const [files] = await bucket.getFiles({ prefix: `households/${householdId}/pets/${PET}/` });
    const uploaded = files.filter((file) => file.name !== oldPath);
    expect(uploaded).toHaveLength(1);
    const [bytes] = await uploaded[0].download();
    expect(pngSize(bytes)).toEqual({ width: 1024, height: 683 });
    expect(bytes.length).toBeLessThanOrEqual(5 * 1024 * 1024);
    await expect.poll(async () => (await bucket.file(oldPath).exists())[0]).toBe(false);
  });

  test('histories page with Load more and keep what is shown (PE-21h)', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const batch = db.batch();
    for (let index = 0; index < 30; index += 1) {
      batch.set(petRef().collection('care-logs').doc(`c${String(index).padStart(2, '0')}`), {
        date: new Date(Date.now() - index * 3_600_000).toISOString(), activity: `Walk ${index}`, notes: '',
      });
    }
    await batch.commit();
    await openPet(page, 'care');
    const history = page.locator(`section[aria-labelledby="care-history-${PET}"]`);
    await expect(history.getByText(/^Walk \d+$/)).toHaveCount(25);
    await history.getByRole('button', { name: 'Load more care entries' }).click();
    await expect(history.getByText(/^Walk \d+$/)).toHaveCount(30);
    await expect(history.getByRole('button', { name: 'Load more care entries' })).toHaveCount(0);
  });

  test('phone (390 x 844): tabs in two rows, Notes, vet and weight fit without sideways scroll; 48 px touch targets', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    await petRef().update({ vetClinic: 'Riverside', vetPhone: '512 555 0134' });
    const { context, page } = await openContext(browser, { width: 390, height: 844 });
    try {
      await openPet(page, 'notes');
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      const tabs = page.getByRole('tab');
      await expect(tabs).toHaveCount(4);
      for (const tab of await tabs.all()) expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      for (const name of ['Pin a note', 'Add entry', 'Log weight']) {
        const box = await page.getByRole('button', { name, exact: true }).first().boundingBox();
        expect(box!.height, name).toBeGreaterThanOrEqual(48);
        expect(box!.x + box!.width, name).toBeLessThanOrEqual(390);
      }
      const call = await page.getByTestId('vet-contact').getByRole('link').boundingBox();
      expect(call!.height).toBeGreaterThanOrEqual(48);
    } finally {
      await context.close();
    }
  });

  test('wall tablet (1263 x 818): the card shows the pinned line; the pet page has four tabs in one row and fits the width', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    await petRef().collection('notes').doc('fact').set({
      text: 'Microchip 985 112 000 123 456', pinned: true, pinnedAt: Timestamp.now(), date: Timestamp.now(), loggedAt: Timestamp.now(), loggedByUid: ownerUid, loggedByName: 'Alex',
    });
    const { context, page } = await openContext(browser, { width: 1263, height: 818 });
    try {
      await page.goto('/pets');
      await expect(page.getByTestId(`pet-card-${PET}`).getByTestId(`pinned-note-${PET}`)).toContainText('Microchip');
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await openPet(page);
      const boxes = await Promise.all((await page.getByRole('tab').all()).map((tab) => tab.boundingBox()));
      expect(new Set(boxes.map((box) => Math.round(box!.y))).size, 'one row').toBe(1);
      for (const box of boxes) expect(box!.height).toBeGreaterThanOrEqual(48);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    } finally {
      await context.close();
    }
  });
});
