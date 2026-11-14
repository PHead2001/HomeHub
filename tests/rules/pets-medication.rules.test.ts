/**
 * Medication courses and dose logs under the real rules (P3): who may create,
 * edit, finish and resume a course; a dose paired with the course's pointer,
 * signed by the writer at server time, never in the future, never over an
 * existing id, and asking before repeating a covered occurrence; removing a
 * dose only with the pointer moved; legacy 2.1 entries still accepted (D-P8).
 */
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteDoc, doc, serverTimestamp, setDoc, Timestamp, updateDoc, writeBatch, type Firestore } from 'firebase/firestore';

const projectId = 'demo-homehub-e2e';
const house = 'household-meds';
const otherHouse = 'household-meds-other';
let environment: RulesTestEnvironment;

const people = {
  owner: { uid: 'med-owner', email: 'owner.med@example.test', role: 'owner' },
  member: { uid: 'med-member', email: 'member.med@example.test', role: 'member' },
  child: { uid: 'med-child', email: 'child.med@example.test', role: 'child' },
  guest: { uid: 'med-guest', email: 'guest.med@example.test', role: 'guest' },
  outsider: { uid: 'med-outsider', email: 'outsider.med@example.test', role: 'owner' },
} as const;
type Person = (typeof people)[keyof typeof people];

const session = (person: Person) => environment.authenticatedContext(person.uid, { email: person.email }).firestore() as unknown as Firestore;
const courseRef = (db: Firestore, id = 'apoquel', household = house) => doc(db, 'households', household, 'pets', 'rex', 'medication-courses', id);
const logRef = (db: Firestore, id: string, household = house) => doc(db, 'households', household, 'pets', 'rex', 'medication-logs', id);

const SCHEDULE = { kind: 'days', everyDays: 1, times: ['08:00', '20:00'] };
const dayKey = (date: Date) => date.toISOString().slice(0, 10);
// Occurrences in the recent past / near future (the rules only bound them; the planner picks them).
const occurrenceAt = (offsetHours: number) => Timestamp.fromMillis(Math.floor((Date.now() + offsetHours * 3_600_000) / 60_000) * 60_000);
const occurrenceKey = (ts: Timestamp) => `${dayKey(ts.toDate())}T${ts.toDate().toISOString().slice(11, 16)}`;

const newCourse = (person: Person, overrides: Record<string, unknown> = {}) => ({
  name: 'Apoquel', dosage: '1 tablet', schedule: SCHEDULE, startDay: '2026-11-01', endDay: null, status: 'active', legacyKeys: [],
  lastDose: null, prevDose: null, coveredUntil: null,
  createdAt: serverTimestamp(), createdByUid: person.uid, createdByName: 'Name',
  updatedAt: serverTimestamp(), updatedByUid: person.uid, updatedByName: 'Name',
  ...overrides,
});

const doseLog = (person: Person, at: Timestamp, overrides: Record<string, unknown> = {}) => ({
  courseId: 'apoquel', occurrence: occurrenceKey(at), occurrenceAt: at, date: serverTimestamp(), loggedAt: serverTimestamp(),
  medication: 'Apoquel', dosage: '1 tablet', notes: '', loggedByUid: person.uid, loggedByName: 'Name', repeat: 'none',
  ...overrides,
});

const pointerOf = (person: Person, logId: string, at: Timestamp) => ({
  logId, occurrence: occurrenceKey(at), occurrenceAt: at, givenAt: serverTimestamp(), byUid: person.uid, byName: 'Name',
});

/** The paired write the client transaction makes: the log and the course's new latest dose. */
async function giveDose(person: Person, logId: string, at: Timestamp, logOverrides: Record<string, unknown> = {}, prevDose: unknown = null) {
  const db = session(person);
  const batch = writeBatch(db);
  batch.set(logRef(db, logId), doseLog(person, at, logOverrides));
  // The pointer carries the log's given-at time (server time, or the chosen one).
  batch.update(courseRef(db), { lastDose: { ...pointerOf(person, logId, at), ...('date' in logOverrides ? { givenAt: logOverrides.date } : {}) }, prevDose });
  return batch.commit();
}

async function seed(write: (db: Firestore) => Promise<unknown>) {
  await environment.withSecurityRulesDisabled(async (context) => { await write(context.firestore() as unknown as Firestore); });
}

const storedCourse = (overrides: Record<string, unknown> = {}) => ({
  name: 'Apoquel', dosage: '1 tablet', schedule: SCHEDULE, startDay: '2026-11-01', endDay: null, status: 'active', legacyKeys: [],
  lastDose: null, prevDose: null, coveredUntil: null,
  createdAt: Timestamp.now(), createdByUid: people.owner.uid, createdByName: 'Owner',
  updatedAt: Timestamp.now(), updatedByUid: people.owner.uid, updatedByName: 'Owner',
  ...overrides,
});

before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync(process.env.HOMEHUB_FIRESTORE_RULES ?? 'firestore.rules', 'utf8') },
  });
});

beforeEach(async () => {
  await environment.clearFirestore();
  await seed(async (db) => {
    for (const household of [house, otherHouse]) {
      await setDoc(doc(db, 'households', household), { name: household, ownerUid: household === house ? people.owner.uid : people.outsider.uid, timeZone: 'America/Chicago' });
      await setDoc(doc(db, 'households', household, 'pets', 'rex'), { name: 'Rex', type: 'Dog', foodSchedule: 'twice daily' });
    }
    for (const person of [people.owner, people.member, people.child, people.guest]) {
      await setDoc(doc(db, 'households', house, 'members', person.uid), { uid: person.uid, role: person.role, status: 'active' });
    }
    await setDoc(doc(db, 'households', otherHouse, 'members', people.outsider.uid), { uid: people.outsider.uid, role: 'owner', status: 'active' });
    await setDoc(courseRef(db), storedCourse());
  });
});

after(async () => environment?.cleanup());

describe('medication courses', () => {
  test('anyone who logs creates a course signed at server time; others and forged shapes are refused', async () => {
    await assertSucceeds(setDoc(courseRef(session(people.owner), 'new-course'), newCourse(people.owner)));
    await assertSucceeds(setDoc(courseRef(session(people.owner), 'hourly'), newCourse(people.owner, { schedule: { kind: 'hours', everyHours: 12, firstTime: '08:00' } })));
    // pets.addLogs is enough (2.1 parity: anyone who logged set a next-due date); guests have none.
    await assertSucceeds(setDoc(courseRef(session(people.member), 'c2'), newCourse(people.member)));
    await assertSucceeds(setDoc(courseRef(session(people.child), 'c2b'), newCourse(people.child)));
    await assertFails(setDoc(courseRef(session(people.guest), 'c3'), newCourse(people.guest)));
    // Other household; signed out.
    await assertFails(setDoc(courseRef(session(people.outsider), 'c4'), newCourse(people.outsider)));
    await assertFails(setDoc(courseRef(environment.unauthenticatedContext().firestore() as unknown as Firestore, 'c5'), newCourse(people.owner)));
    // Forged author, chosen time, a dose planted at creation, a bad schedule.
    await assertFails(setDoc(courseRef(session(people.owner), 'c6'), newCourse(people.owner, { createdByUid: people.member.uid })));
    await assertFails(setDoc(courseRef(session(people.owner), 'c7'), newCourse(people.owner, { createdAt: Timestamp.fromDate(new Date('2026-01-01')) })));
    await assertFails(setDoc(courseRef(session(people.owner), 'c8'), newCourse(people.owner, { lastDose: { logId: 'x', occurrence: '2026-11-14', occurrenceAt: Timestamp.now(), givenAt: Timestamp.now(), byUid: 'x', byName: 'x' } })));
    for (const schedule of [null, { kind: 'days', everyDays: 0, times: [] }, { kind: 'days', everyDays: 1, times: ['8am'] }, { kind: 'hours', everyHours: 1, firstTime: '08:00' }, { kind: 'weeks' }]) {
      await assertFails(setDoc(courseRef(session(people.owner), 'c9'), newCourse(people.owner, { schedule })));
    }
    await assertFails(setDoc(courseRef(session(people.owner), 'c10'), newCourse(people.owner, { endDay: '2026-10-01' })));
    await assertFails(setDoc(courseRef(session(people.owner), 'c11'), newCourse(people.owner, { extra: true })));
  });

  test('a legacy medication may be finished without a schedule by anyone who logs (D-P8)', async () => {
    const finished = (person: Person, overrides: Record<string, unknown> = {}) => ({
      name: 'Heartworm', dosage: '1 chew', schedule: null, startDay: '2026-11-14', endDay: null, status: 'finished', legacyKeys: ['heartworm'],
      lastDose: null, prevDose: null, coveredUntil: null,
      createdAt: serverTimestamp(), createdByUid: person.uid, createdByName: 'Name',
      finishedAt: serverTimestamp(), finishedByUid: person.uid, finishedByName: 'Name',
      ...overrides,
    });
    await assertSucceeds(setDoc(courseRef(session(people.child), 'legacy-heartworm'), finished(people.child)));
    await assertFails(setDoc(courseRef(session(people.guest), 'legacy-x'), finished(people.guest)));
    await assertFails(setDoc(courseRef(session(people.member), 'legacy-y'), finished(people.member, { legacyKeys: [] })));
    await assertFails(setDoc(courseRef(session(people.member), 'legacy-z'), finished(people.member, { finishedByUid: people.owner.uid })));
  });

  test('edits (name, dosage, schedule, merge) need pets.addLogs; keys only grow; status is not an edit', async () => {
    const edit = (person: Person, fields: Record<string, unknown>) =>
      updateDoc(courseRef(session(person)), { ...fields, updatedAt: serverTimestamp(), updatedByUid: person.uid, updatedByName: 'Name' });
    await assertSucceeds(edit(people.owner, { name: 'Apoquel 16 mg', schedule: { kind: 'days', everyDays: 1, times: ['09:00', '21:00'] }, coveredUntil: Timestamp.now() }));
    await assertSucceeds(edit(people.owner, { legacyKeys: ['apoquell'] }));
    await assertFails(edit(people.owner, { legacyKeys: [] }));
    await assertSucceeds(edit(people.member, { name: 'Renamed' }));
    await assertFails(edit(people.guest, { name: 'Guest rename' }));
    await assertFails(edit(people.owner, { status: 'finished' }));
    await assertFails(edit(people.owner, { schedule: null }));
    await assertFails(updateDoc(courseRef(session(people.owner)), { name: 'Forged', updatedAt: serverTimestamp(), updatedByUid: people.member.uid }));
    await assertFails(edit(people.outsider, { name: 'Other household' }));
    // No client deletes: finishing keeps the history.
    await assertFails(deleteDoc(courseRef(session(people.owner))));
  });

  test('finish and resume (its Undo) need pets.addLogs, signed by the finisher', async () => {
    const finish = (person: Person, by = person.uid) => updateDoc(courseRef(session(person)), { status: 'finished', finishedAt: serverTimestamp(), finishedByUid: by, finishedByName: 'Name' });
    const resume = (person: Person) => updateDoc(courseRef(session(person)), { status: 'active', finishedAt: null, finishedByUid: null, finishedByName: null });
    await assertFails(finish(people.guest));
    await assertFails(finish(people.member, people.owner.uid));
    await assertSucceeds(finish(people.member));
    await assertFails(resume(people.guest));
    await assertSucceeds(resume(people.child));
    await assertSucceeds(finish(people.child));
    await assertSucceeds(resume(people.owner));
  });
});

describe('dose logs', () => {
  test('a dose paired with the course pointer, by the writer at server time', async () => {
    await assertSucceeds(giveDose(people.child, 'press-0001', occurrenceAt(-1)));
  });

  test('wrong role, other household, signed out', async () => {
    await assertFails(giveDose(people.guest, 'press-0002', occurrenceAt(-1)));
    const outsider = session(people.outsider);
    await assertFails(setDoc(logRef(outsider, 'press-0003'), doseLog(people.outsider, occurrenceAt(-1))));
    await seed((db) => setDoc(courseRef(db, 'apoquel', otherHouse), storedCourse()));
    const memberDb = session(people.member);
    const batch = writeBatch(memberDb);
    batch.set(logRef(memberDb, 'press-0004', otherHouse), doseLog(people.member, occurrenceAt(-1)));
    await assertFails(batch.commit());
  });

  test('forged author, a chosen live time, a future given-at time, an unpaired log', async () => {
    await assertFails(giveDose(people.member, 'press-0010', occurrenceAt(-1), { loggedByUid: people.owner.uid }));
    await assertFails(giveDose(people.member, 'press-0011', occurrenceAt(-1), { date: Timestamp.fromMillis(Date.now() - 60_000) }));
    await assertFails(giveDose(people.member, 'press-0012', occurrenceAt(-1), { backdated: true, date: Timestamp.fromMillis(Date.now() + 3_600_000) }));
    await assertFails(giveDose(people.member, 'press-0013', occurrenceAt(-1), { backdated: true, date: Timestamp.fromMillis(Date.now() - 8 * 86_400_000) }));
    await assertFails(giveDose(people.member, 'press-0014', occurrenceAt(24 * 93)));
    await assertFails(giveDose(people.member, 'press-0015', occurrenceAt(-1), { loggedAt: Timestamp.fromMillis(Date.now() - 60_000) }));
    // A dose that would be the latest must move the pointer in the same commit.
    await assertFails(setDoc(logRef(session(people.member), 'press-0016'), doseLog(people.member, occurrenceAt(-1))));
    // A backdated dose within 7 days is fine.
    await assertSucceeds(giveDose(people.member, 'press-0017', occurrenceAt(-1), { backdated: true, date: Timestamp.fromMillis(Date.now() - 2 * 3_600_000) }));
  });

  test('a reused id is refused (one press, one dose); doses are never edited', async () => {
    const at = occurrenceAt(-1);
    await assertSucceeds(giveDose(people.member, 'press-0020', at));
    const db = session(people.member);
    await assertFails(setDoc(logRef(db, 'press-0020'), doseLog(people.member, at, { repeat: 'confirmed', confirmOf: 'press-0020' })));
    await assertFails(updateDoc(logRef(db, 'press-0020'), { notes: 'edited' }));
  });

  test('a covered occurrence needs a confirmation naming the latest dose; a stale one is refused', async () => {
    const at = occurrenceAt(-1);
    await assertSucceeds(giveDose(people.member, 'press-0030', at));
    // Unconfirmed repeat of the same occurrence.
    await assertFails(giveDose(people.child, 'press-0031', at, {}, null));
    // Confirmation bound to another (older) dose.
    await assertFails(giveDose(people.child, 'press-0032', at, { repeat: 'confirmed', confirmOf: 'press-older' }, null));
    // Bound to the current latest dose: accepted.
    const db = session(people.child);
    const batch = writeBatch(db);
    batch.set(logRef(db, 'press-0033'), doseLog(people.child, at, { repeat: 'confirmed', confirmOf: 'press-0030' }));
    // prevDose must be exactly the replaced pointer as stored (givenAt resolved), or null.
    batch.update(courseRef(db), { lastDose: pointerOf(people.child, 'press-0033', at), prevDose: null });
    await assertSucceeds(batch.commit());
  });

  test('no dose for a finished course', async () => {
    await seed((db) => updateDoc(courseRef(db), { status: 'finished', finishedAt: Timestamp.now(), finishedByUid: people.owner.uid, finishedByName: 'Owner' }));
    await assertFails(giveDose(people.member, 'press-0040', occurrenceAt(-1)));
  });

  test('removing a dose: the author within 10 minutes or pets.deleteLogs, and only with the pointer moved', async () => {
    const at = occurrenceAt(-1);
    await assertSucceeds(giveDose(people.child, 'press-0050', at));
    // Without moving the pointer: refused.
    await assertFails(deleteDoc(logRef(session(people.child), 'press-0050')));
    // Someone else (a member without pets.deleteLogs): refused even with the pointer moved.
    const other = session(people.member);
    const otherBatch = writeBatch(other);
    otherBatch.delete(logRef(other, 'press-0050'));
    otherBatch.update(courseRef(other), { lastDose: null, prevDose: null });
    await assertFails(otherBatch.commit());
    // The author, pointer cleared in the same commit: accepted.
    const db = session(people.child);
    const batch = writeBatch(db);
    batch.delete(logRef(db, 'press-0050'));
    batch.update(courseRef(db), { lastDose: null, prevDose: null });
    await assertSucceeds(batch.commit());
  });

  test('the pointer can only name a real dose of this course', async () => {
    await seed((db) => setDoc(logRef(db, 'someone-elses'), { ...doseLog(people.owner, occurrenceAt(-2)), date: Timestamp.now(), loggedAt: Timestamp.now() }));
    // Planting a pointer at an existing log (not created in this commit) is not a dose.
    await assertFails(updateDoc(courseRef(session(people.member)), { lastDose: pointerOf(people.member, 'someone-elses', occurrenceAt(-2)) }));
    await assertFails(updateDoc(courseRef(session(people.member)), { lastDose: null }));
  });

  test('offline doses: the device clock within the skew allowance, no confirmation, no pointer write', async () => {
    const db = session(people.member);
    const offline = (id: string, at: Timestamp, date: Timestamp, extra: Record<string, unknown> = {}) =>
      setDoc(logRef(db, id), { ...doseLog(people.member, at, { repeat: 'offline', clockSource: 'device', date }), ...extra });
    const at = occurrenceAt(-1);
    await assertSucceeds(offline('off-0001', at, Timestamp.fromMillis(Date.now() - 3 * 3_600_000)));
    // A device clock a little ahead is fine; far ahead, or older than the allowance, is not.
    await assertSucceeds(offline('off-0002', at, Timestamp.fromMillis(Date.now() + 2 * 3_600_000)));
    await assertFails(offline('off-0003', at, Timestamp.fromMillis(Date.now() + 13 * 3_600_000)));
    await assertFails(offline('off-0004', at, Timestamp.fromMillis(Date.now() - 9 * 86_400_000)));
    // Marked offline but not from a device clock, or carrying a confirmation: refused.
    await assertFails(setDoc(logRef(db, 'off-0005'), doseLog(people.member, at, { repeat: 'offline', date: Timestamp.now() })));
    await assertFails(offline('off-0006', at, Timestamp.now(), { confirmOf: 'x' }));
    // A device-clock dose that claims to be live is refused (it must say offline).
    await assertFails(setDoc(logRef(db, 'off-0007'), doseLog(people.member, at, { clockSource: 'device' })));
    // Forged author, guest, other household.
    await assertFails(offline('off-0008', at, Timestamp.now(), { loggedByUid: people.owner.uid }));
    await assertFails(setDoc(logRef(session(people.guest), 'off-0009'), { ...doseLog(people.guest, at, { repeat: 'offline', clockSource: 'device', date: Timestamp.now() }) }));
    // The pointer stays as it was (offline doses never write it).
    // A course finished while the dose was queued keeps it as history.
    await seed((seedDb) => updateDoc(courseRef(seedDb), { status: 'finished', finishedAt: Timestamp.now(), finishedByUid: people.owner.uid, finishedByName: 'Owner' }));
    await assertSucceeds(offline('off-0010', at, Timestamp.now()));
    // Its author may remove it (no pointer names it).
    await assertSucceeds(deleteDoc(logRef(db, 'off-0001')));
    // One-off doses offline too.
    await assertSucceeds(setDoc(logRef(db, 'oneoff-off-1'), { oneOff: true, clockSource: 'device', date: Timestamp.fromMillis(Date.now() - 60 * 60_000), loggedAt: serverTimestamp(), medication: 'Dewormer', dosage: '1 tab', loggedByUid: people.member.uid, loggedByName: 'Name' }));
    await assertFails(setDoc(logRef(db, 'oneoff-off-2'), { oneOff: true, clockSource: 'device', date: Timestamp.fromMillis(Date.now() + 13 * 3_600_000), loggedAt: serverTimestamp(), medication: 'Dewormer', dosage: '1 tab', loggedByUid: people.member.uid }));
  });

  test('a medication entry is created only while its pet exists (no dose after the delete cascade)', async () => {
    const db = session(people.member);
    const legacy = { date: new Date().toISOString(), medication: 'Flea', dosage: '1', notes: '', loggedByUid: people.member.uid, loggedByName: 'Name' };
    const offline = { ...doseLog(people.member, occurrenceAt(-1), { repeat: 'offline', clockSource: 'device', date: Timestamp.now() }) };
    const oneOff = { oneOff: true, date: serverTimestamp(), loggedAt: serverTimestamp(), medication: 'Dewormer', dosage: '1 tab', loggedByUid: people.member.uid, loggedByName: 'Name' };
    // The pet exists: each shape is accepted.
    await assertSucceeds(giveDose(people.member, 'press-pet-1', occurrenceAt(-1)));
    await assertSucceeds(setDoc(logRef(db, 'legacy-pet-1'), legacy));
    await assertSucceeds(setDoc(logRef(db, 'offline-pet-1'), offline));
    await assertSucceeds(setDoc(logRef(db, 'oneoff-pet-1'), oneOff));
    // The pet is deleted (its cascade removes the pet document): none is accepted, including a queued offline dose.
    await seed((seedDb) => deleteDoc(doc(seedDb, 'households', house, 'pets', 'rex')));
    await assertFails(setDoc(logRef(db, 'legacy-pet-2'), legacy));
    await assertFails(setDoc(logRef(db, 'offline-pet-2'), offline));
    await assertFails(setDoc(logRef(db, 'oneoff-pet-2'), oneOff));
    await assertFails(setDoc(logRef(db, 'press-pet-2'), doseLog(people.member, occurrenceAt(-1))));
  });

  test('legacy 2.1 entries and one-off doses', async () => {
    const db = session(people.member);
    await assertSucceeds(setDoc(logRef(db, 'legacy-1'), { date: new Date().toISOString(), medication: 'Flea', dosage: '1', notes: '', nextDueDate: '2026-12-01', loggedByUid: people.member.uid, loggedByName: 'Name' }));
    await assertSucceeds(setDoc(logRef(db, 'oneoff-0001'), { oneOff: true, date: serverTimestamp(), loggedAt: serverTimestamp(), medication: 'Dewormer', dosage: '1 tab', notes: '', loggedByUid: people.member.uid, loggedByName: 'Name' }));
    await assertFails(setDoc(logRef(db, 'oneoff-0002'), { oneOff: true, date: Timestamp.fromMillis(Date.now() + 3_600_000), backdated: true, loggedAt: serverTimestamp(), medication: 'Dewormer', dosage: '1 tab', loggedByUid: people.member.uid }));
    await assertFails(setDoc(logRef(db, 'oneoff-0003'), { oneOff: true, date: serverTimestamp(), loggedAt: serverTimestamp(), medication: 'Dewormer', dosage: '1 tab', loggedByUid: people.owner.uid }));
    // A legacy-shaped entry may not smuggle course fields.
    await assertFails(setDoc(logRef(db, 'legacy-2'), { date: new Date().toISOString(), medication: 'Flea', dosage: '1', notes: '', occurrence: '2026-11-14', loggedByUid: people.member.uid }));
    await assertFails(setDoc(logRef(session(people.guest), 'legacy-3'), { date: new Date().toISOString(), medication: 'Flea', dosage: '1', notes: '' }));
  });
});
