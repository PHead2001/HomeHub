import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

// Shared by the registered-tablet journeys (devices-pairing.spec.ts, devices-shell.spec.ts;
// docs/modules/devices/README.md). Not a spec. Admin writes stand in only for setup the
// UI cannot do here (the ops scrub of legacy email fields, a kid profile record, a
// tablet's idle settings); every journey itself runs through the real screens.

export const baseURL = 'http://127.0.0.1:9002';
export const projectId = 'demo-homehub-e2e';
export const householdId = 'the-foxy-residence-e2e';
export const OWNER_PIN = '2580';
export const KID = { uid: 'kid_E2eKidProfile000000', name: 'Mia Kid' };
/** The measured wall-tablet viewports (installed web app first). */
export const TABLET_VIEWPORTS = [
  { width: 1263, height: 818 },
  { width: 1263, height: 722 },
  { width: 1264, height: 843 },
] as const;

const adminApp = getApps().find((app) => app.name === 'devices-e2e') || initializeApp({ projectId }, 'devices-e2e');
export const firestore = getFirestore(adminApp);
export const householdRef = firestore.doc(`households/${householdId}`);

let legacy: { ownerEmail?: unknown; memberEmails?: unknown } | null = null;

/**
 * Pairing refuses a household still carrying the legacy email copies (JC-8): the e2e
 * seed has them, so the journeys do what `scrub-shared-emails.mjs` does, and put them
 * back afterwards for the other specs.
 */
export async function prepareHousehold() {
  const snapshot = await householdRef.get();
  legacy = { ownerEmail: snapshot.get('ownerEmail'), memberEmails: snapshot.get('memberEmails') };
  await householdRef.update({ ownerEmail: FieldValue.delete(), memberEmails: FieldValue.delete() });
  await householdRef.collection('members').doc(KID.uid).set({
    uid: KID.uid, kind: 'identity', role: 'child', status: 'active', displayName: KID.name, avatarUrl: null, permissions: {},
    joinedAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z', createdByUid: 'e2e-owner-uid',
  });
}

export async function restoreHousehold() {
  await householdRef.collection('members').doc(KID.uid).delete().catch(() => undefined);
  if (legacy) {
    await householdRef.update({
      ...(legacy.ownerEmail !== undefined ? { ownerEmail: legacy.ownerEmail } : {}),
      ...(legacy.memberEmails !== undefined ? { memberEmails: legacy.memberEmails } : {}),
      quietHours: FieldValue.delete(),
    });
  }
}

export async function deviceRecord(deviceId: string) {
  return (await householdRef.collection('devices').doc(deviceId).get()).data() ?? null;
}

/** Sets the owner's tablet PIN through Profile > Tablet PIN (the real screen). */
export async function setOwnerPin(ownerPage: Page, pin = OWNER_PIN) {
  await ownerPage.goto('/profile');
  await expect(ownerPage.getByText('Tablet PIN', { exact: true }).first()).toBeVisible();
  const start = ownerPage.getByRole('button', { name: /^(Set a PIN|Change PIN)$/ });
  await start.click();
  await ownerPage.getByLabel('New PIN (4 to 6 digits)').fill(pin);
  await ownerPage.getByLabel('Type it again').fill(pin);
  await ownerPage.getByRole('button', { name: 'Save PIN' }).click();
  await expect(ownerPage.getByText('Your PIN is set.')).toBeVisible();
}

/** Creates a device code from Household > Devices and returns it (the dialog stays open). */
export async function createDeviceCode(ownerPage: Page, name: string, room: string): Promise<string> {
  await ownerPage.goto('/household?tab=devices');
  await ownerPage.getByRole('button', { name: 'Add a wall tablet' }).click();
  await ownerPage.getByLabel('Tablet name').fill(name);
  await ownerPage.getByLabel('Room').fill(room);
  await ownerPage.getByRole('button', { name: 'Create code' }).click();
  const code = ownerPage.getByText(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{2}$/);
  await expect(code).toBeVisible();
  return (await code.textContent())!.trim();
}

/** A signed-out touch browser at the tablet's size, with Playwright's clock installed (idle timers). */
export async function openTabletContext(browser: Browser, viewport: { width: number; height: number } = TABLET_VIEWPORTS[0]): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL, viewport, hasTouch: true, reducedMotion: 'reduce', storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.clock.install();
  return { context, page };
}

/** Types the code on the real setup screen and waits for the tablet shell. Returns the new device id. */
export async function pairWithCode(page: Page, code: string): Promise<string> {
  await page.goto('/setup');
  await page.getByLabel('Tablet code').fill(code);
  await page.getByRole('button', { name: 'Set up this tablet' }).click();
  await expect(page.getByTestId('tablet-shell')).toBeVisible({ timeout: 30_000 });
  const devices = await householdRef.collection('devices').where('status', '==', 'active').get();
  const used = await firestore.collection('deviceCodes').doc(code).get();
  const deviceId = used.get('usedByDeviceId') as string | undefined;
  expect(deviceId, 'the code names the tablet it paired').toBeTruthy();
  expect(devices.docs.some((d) => d.id === deviceId)).toBe(true);
  return deviceId!;
}

/** Taps a person in "Who's here?" and types a PIN on the pad. */
export async function enterPin(page: Page, pin: string) {
  for (const digit of pin) await page.getByTestId(`pin-key-${digit}`).click();
  await page.getByTestId('pin-key-ok').click();
}

export async function removeEveryTablet() {
  const devices = await householdRef.collection('devices').get();
  await Promise.all(devices.docs.map((d) => d.ref.update({ status: 'removed', generation: (d.get('generation') ?? 1) + 1 })));
}
