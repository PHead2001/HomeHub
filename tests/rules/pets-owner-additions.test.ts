/**
 * P5 against the Firestore emulator with the real rules: notes (PE-29, D-P11),
 * weights (PE-28b), the pet's name, vet contact and weight unit (PE-30, PE-28a,
 * PE-28d), the server-only pet delete (D-P12), and the real client operations
 * (`runCreateNote`, `runCreateWeight`, `runEditNote`, `runSetNotePinned`,
 * `runCreatePet`, `runUpdatePet`) for one add = one record, two sessions,
 * stale edits and renames that keep the id.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, deleteField, doc, getDoc, getDocs, serverTimestamp, setDoc, Timestamp, updateDoc, type Firestore } from 'firebase/firestore';
import { newRecordOpId } from '../../src/lib/pets/notes';
import { NoteChangedError, RecordIdTakenError, runCreateNote, runCreateWeight, runEditNote, runSetNotePinned } from '../../src/lib/pets/record-transaction';
import { runCreatePet, runUpdatePet, type PetProfileFields } from '../../src/lib/pets/profile-transaction';
import { DuplicatePetNameError, newPetId } from '../../src/lib/pets/profile';

const projectId = 'demo-homehub-e2e';
const household = 'household-p5';
const otherHousehold = 'household-p5-b';
let environment: RulesTestEnvironment;

const people = {
  owner: { uid: 'p5-owner', email: 'owner.p5@example.test', role: 'owner' },
  admin: { uid: 'p5-admin', email: 'admin.p5@example.test', role: 'admin' },
  sam: { uid: 'p5-sam', email: 'sam.p5@example.test', role: 'member' },
  kim: { uid: 'p5-kim', email: 'kim.p5@example.test', role: 'member' },
  // A member who may edit profiles but not delete logs (a custom permission).
  editor: { uid: 'p5-editor', email: 'editor.p5@example.test', role: 'member', permissions: { 'pets.editProfiles': true } },
  alex: { uid: 'p5-alex', email: 'alex.p5@example.test', role: 'child' },
  guest: { uid: 'p5-guest', email: 'guest.p5@example.test', role: 'guest' },
  ownerB: { uid: 'p5-owner-b', email: 'owner.b.p5@example.test', role: 'owner' },
} as const;
type Person = (typeof people)[keyof typeof people];

const sessions = new Map<string, Firestore>();
const session = (person: Person): Firestore => {
  if (!sessions.has(person.uid)) sessions.set(person.uid, environment.authenticatedContext(person.uid, { email: person.email }).firestore() as unknown as Firestore);
  return sessions.get(person.uid)!;
};
/** A second device of the same member (its own Firestore instance). */
const secondDevice = (person: Person) => environment.authenticatedContext(person.uid, { email: person.email }).firestore() as unknown as Firestore;
const anonymous = () => environment.unauthenticatedContext().firestore() as unknown as Firestore;

const petRef = (db: Firestore, pet = 'rex', home = household) => doc(db, 'households', home, 'pets', pet);
const noteRef = (db: Firestore, id: string, pet = 'rex', home = household) => doc(db, 'households', home, 'pets', pet, 'notes', id);
const weightRef = (db: Firestore, id: string, pet = 'rex', home = household) => doc(db, 'households', home, 'pets', pet, 'weights', id);

const entry = (person: Person, overrides: Record<string, unknown> = {}) => ({
  text: 'Barked at the mail carrier', tag: 'behaviour', pinned: false, date: new Date(), loggedAt: serverTimestamp(),
  loggedByUid: person.uid, loggedByName: 'Someone', ...overrides,
});
const pinnedNote = (person: Person, overrides: Record<string, unknown> = {}) => entry(person, { text: 'Allergic to chicken', tag: 'health', pinned: true, pinnedAt: serverTimestamp(), ...overrides });
const weighing = (person: Person, overrides: Record<string, unknown> = {}) => ({
  value: 4.2, unit: 'kg', date: new Date(), loggedAt: serverTimestamp(), loggedByUid: person.uid, loggedByName: 'Someone', ...overrides,
});

async function admin(work: (db: Firestore) => Promise<unknown>) {
  await environment.withSecurityRulesDisabled(async (context) => { await work(context.firestore() as unknown as Firestore); });
}
async function count(path: string[]): Promise<number> {
  let size = 0;
  await admin(async (db) => { size = (await getDocs(collection(db, path[0], ...path.slice(1)))).size; });
  return size;
}

before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync(process.env.HOMEHUB_FIRESTORE_RULES ?? 'firestore.rules', 'utf8') },
  });
});

beforeEach(async () => {
  sessions.clear();
  await environment.clearFirestore();
  await admin(async (db) => {
    await setDoc(doc(db, 'households', household), { name: 'P5', ownerUid: people.owner.uid, timeZone: 'America/Chicago' });
    await setDoc(doc(db, 'households', otherHousehold), { name: 'Other', ownerUid: people.ownerB.uid });
    for (const person of Object.values(people)) {
      const home = person === people.ownerB ? otherHousehold : household;
      await setDoc(doc(db, 'households', home, 'members', person.uid), {
        uid: person.uid, role: person.role, status: 'active', ...('permissions' in person ? { permissions: person.permissions } : {}),
      });
    }
    await setDoc(petRef(db), { name: 'Rex', type: 'Dog', foodSchedule: 'twice daily', photoUrl: '' });
    await setDoc(petRef(db, 'maple'), { name: 'Maple', type: 'Cat', foodSchedule: 'once', photoUrl: '' });
    await setDoc(petRef(db, 'max', otherHousehold), { name: 'Max', type: 'Dog', foodSchedule: 'once', photoUrl: '' });
  });
});

after(async () => environment?.cleanup());

describe('notes: create (PE-29f)', () => {
  test('members who may log create pinned notes and entries; others are refused', async () => {
    await assertSucceeds(setDoc(noteRef(session(people.sam), 'n1'), entry(people.sam)));
    await assertSucceeds(setDoc(noteRef(session(people.alex), 'n2'), pinnedNote(people.alex)));
    await assertSucceeds(setDoc(noteRef(session(people.sam), 'n3'), entry(people.sam, { tag: 'vet' })));
    // Wrong role (guest: pets.view only), signed out, another household.
    await assertFails(setDoc(noteRef(session(people.guest), 'g1'), entry(people.guest)));
    await assertFails(setDoc(noteRef(anonymous(), 'a1'), entry(people.sam)));
    await assertFails(setDoc(noteRef(session(people.ownerB), 'b1'), entry(people.ownerB)));
    await assertSucceeds(setDoc(noteRef(session(people.ownerB), 'b2', 'max', otherHousehold), entry(people.ownerB)));
    // Everyone with pets.view reads; another household does not.
    await assertSucceeds(getDoc(noteRef(session(people.guest), 'n1')));
    await assertFails(getDoc(noteRef(session(people.ownerB), 'n1')));
  });

  test('forged author, server time, future date, shape and a missing pet are refused', async () => {
    const db = session(people.sam);
    await assertFails(setDoc(noteRef(db, 'f1'), entry(people.sam, { loggedByUid: people.kim.uid })));
    await assertFails(setDoc(noteRef(db, 'f2'), entry(people.sam, { loggedAt: Timestamp.fromDate(new Date(Date.now() - 60_000)) })));
    await assertFails(setDoc(noteRef(db, 'f3'), entry(people.sam, { date: new Date(Date.now() + 60 * 60_000) }))); // an hour ahead
    await assertSucceeds(setDoc(noteRef(db, 'f4'), entry(people.sam, { date: new Date(Date.now() + 2 * 60_000) }))); // a device clock a little ahead
    await assertSucceeds(setDoc(noteRef(db, 'f5'), entry(people.sam, { date: new Date('2026-01-02T12:00:00Z') }))); // an earlier day
    await assertFails(setDoc(noteRef(db, 'f6'), entry(people.sam, { text: '   ' })));
    await assertFails(setDoc(noteRef(db, 'f7'), entry(people.sam, { text: 'x'.repeat(501) })));
    await assertFails(setDoc(noteRef(db, 'f8'), entry(people.sam, { tag: 'diet' })));
    await assertFails(setDoc(noteRef(db, 'f9'), entry(people.sam, { mood: 'happy' })));
    await assertFails(setDoc(noteRef(db, 'f10'), entry(people.sam, { pinnedAt: serverTimestamp() }))); // an entry has no pin time
    const noPinTime: Record<string, unknown> = { ...pinnedNote(people.sam) };
    delete noPinTime.pinnedAt;
    await assertFails(setDoc(noteRef(db, 'f11'), noPinTime)); // a pinned note needs its pin time
    await assertFails(setDoc(noteRef(db, 'f12', 'ghost'), entry(people.sam))); // no notes under a pet that does not exist
  });

  test('a reused id is refused (one add, one note)', async () => {
    const db = session(people.sam);
    await assertSucceeds(setDoc(noteRef(db, 'same'), entry(people.sam)));
    await assertFails(setDoc(noteRef(db, 'same'), entry(people.sam)));
    await assertFails(setDoc(noteRef(db, 'same'), entry(people.sam, { text: 'Something else' })));
    await assertFails(setDoc(noteRef(session(people.kim), 'same'), entry(people.kim)));
  });
});

describe('notes: edit, pin and delete (D-P11)', () => {
  beforeEach(async () => {
    await setDoc(noteRef(session(people.sam), 'mine'), entry(people.sam));
    await setDoc(noteRef(session(people.sam), 'fact'), pinnedNote(people.sam));
  });
  const edited = (person: Person, text: string) => ({ text, editedAt: serverTimestamp(), editedByUid: person.uid, editedByName: 'Someone' });

  test('the author or pets.editProfiles edits; others, forged editors and unstamped edits are refused', async () => {
    await assertSucceeds(updateDoc(noteRef(session(people.sam), 'mine'), edited(people.sam, 'Calmer after a walk')));
    await assertSucceeds(updateDoc(noteRef(session(people.editor), 'mine'), edited(people.editor, 'Calm')));
    await assertFails(updateDoc(noteRef(session(people.kim), 'mine'), edited(people.kim, 'Mine now')));
    await assertFails(updateDoc(noteRef(session(people.guest), 'mine'), edited(people.guest, 'Nope')));
    await assertFails(updateDoc(noteRef(session(people.ownerB), 'mine'), edited(people.ownerB, 'Nope')));
    await assertFails(updateDoc(noteRef(session(people.sam), 'mine'), { text: 'No stamp' }));
    await assertFails(updateDoc(noteRef(session(people.sam), 'mine'), { ...edited(people.sam, 'x'), editedByUid: people.kim.uid }));
    await assertFails(updateDoc(noteRef(session(people.sam), 'mine'), { ...edited(people.sam, 'x'), loggedByUid: people.kim.uid }));
    await assertFails(updateDoc(noteRef(session(people.sam), 'mine'), { ...edited(people.sam, 'x'), date: new Date(0) }));
    await assertFails(updateDoc(noteRef(session(people.sam), 'mine'), edited(people.sam, '')));
  });

  test('pin, move first and unpin stamp the pin time; a stale pin time is refused', async () => {
    await assertSucceeds(updateDoc(noteRef(session(people.sam), 'mine'), { pinned: true, pinnedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(noteRef(session(people.editor), 'mine'), { pinned: true, pinnedAt: serverTimestamp() })); // move first
    await assertFails(updateDoc(noteRef(session(people.sam), 'mine'), { pinned: true, pinnedAt: Timestamp.fromDate(new Date(0)) }));
    await assertFails(updateDoc(noteRef(session(people.sam), 'mine'), { pinned: false })); // unpinning keeps no pin time
    await assertSucceeds(updateDoc(noteRef(session(people.sam), 'mine'), { pinned: false, pinnedAt: deleteField() }));
    await assertFails(updateDoc(noteRef(session(people.kim), 'fact'), { pinned: false, pinnedAt: deleteField() }));
  });

  test('delete: pets.deleteLogs, the author within 10 minutes, pets.editProfiles for a pinned note', async () => {
    await admin(async (db) => {
      await setDoc(noteRef(db, 'old'), { ...entry(people.sam), loggedAt: Timestamp.fromDate(new Date(Date.now() - 11 * 60_000)), date: new Date() });
      await setDoc(noteRef(db, 'old-fact'), { ...pinnedNote(people.sam), loggedAt: Timestamp.fromDate(new Date(Date.now() - 11 * 60_000)), pinnedAt: Timestamp.now(), date: new Date() });
    });
    await assertFails(deleteDoc(noteRef(session(people.kim), 'mine'))); // not the author
    await assertFails(deleteDoc(noteRef(session(people.editor), 'mine'))); // an entry is a log, not profile data
    await assertSucceeds(deleteDoc(noteRef(session(people.sam), 'mine'))); // the author, just written
    await assertFails(deleteDoc(noteRef(session(people.sam), 'old'))); // the author after 10 minutes
    await assertSucceeds(deleteDoc(noteRef(session(people.editor), 'old-fact'))); // a pinned note by pets.editProfiles
    await assertFails(deleteDoc(noteRef(session(people.ownerB), 'old')));
    await assertSucceeds(deleteDoc(noteRef(session(people.owner), 'old'))); // pets.deleteLogs
  });
});

describe('weights (PE-28b, PE-28d)', () => {
  test('create: positive, wrong role, other household, forged author, future time, bounds', async () => {
    await assertSucceeds(setDoc(weightRef(session(people.sam), 'w1'), weighing(people.sam)));
    await assertSucceeds(setDoc(weightRef(session(people.alex), 'w2'), weighing(people.alex, { value: 1000, unit: 'lb' })));
    await assertFails(setDoc(weightRef(session(people.guest), 'w3'), weighing(people.guest)));
    await assertFails(setDoc(weightRef(anonymous(), 'w3'), weighing(people.sam)));
    await assertFails(setDoc(weightRef(session(people.ownerB), 'w3'), weighing(people.ownerB)));
    await assertFails(setDoc(weightRef(session(people.sam), 'w4'), weighing(people.sam, { loggedByUid: people.kim.uid })));
    await assertFails(setDoc(weightRef(session(people.sam), 'w5'), weighing(people.sam, { date: new Date(Date.now() + 60 * 60_000) })));
    await assertFails(setDoc(weightRef(session(people.sam), 'w6'), weighing(people.sam, { value: 0 })));
    await assertFails(setDoc(weightRef(session(people.sam), 'w7'), weighing(people.sam, { value: 501 })));
    await assertFails(setDoc(weightRef(session(people.sam), 'w8'), weighing(people.sam, { unit: 'stone' })));
    await assertFails(setDoc(weightRef(session(people.sam), 'w9'), weighing(people.sam, { value: '4' })));
    await assertFails(setDoc(weightRef(session(people.sam), 'w10'), weighing(people.sam, { note: 'x' })));
    await assertFails(setDoc(weightRef(session(people.sam), 'w11', 'ghost'), weighing(people.sam)));
    await assertSucceeds(getDoc(weightRef(session(people.guest), 'w1')));
    await assertFails(getDoc(weightRef(session(people.ownerB), 'w1')));
  });

  test('a reused id and any update are refused; delete by the author within 10 minutes or pets.deleteLogs', async () => {
    await setDoc(weightRef(session(people.sam), 'w1'), weighing(people.sam));
    await assertFails(setDoc(weightRef(session(people.sam), 'w1'), weighing(people.sam)));
    await assertFails(updateDoc(weightRef(session(people.sam), 'w1'), { value: 5 }));
    await assertFails(deleteDoc(weightRef(session(people.kim), 'w1')));
    await assertSucceeds(deleteDoc(weightRef(session(people.sam), 'w1')));
    await admin(async (db) => setDoc(weightRef(db, 'old'), { ...weighing(people.sam), loggedAt: Timestamp.fromDate(new Date(Date.now() - 11 * 60_000)) }));
    await assertFails(deleteDoc(weightRef(session(people.sam), 'old')));
    await assertSucceeds(deleteDoc(weightRef(session(people.admin), 'old')));
  });
});

describe('pet profile: rename, vet contact, weight unit, delete (PE-30, PE-28a, D-P12)', () => {
  test('a rename changes only the name; blank, long, removed names and non-editors are refused', async () => {
    await assertSucceeds(updateDoc(petRef(session(people.admin)), { name: 'Biscuit' }));
    await assertFails(updateDoc(petRef(session(people.sam)), { name: 'Sam’s dog' })); // no pets.editProfiles
    await assertFails(updateDoc(petRef(session(people.ownerB)), { name: 'Mine' }));
    await assertFails(updateDoc(petRef(session(people.admin)), { name: '  ' }));
    await assertFails(updateDoc(petRef(session(people.admin)), { name: 'x'.repeat(41) }));
    await assertFails(updateDoc(petRef(session(people.admin)), { name: deleteField() }));
    await assertFails(setDoc(petRef(session(people.admin), 'nameless'), { type: 'Dog', foodSchedule: 'once', photoUrl: '' }));
    // A legacy name over the limit stays editable when unchanged.
    await admin(async (db) => updateDoc(petRef(db), { name: 'L'.repeat(60) }));
    await assertSucceeds(updateDoc(petRef(session(people.admin)), { foodSchedule: 'three times' }));
  });

  test('vet contact and weight unit are validated; clearing removes them', async () => {
    const db = session(people.editor);
    await assertSucceeds(updateDoc(petRef(db), { vetName: 'Dr. Rivera', vetClinic: 'Riverside', vetPhone: '+1 (512) 555-0134', weightUnit: 'lb' }));
    await assertSucceeds(updateDoc(petRef(db), { vetName: deleteField(), vetPhone: deleteField() }));
    await assertFails(updateDoc(petRef(db), { vetPhone: 'call me' }));
    await assertFails(updateDoc(petRef(db), { vetPhone: '1'.repeat(31) }));
    await assertFails(updateDoc(petRef(db), { vetClinic: 'x'.repeat(81) }));
    await assertFails(updateDoc(petRef(db), { vetName: '' }));
    await assertFails(updateDoc(petRef(db), { weightUnit: 'stone' }));
    await assertFails(updateDoc(petRef(session(people.sam)), { vetName: 'Dr. Who' })); // no pets.editProfiles
    await assertSucceeds(setDoc(petRef(db, 'new-pet'), { name: 'New', type: 'Dog', foodSchedule: 'once', photoUrl: '', vetPhone: '512 555 0134', weightUnit: 'kg' }));
    await assertFails(setDoc(petRef(db, 'bad-pet'), { name: 'Bad', type: 'Dog', foodSchedule: 'once', photoUrl: '', vetPhone: 'x' }));
  });

  test('a client can no longer delete a pet (the server action does, with everything under it)', async () => {
    await assertFails(deleteDoc(petRef(session(people.owner))));
    await assertFails(deleteDoc(petRef(session(people.editor))));
    // The server's deletion tombstones are not readable or writable by clients.
    await assertFails(getDoc(doc(session(people.owner), 'households', household, 'pet-deletions', 'rex')));
    await assertFails(setDoc(doc(session(people.owner), 'households', household, 'pet-deletions', 'rex'), { petId: 'rex' }));
  });

  test('care entries need an existing pet (nothing lands under a deleted pet)', async () => {
    const care = { date: new Date().toISOString(), activity: 'Walk', notes: '', loggedByUid: people.sam.uid, loggedByName: 'Sam' };
    await assertSucceeds(setDoc(doc(session(people.sam), 'households', household, 'pets', 'rex', 'care-logs', 'c1'), care));
    await assertFails(setDoc(doc(session(people.sam), 'households', household, 'pets', 'ghost', 'care-logs', 'c1'), care));
  });
});

describe('the real client operations on the emulator', () => {
  const author = { uid: people.sam.uid, name: 'Sam' };

  test('one add is one note: a retry replays, two sessions at once write once, a foreign id is refused', async () => {
    const opId = newRecordOpId();
    const input = { householdId: household, petId: 'rex', opId, draft: { text: 'Chewed a shoe', tag: 'behaviour' as const, pinned: false, day: '' }, author, date: new Date() };
    const [first, second] = await Promise.all([runCreateNote(session(people.sam), input), runCreateNote(secondDevice(people.sam), input)]);
    assert.deepEqual([first, second].sort(), ['replayed', 'saved']);
    assert.equal(await runCreateNote(secondDevice(people.sam), input), 'replayed', 'a retry after an uncertain answer');
    assert.equal(await count(['households', household, 'pets', 'rex', 'notes']), 1);
    await assert.rejects(runCreateNote(session(people.kim), { ...input, author: { uid: people.kim.uid, name: 'Kim' } }), RecordIdTakenError);
    const pinned = await runCreateNote(session(people.sam), { ...input, opId: newRecordOpId(), draft: { text: 'Microchip 985', tag: '', pinned: true, day: '' } });
    assert.equal(pinned, 'saved');
    assert.equal(await count(['households', household, 'pets', 'rex', 'notes']), 2);
  });

  test('one add is one weight, also from two sessions', async () => {
    const input = { householdId: household, petId: 'rex', opId: newRecordOpId(), value: 9.5, unit: 'lb' as const, date: new Date(), author };
    const results = await Promise.all([runCreateWeight(session(people.sam), input), runCreateWeight(secondDevice(people.sam), input)]);
    assert.deepEqual(results.sort(), ['replayed', 'saved']);
    assert.equal(await runCreateWeight(session(people.sam), input), 'replayed');
    assert.equal(await count(['households', household, 'pets', 'rex', 'weights']), 1);
    await assert.rejects(runCreateWeight(session(people.sam), { ...input, opId: newRecordOpId(), value: 2000 }));
  });

  test('an edit bound to a stale version writes nothing; pin and unpin are idempotent', async () => {
    const opId = newRecordOpId();
    await runCreateNote(session(people.sam), { householdId: household, petId: 'rex', opId, draft: { text: 'Shy with guests', tag: '', pinned: false, day: '' }, author, date: new Date() });
    const base = { householdId: household, petId: 'rex', noteId: opId };
    await runEditNote(session(people.editor), { ...base, expected: { text: 'Shy with guests', tag: null }, text: 'Shy with new guests', tag: 'behaviour', editor: { uid: people.editor.uid, name: 'Ed' } });
    await assert.rejects(
      runEditNote(session(people.sam), { ...base, expected: { text: 'Shy with guests', tag: null }, text: 'Very shy', tag: null, editor: author }),
      (error: unknown) => error instanceof NoteChangedError && !error.gone,
    );
    let stored: Record<string, unknown> = {};
    await admin(async (db) => { stored = (await getDoc(noteRef(db, opId))).data()!; });
    assert.equal(stored.text, 'Shy with new guests');
    assert.equal(stored.editedByUid, people.editor.uid);
    await runSetNotePinned(session(people.sam), { ...base, pinned: true });
    await runSetNotePinned(session(people.sam), { ...base, pinned: false });
    await runSetNotePinned(session(people.sam), { ...base, pinned: false });
    await admin(async (db) => { stored = (await getDoc(noteRef(db, opId))).data()!; });
    assert.equal(stored.pinned, false);
    assert.equal('pinnedAt' in stored, false);
  });

  const fields = (name: string, extra: Partial<PetProfileFields> = {}): PetProfileFields => ({
    name, type: 'Dog', dataAiHint: 'dog', foodSchedule: 'twice daily', feedingsPerDay: null, portionAmount: null, portionUnit: null, slots: null, ...extra,
  });

  test('a rename keeps the id and every history; a duplicate name is refused', async () => {
    await runCreateNote(session(people.sam), { householdId: household, petId: 'rex', opId: newRecordOpId(), draft: { text: 'Loves walks', tag: '', pinned: false, day: '' }, author, date: new Date() });
    await admin(async (db) => setDoc(doc(db, 'households', household, 'pets', 'rex', 'feeding-logs', 'f1'), { date: new Date(), cups: 1, foodType: 'Dry' }));
    const result = await runUpdatePet(session(people.admin), { householdId: household, petId: 'rex', fields: fields('Biscuit', { vetPhone: '512 555 0134', weightUnit: 'lb' }), photoUrl: null, originalName: 'Rex' });
    assert.equal(result.replacedPhotoUrl, null);
    let pet: Record<string, unknown> = {};
    await admin(async (db) => { pet = (await getDoc(petRef(db))).data()!; });
    assert.equal(pet.name, 'Biscuit');
    assert.equal(pet.vetPhone, '512 555 0134');
    assert.equal(await count(['households', household, 'pets', 'rex', 'notes']), 1, 'notes stay attached');
    assert.equal(await count(['households', household, 'pets', 'rex', 'feeding-logs']), 1, 'feedings stay attached');
    await assert.rejects(
      runUpdatePet(session(people.admin), { householdId: household, petId: 'rex', fields: fields('maple'), photoUrl: null, originalName: 'Biscuit' }),
      DuplicatePetNameError,
    );
    // The pet's own name in another case is not a duplicate.
    await runUpdatePet(session(people.admin), { householdId: household, petId: 'rex', fields: fields('BISCUIT'), photoUrl: null, originalName: 'Biscuit' });
  });

  test('a photo change returns the URL it replaced (read in the transaction)', async () => {
    await admin(async (db) => updateDoc(petRef(db), { photoUrl: 'https://example.test/old.jpg' }));
    const result = await runUpdatePet(session(people.admin), { householdId: household, petId: 'rex', fields: fields('Rex'), photoUrl: 'https://example.test/new.jpg', originalName: 'Rex' });
    assert.equal(result.replacedPhotoUrl, 'https://example.test/old.jpg');
    const removed = await runUpdatePet(session(people.admin), { householdId: household, petId: 'rex', fields: fields('Rex'), photoUrl: '', originalName: 'Rex' });
    assert.equal(removed.replacedPhotoUrl, 'https://example.test/new.jpg');
  });

  test('a new pet gets a non-name id once per dialog: a double submit writes one pet; two pets may not share a name', async () => {
    const petId = newPetId();
    await Promise.all([
      runCreatePet(session(people.admin), { householdId: household, petId, fields: fields('Pepper'), photoUrl: '' }),
      runCreatePet(secondDevice(people.admin), { householdId: household, petId, fields: fields('Pepper'), photoUrl: '' }),
    ]);
    assert.equal(await count(['households', household, 'pets']), 3);
    let pet: Record<string, unknown> = {};
    await admin(async (db) => { pet = (await getDoc(petRef(db, petId))).data()!; });
    assert.equal(pet.photoUrl, '', 'no external placeholder');
    await assert.rejects(runCreatePet(session(people.admin), { householdId: household, petId: newPetId(), fields: fields('pepper'), photoUrl: '' }), DuplicatePetNameError);
  });
});
