import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { Timestamp, deleteDoc, doc, getDoc, setDoc } from 'firebase/firestore';
import { deleteObject, ref, uploadBytes } from 'firebase/storage';

// MA-16/MA-30: the scoped receipt rule. A member with maintenance.createLogs but not
// maintenance.edit may attach a receipt, invoice or photo to a log THEY created through the
// server (doneByUid, createdAtServer) within 30 minutes; nothing broader. Also: the
// maintenance-deletions tombstones are server-only (MA-22).
const projectId = 'demo-homehub-e2e';
const HOUSE = 'receipt-rules-house';
let environment: RulesTestEnvironment;

type Identity = { uid: string; email: string };
const users = {
  editor: { uid: 'rr-editor', email: 'rr.editor@example.test' },
  logger: { uid: 'rr-logger', email: 'rr.logger@example.test' },
  otherLogger: { uid: 'rr-logger-2', email: 'rr.logger2@example.test' },
  guest: { uid: 'rr-guest', email: 'rr.guest@example.test' },
} satisfies Record<string, Identity>;

const firestoreFor = (user: Identity) => environment.authenticatedContext(user.uid, { email: user.email }).firestore();
const storageFor = (user: Identity) => environment.authenticatedContext(user.uid, { email: user.email }).storage();
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

const minutesAgo = (minutes: number) => Timestamp.fromDate(new Date(Date.now() - minutes * 60_000));

before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync(process.env.HOMEHUB_FIRESTORE_RULES ?? 'firestore.rules', 'utf8') },
    storage: { rules: readFileSync(process.env.HOMEHUB_STORAGE_RULES ?? 'storage.rules', 'utf8') },
  });
  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'households', HOUSE), { name: 'Receipts', ownerUid: 'nobody', memberEmails: [] });
    await setDoc(doc(db, 'households', HOUSE, 'members', users.editor.uid), { ...users.editor, role: 'member', status: 'active' });
    // A member whose owner turned editing off: may still create logs.
    for (const user of [users.logger, users.otherLogger]) {
      await setDoc(doc(db, 'households', HOUSE, 'members', user.uid), { ...user, role: 'member', status: 'active', permissions: { 'maintenance.edit': false } });
    }
    await setDoc(doc(db, 'households', HOUSE, 'members', users.guest.uid), { ...users.guest, role: 'guest', status: 'active' });
    const log = (id: string, extra: Record<string, unknown>) => setDoc(doc(db, 'households', HOUSE, 'maintenance', id), {
      householdId: HOUSE, targetType: 'general', title: id, date: '2026-11-24', ...extra,
    });
    await log('own-new', { doneByUid: users.logger.uid, doneByName: 'Lou', createdAtServer: minutesAgo(2) });
    await log('own-old', { doneByUid: users.logger.uid, doneByName: 'Lou', createdAtServer: minutesAgo(45) });
    await log('someone-elses', { doneByUid: users.otherLogger.uid, doneByName: 'Ola', createdAtServer: minutesAgo(2) });
    // A quick log from the command palette: no server attribution.
    await log('palette', { createdAt: new Date().toISOString() });
    await setDoc(doc(db, 'households', HOUSE, 'home-assets', 'fridge'), { householdId: HOUSE, name: 'Fridge', category: 'Appliance', status: 'active' });
  });
});

after(async () => {
  await environment?.cleanup();
});

const metadata = (user: Identity, targetType: string, targetId: string, extra: Record<string, unknown> = {}) => ({
  householdId: HOUSE,
  targetType,
  targetId,
  category: 'receipt',
  fileName: 'r.jpg',
  filePath: `households/${HOUSE}/maintenance/${targetType}/${targetId}/1-r.jpg`,
  uploadedByUid: user.uid,
  uploadedByName: 'Member',
  createdAt: new Date().toISOString(),
  ...extra,
});
const attach = (user: Identity, id: string, data: Record<string, unknown>) =>
  setDoc(doc(firestoreFor(user), 'households', HOUSE, 'maintenance-attachments', id), data);

describe('attachment metadata: the scoped receipt rule (firestore.rules)', () => {
  test("a log-only member attaches a receipt, invoice or photo to their own new log", async () => {
    await assertSucceeds(attach(users.logger, 'a1', metadata(users.logger, 'maintenance_log', 'own-new')));
    await assertSucceeds(attach(users.logger, 'a2', metadata(users.logger, 'maintenance_log', 'own-new', { category: 'invoice' })));
    await assertSucceeds(attach(users.logger, 'a3', metadata(users.logger, 'maintenance_log', 'own-new', { category: 'photo' })));
  });

  test('never broader: other categories, older logs, other people, palette logs, assets, forged uploader', async () => {
    await assertFails(attach(users.logger, 'b1', metadata(users.logger, 'maintenance_log', 'own-new', { category: 'manual' })));
    await assertFails(attach(users.logger, 'b2', metadata(users.logger, 'maintenance_log', 'own-old')));
    await assertFails(attach(users.logger, 'b3', metadata(users.logger, 'maintenance_log', 'someone-elses')));
    await assertFails(attach(users.logger, 'b4', metadata(users.logger, 'maintenance_log', 'palette')));
    await assertFails(attach(users.logger, 'b5', metadata(users.logger, 'home_asset', 'fridge', { category: 'photo' })));
    await assertFails(attach(users.logger, 'b6', metadata(users.otherLogger, 'maintenance_log', 'someone-elses')));
    await assertFails(attach(users.logger, 'b7', metadata(users.logger, 'maintenance_log', 'missing-log')));
    await assertFails(attach(users.guest, 'b8', metadata(users.guest, 'maintenance_log', 'own-new')));
  });

  test('a log-only member cannot delete attachment metadata (no maintenance.delete)', async () => {
    await assertFails(deleteDoc(doc(firestoreFor(users.logger), 'households', HOUSE, 'maintenance-attachments', 'a1')));
  });

  test('maintenance.edit keeps attaching anything to any existing record', async () => {
    await assertSucceeds(attach(users.editor, 'c1', metadata(users.editor, 'maintenance_log', 'own-old', { category: 'manual' })));
    await assertSucceeds(attach(users.editor, 'c2', metadata(users.editor, 'home_asset', 'fridge', { category: 'photo' })));
  });

  test('delete tombstones are server-only', async () => {
    await assertFails(getDoc(doc(firestoreFor(users.editor), 'households', HOUSE, 'maintenance-deletions', 'home_asset~fridge')));
    await assertFails(setDoc(doc(firestoreFor(users.editor), 'households', HOUSE, 'maintenance-deletions', 'home_asset~fridge'), { targetType: 'home_asset' }));
  });
});

describe('attachment files: the scoped receipt rule (storage.rules)', () => {
  const path = (targetType: string, targetId: string, name = '1-r.jpg') => `households/${HOUSE}/maintenance/${targetType}/${targetId}/${name}`;
  const upload = (user: Identity, objectPath: string, meta: { contentType: string; customMetadata?: Record<string, string> }) =>
    uploadBytes(ref(storageFor(user), objectPath), jpeg, meta);
  const own = (user: Identity) => ({ contentType: 'image/jpeg', customMetadata: { uploadedByUid: user.uid } });

  test('a log-only member uploads to their own new log, with their uid in the object metadata', async () => {
    await assertSucceeds(upload(users.logger, path('maintenance_log', 'own-new'), own(users.logger)));
    await assertSucceeds(upload(users.logger, path('maintenance_log', 'own-new', '1-r-thumb.jpg'), own(users.logger)));
  });

  test('never broader: no uploader metadata, older or other logs, palette logs, assets, wrong types', async () => {
    await assertFails(upload(users.logger, path('maintenance_log', 'own-new', '2.jpg'), { contentType: 'image/jpeg' }));
    await assertFails(upload(users.logger, path('maintenance_log', 'own-new', '3.jpg'), { contentType: 'image/jpeg', customMetadata: { uploadedByUid: users.otherLogger.uid } }));
    await assertFails(upload(users.logger, path('maintenance_log', 'own-old'), own(users.logger)));
    await assertFails(upload(users.logger, path('maintenance_log', 'someone-elses'), own(users.logger)));
    await assertFails(upload(users.logger, path('maintenance_log', 'palette'), own(users.logger)));
    await assertFails(upload(users.logger, path('home_asset', 'fridge'), own(users.logger)));
    await assertFails(upload(users.logger, path('maintenance_log', 'own-new', '4.html'), { contentType: 'text/html', customMetadata: { uploadedByUid: users.logger.uid } }));
    await assertFails(upload(users.guest, path('maintenance_log', 'own-new', '5.jpg'), own(users.guest)));
  });

  test('a log-only member cannot delete files (the server cleans up their orphaned uploads)', async () => {
    await assertFails(deleteObject(ref(storageFor(users.logger), path('maintenance_log', 'own-new'))));
  });

  test('maintenance.edit uploads as before (with or without the uploader metadata)', async () => {
    await assertSucceeds(upload(users.editor, path('home_asset', 'fridge', 'p.jpg'), { contentType: 'image/jpeg' }));
    await assertSucceeds(upload(users.editor, path('maintenance_log', 'own-old', 'p.jpg'), own(users.editor)));
  });
});
