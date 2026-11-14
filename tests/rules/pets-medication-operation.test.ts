/**
 * Medication course actions against the Firestore emulator with the real rules
 * (P3): `runGiveDose`, `runUndoDose`, `runFinishCourse`, `runSaveCourse` and the
 * legacy confirmation (`runConfirmLegacy`, `runFinishLegacy`, `runMergeLegacy`)
 * from src/lib/pets/medication-transaction.ts, the same code the app runs (it
 * only binds the app's Firestore instead of these test sessions). Two sessions,
 * double taps, retries after an uncertain response, stale confirmations, Undo
 * after someone else gave a later dose, and the D-P8 confirmation flow on
 * synthetic legacy data.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocFromServer, getDocs, onSnapshot, query, setDoc, Timestamp, where, type Firestore } from 'firebase/firestore';
import {
  runConfirmLegacy,
  runFinishCourse,
  runFinishLegacy,
  runGiveDose,
  runMergeLegacy,
  runResumeCourse,
  runSaveCourse,
  runUndoDose,
  type GiveDoseInput,
  type GiveDoseResult,
} from '../../src/lib/pets/medication-transaction';
import {
  doseChoices,
  doseConfirmOf,
  legacyCourseId,
  medicationDues,
  newDoseOpId,
  nextDueOccurrence,
  pendingLegacyGroups,
  readCourse,
  takenLegacyKeys,
  withOfflineDoses,
  coverageAfterEdit,
  occurrencesAfter,
  type CourseView,
} from '../../src/lib/pets/medication-course';
import { localDay, addDays } from '../../functions/src/shared/calendar';
import type { PetMedicationLog } from '../../src/lib/pets/types';

const projectId = 'demo-homehub-e2e';
const household = 'household-med-op';
const TZ = 'America/Chicago';
let environment: RulesTestEnvironment;

const people = {
  sam: { uid: 'med-sam', email: 'sam.med@example.test', role: 'member', name: 'Sam' },
  kim: { uid: 'med-kim', email: 'kim.med@example.test', role: 'child', name: 'Kim' },
  owner: { uid: 'med-op-owner', email: 'owner.medop@example.test', role: 'owner', name: 'Olive' },
} as const;
type Person = (typeof people)[keyof typeof people];

const session = (person: Person) => environment.authenticatedContext(person.uid, { email: person.email }).firestore() as unknown as Firestore;
const actor = (person: Person) => ({ uid: person.uid, name: person.name });
const today = () => localDay(new Date(), TZ);
const courseDoc = (db: Firestore, id = 'apoquel') => doc(db, 'households', household, 'pets', 'rex', 'medication-courses', id);
// Every 2 hours from midnight, from two days ago: an occurrence is always near.
const SCHEDULE = { kind: 'hours' as const, everyHours: 2, firstTime: '00:00' };

async function readCourseNow(id = 'apoquel'): Promise<CourseView> {
  const snapshot = await getDoc(courseDoc(session(people.owner), id));
  return readCourse(id, snapshot.data())!;
}

async function doses(): Promise<Record<string, unknown>[]> {
  let list: Record<string, unknown>[] = [];
  await environment.withSecurityRulesDisabled(async (context) => {
    const snapshot = await getDocs(collection(context.firestore(), 'households', household, 'pets', 'rex', 'medication-logs'));
    list = snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }));
  });
  return list.filter((entry) => entry.courseId);
}

async function press(person: Person, overrides: Partial<GiveDoseInput> = {}): Promise<GiveDoseInput> {
  const course = await readCourseNow(overrides.courseId);
  const { prefill } = doseChoices(course, new Date(), TZ);
  return {
    householdId: household, petId: 'rex', courseId: 'apoquel', opId: newDoseOpId(),
    occurrenceKey: prefill!.key, givenAt: null, user: actor(person), timeZone: TZ, ...overrides,
  };
}

const saved = (result: GiveDoseResult) => {
  assert.equal(result.status, 'saved', `expected a write, got ${JSON.stringify(result)}`);
  return result as Exclude<GiveDoseResult, { status: 'needsConfirm' }>;
};

/** Records a dose, answering "already given?" / "a dose moments ago" when asked (an intended early or repeat dose). */
async function giveAnyway(db: Firestore, input: GiveDoseInput) {
  const result = await runGiveDose(db, input);
  if (result.status !== 'needsConfirm') return saved(result);
  return saved(await runGiveDose(db, { ...input, confirm: doseConfirmOf(result.check) }));
}

before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync(process.env.HOMEHUB_FIRESTORE_RULES ?? 'firestore.rules', 'utf8') },
  });
});

beforeEach(async () => {
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'households', household), { name: 'Meds', ownerUid: people.owner.uid, timeZone: TZ });
    for (const person of Object.values(people)) {
      await setDoc(doc(db, 'households', household, 'members', person.uid), { uid: person.uid, role: person.role, status: 'active' });
    }
    await setDoc(doc(db, 'households', household, 'pets', 'rex'), { name: 'Rex', type: 'Dog', foodSchedule: 'twice daily' });
  });
  await runSaveCourse(session(people.owner), {
    householdId: household, petId: 'rex', courseId: 'apoquel', create: true, user: actor(people.owner), timeZone: TZ,
    fields: { name: 'Apoquel', dosage: '1 tablet', schedule: SCHEDULE, startDay: addDays(today(), -2), endDay: null },
  });
});

after(async () => environment?.cleanup());

describe('Give dose on the emulator with the real rules', () => {
  test('a double tap in two sessions (the same press) records one dose; a retry finds it', async () => {
    const input = await press(people.sam);
    const [a, b] = await Promise.all([runGiveDose(session(people.sam), input), runGiveDose(session(people.sam), input)]);
    const results = [saved(a), saved(b)];
    assert.equal(results.filter((result) => result.replayed).length, 1, 'one run wrote, the other found it');
    assert.equal((await doses()).length, 1);
    // A retry after an uncertain response: still one.
    assert.equal(saved(await runGiveDose(session(people.sam), input)).replayed, true);
    assert.equal((await doses()).length, 1);
    const course = await readCourseNow();
    assert.equal(course.lastDose?.logId, input.opId);
    assert.equal(course.lastDose?.occurrence, input.occurrenceKey);
    // The next due occurrence moved past the given one, once.
    assert.ok(nextDueOccurrence(course, TZ)!.at > course.lastDose!.occurrenceAt);
  });

  test('two members giving the same occurrence at once: one records, the other is asked with the last-dose context', async () => {
    const [samPress, kimPress] = await Promise.all([press(people.sam), press(people.kim)]);
    const [a, b] = await Promise.all([runGiveDose(session(people.sam), samPress), runGiveDose(session(people.kim), kimPress)]);
    assert.deepEqual([a.status, b.status].sort(), ['needsConfirm', 'saved']);
    const asked = (a.status === 'needsConfirm' ? a : b) as Extract<GiveDoseResult, { status: 'needsConfirm' }>;
    assert.equal(asked.check.reason, 'given');
    assert.ok(asked.check.last?.byName === 'Sam' || asked.check.last?.byName === 'Kim');
    assert.equal((await doses()).length, 1);
  });

  test('a stale "already given" answer is asked again naming the newer dose; the current one records once', async () => {
    const first = await press(people.sam);
    saved(await runGiveDose(session(people.sam), first));
    const kimPress = { ...first, opId: newDoseOpId(), user: actor(people.kim) };
    const asked = await runGiveDose(session(people.kim), kimPress);
    assert.equal(asked.status, 'needsConfirm');
    const staleAnswer = asked.status === 'needsConfirm' ? doseConfirmOf(asked.check) : null;
    // Meanwhile the owner confirms and records another dose for the same time.
    const ownerPress = { ...first, opId: newDoseOpId(), user: actor(people.owner) };
    const ownerAsked = await runGiveDose(session(people.owner), ownerPress);
    saved(await runGiveDose(session(people.owner), { ...ownerPress, confirm: ownerAsked.status === 'needsConfirm' ? doseConfirmOf(ownerAsked.check) : null }));
    assert.equal((await doses()).length, 2);
    const again = await runGiveDose(session(people.kim), { ...kimPress, confirm: staleAnswer });
    assert.equal(again.status, 'needsConfirm');
    assert.equal(again.status === 'needsConfirm' && again.staleConfirm, true);
    assert.equal(again.status === 'needsConfirm' && again.check.last?.byUid, people.owner.uid);
    const confirm = again.status === 'needsConfirm' ? doseConfirmOf(again.check) : null;
    saved(await runGiveDose(session(people.kim), { ...kimPress, confirm }));
    // "Record again" pressed twice (the same press): still one more.
    saved(await runGiveDose(session(people.kim), { ...kimPress, confirm }));
    const list = await doses();
    assert.equal(list.length, 3);
    const kims = list.find((entry) => entry.id === kimPress.opId)!;
    assert.equal(kims.repeat, 'confirmed');
    assert.equal(kims.confirmOf, ownerPress.opId);
  });

  test('a backdated dose keeps its given-at time and server-recorded time apart', async () => {
    const givenAt = new Date(Date.now() - 90 * 60_000);
    givenAt.setMilliseconds(0);
    const input = await press(people.sam, { givenAt });
    const result = saved(await runGiveDose(session(people.sam), input));
    const log = (await doses()).find((entry) => entry.id === result.logId)!;
    assert.equal((log.date as Timestamp).toMillis(), givenAt.getTime());
    assert.equal(log.backdated, true);
    assert.ok(Math.abs((log.loggedAt as Timestamp).toMillis() - Date.now()) < 60_000, 'recorded at server time');
  });

  test('Undo restores the previous dose; undoing an older dose never overwrites a later one by someone else', async () => {
    const first = await press(people.sam);
    const one = saved(await runGiveDose(session(people.sam), first));
    // Kim records the next occurrence (an early dose).
    const course = await readCourseNow();
    const next = nextDueOccurrence(course, TZ)!;
    const two = await giveAnyway(session(people.kim), { ...first, opId: newDoseOpId(), occurrenceKey: next.key, user: actor(people.kim) });
    assert.equal((await readCourseNow()).lastDose?.logId, two.logId);
    // Sam undoes his (older) dose: Kim's stays the latest.
    assert.equal(await runUndoDose(session(people.sam), { householdId: household, petId: 'rex', logId: one.logId }), 'saved');
    let after = await readCourseNow();
    assert.equal(after.lastDose?.logId, two.logId);
    assert.equal(after.prevDose, null, 'the removed dose is forgotten');
    // Kim undoes hers: no dose left, the course is due again from its schedule.
    await runUndoDose(session(people.kim), { householdId: household, petId: 'rex', logId: two.logId });
    after = await readCourseNow();
    assert.equal(after.lastDose, null);
    assert.equal((await doses()).length, 0);
    // An Undo repeated (a retry) is already done.
    assert.equal(await runUndoDose(session(people.kim), { householdId: household, petId: 'rex', logId: two.logId }), 'already');
  });

  test('Undo of the latest dose restores the one before it', async () => {
    const first = await press(people.sam);
    const one = saved(await runGiveDose(session(people.sam), first));
    const next = nextDueOccurrence(await readCourseNow(), TZ)!;
    const two = await giveAnyway(session(people.sam), { ...first, opId: newDoseOpId(), occurrenceKey: next.key });
    await runUndoDose(session(people.sam), { householdId: household, petId: 'rex', logId: two.logId });
    assert.equal((await readCourseNow()).lastDose?.logId, one.logId);
  });

  test('undoing two latest doses in a row falls back to the latest surviving dose (read from the server)', async () => {
    const first = await press(people.sam);
    const one = saved(await runGiveDose(session(people.sam), first));
    let next = nextDueOccurrence(await readCourseNow(), TZ)!;
    const two = await giveAnyway(session(people.sam), { ...first, opId: newDoseOpId(), occurrenceKey: next.key });
    next = nextDueOccurrence(await readCourseNow(), TZ)!;
    const three = await giveAnyway(session(people.sam), { ...first, opId: newDoseOpId(), occurrenceKey: next.key });
    await runUndoDose(session(people.sam), { householdId: household, petId: 'rex', logId: three.logId });
    assert.equal((await readCourseNow()).lastDose?.logId, two.logId, 'the previous dose');
    // No previous pointer left: the latest surviving dose is found (its server time kept exactly).
    await runUndoDose(session(people.sam), { householdId: household, petId: 'rex', logId: two.logId });
    assert.equal((await readCourseNow()).lastDose?.logId, one.logId);
  });

  test('offline: queued once under the press id with the device clock, the pointer untouched; an online repeat asks, naming it', async () => {
    const db = session(people.kim);
    // Keep the course in this session's cache, as an open page does.
    const stopCourse = onSnapshot(courseDoc(db), () => undefined);
    const stopDoses = onSnapshot(query(collection(db, 'households', household, 'pets', 'rex', 'medication-logs'), where('courseId', '==', 'apoquel')), () => undefined);
    const stop = () => { stopCourse(); stopDoses(); };
    await getDocFromServer(courseDoc(db));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const input = await press(people.kim);
    const navigatorRef = globalThis.navigator as unknown as Record<string, unknown>;
    Object.defineProperty(navigatorRef, 'onLine', { value: false, configurable: true });
    let first: GiveDoseResult;
    let again: GiveDoseResult;
    try {
      first = await runGiveDose(db, input);
      // The same press again while still offline: found on this device, not queued twice.
      again = await runGiveDose(db, input);
    } finally {
      delete navigatorRef.onLine;
      stop();
    }
    assert.equal(first.status, 'queued');
    assert.equal(again.status === 'queued' && again.replayed, true);
    // The emulator is reachable, so the queued write syncs; wait for it.
    let log: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 50 && !log; attempt++) {
      log = (await doses()).find((entry) => entry.id === input.opId);
      if (!log) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(log, 'the queued dose synced');
    assert.equal(log!.repeat, 'offline');
    assert.equal(log!.clockSource, 'device');
    assert.equal((await doses()).length, 1);
    const course = await readCourseNow();
    assert.equal(course.lastDose, null, 'an offline dose never writes the pointer');
    // Readers combine it: the occurrence counts as given.
    const combined = withOfflineDoses(course, await doses());
    assert.equal(combined.offlineDose?.logId, input.opId);
    assert.ok(nextDueOccurrence(combined, TZ)!.at > combined.offlineDose!.occurrenceAt);
    // Online, Sam recording the same occurrence is asked first, naming Kim's offline dose.
    const samPress = { ...input, opId: newDoseOpId(), user: actor(people.sam) };
    const asked = await runGiveDose(session(people.sam), samPress);
    assert.equal(asked.status, 'needsConfirm');
    assert.equal(asked.status === 'needsConfirm' && asked.check.last?.logId, input.opId);
    const confirmed = saved(await runGiveDose(session(people.sam), { ...samPress, confirm: asked.status === 'needsConfirm' ? doseConfirmOf(asked.check) : null }));
    assert.equal((await readCourseNow()).lastDose?.logId, confirmed.logId);
  });

  test('Undo derives the latest from the surviving doses (D): 8:00, 12:00 early, a confirmed 10:00, remove 12:00 → 10:00', async () => {
    const first = await press(people.sam);
    const eight = saved(await runGiveDose(session(people.sam), first));
    const course = await readCourseNow();
    const [ten, noon] = occurrencesAfter({ schedule: course.schedule!, startDay: course.startDay, endDay: course.endDay }, eight.occurrence!.at, TZ, 2);
    const twelve = await giveAnyway(session(people.sam), { ...first, opId: newDoseOpId(), occurrenceKey: noon.key });
    // The in-between dose is covered by the early one: recorded after "already given?".
    const between = await giveAnyway(session(people.kim), { ...first, opId: newDoseOpId(), occurrenceKey: ten.key, user: actor(people.kim) });
    let state = await readCourseNow();
    assert.deepEqual([state.lastDose?.logId, state.prevDose?.logId], [twelve.logId, between.logId], 'the stored pointer is the derived state');
    await runUndoDose(session(people.sam), { householdId: household, petId: 'rex', logId: twelve.logId });
    state = await readCourseNow();
    assert.equal(state.lastDose?.logId, between.logId, 'the in-between dose, not the first one');
    assert.equal(state.prevDose?.logId, eight.logId);
    assert.ok(nextDueOccurrence(state, TZ)!.at > ten.at, 'the in-between time is not due again');
  });

  test('a schedule edit counts an offline-synced dose (C): coverage saved as the preview shows', async () => {
    const course = await readCourseNow();
    const given = occurrencesAfter({ schedule: course.schedule!, startDay: course.startDay, endDay: course.endDay }, Date.now() - 3 * 3_600_000, TZ, 1)[0];
    // A dose recorded offline that synced: in the logs, not in the pointer.
    await environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'households', household, 'pets', 'rex', 'medication-logs', 'offline-dose'), {
        courseId: 'apoquel', occurrence: given.key, occurrenceAt: Timestamp.fromMillis(given.at), date: Timestamp.fromMillis(given.at),
        loggedAt: Timestamp.now(), medication: 'Apoquel', dosage: '1 tablet', notes: '', loggedByUid: people.sam.uid, loggedByName: 'Sam', repeat: 'offline', clockSource: 'device',
      });
    });
    assert.equal((await readCourseNow()).lastDose, null);
    const fields = { name: 'Apoquel', dosage: '1 tablet', schedule: { kind: 'hours' as const, everyHours: 2, firstTime: '00:30' }, startDay: addDays(today(), -2), endDay: null };
    // The preview: what a reader sees (the pointer with the offline doses).
    const preview = coverageAfterEdit(withOfflineDoses(await readCourseNow(), await doses()), fields, TZ);
    assert.equal(preview, given.at + 30 * 60_000);
    await runSaveCourse(session(people.owner), { householdId: household, petId: 'rex', courseId: 'apoquel', create: false, fields, user: actor(people.owner), timeZone: TZ });
    const edited = await readCourseNow();
    assert.equal(edited.coveredUntil, preview, 'the saved coverage matches the preview');
    assert.ok(nextDueOccurrence(withOfflineDoses(edited, await doses()), TZ)!.at > preview!, 'the replaced time is not due again');
  });

  test('Finish ends the course (no dose, no next due), history kept; its Undo resumes it', async () => {
    const one = saved(await runGiveDose(session(people.sam), await press(people.sam)));
    assert.equal(await runFinishCourse(session(people.kim), { householdId: household, petId: 'rex', courseId: 'apoquel', user: actor(people.kim) }), 'saved');
    assert.equal(await runFinishCourse(session(people.kim), { householdId: household, petId: 'rex', courseId: 'apoquel', user: actor(people.kim) }), 'already');
    const finished = await readCourseNow();
    assert.equal(finished.status, 'finished');
    assert.equal(nextDueOccurrence(finished, TZ), null);
    assert.deepEqual(medicationDues([finished], [], new Date(), TZ), []);
    assert.ok((await doses()).some((entry) => entry.id === one.logId), 'history kept');
    await assert.rejects(runGiveDose(session(people.sam), { householdId: household, petId: 'rex', courseId: 'apoquel', opId: newDoseOpId(), occurrenceKey: one.occurrence!.key, givenAt: null, user: actor(people.sam), timeZone: TZ }), /medication-finished/);
    await runResumeCourse(session(people.kim), { householdId: household, petId: 'rex', courseId: 'apoquel' });
    assert.equal((await readCourseNow()).status, 'active');
  });

  test('a rename keeps the course and its doses; a schedule edit recomputes the next dose once', async () => {
    const one = saved(await runGiveDose(session(people.sam), await press(people.sam)));
    const fields = { name: 'Apoquel 16 mg', dosage: '1 tablet', schedule: SCHEDULE, startDay: addDays(today(), -2), endDay: null };
    await runSaveCourse(session(people.owner), { householdId: household, petId: 'rex', courseId: 'apoquel', create: false, fields, user: actor(people.owner), timeZone: TZ });
    const renamed = await readCourseNow();
    assert.equal(renamed.name, 'Apoquel 16 mg');
    assert.equal(renamed.lastDose?.logId, one.logId, 'the doses stay attached');
    // A member who logs may edit it too (pets.addLogs, 2.1 parity).
    await runSaveCourse(session(people.sam), { householdId: household, petId: 'rex', courseId: 'apoquel', create: false, fields, user: actor(people.sam), timeZone: TZ });
    // Moving the times by half an hour: the given occurrence's replacement counts as given.
    await runSaveCourse(session(people.owner), { householdId: household, petId: 'rex', courseId: 'apoquel', create: false, fields: { ...fields, schedule: { kind: 'hours', everyHours: 2, firstTime: '00:30' } }, user: actor(people.owner), timeZone: TZ });
    const moved = await readCourseNow();
    assert.ok(moved.coveredUntil !== null && moved.coveredUntil > one.occurrence!.at);
    assert.ok(nextDueOccurrence(moved, TZ)!.at > moved.coveredUntil!, 'no duplicate occurrence right after the given one');
  });
});

describe('legacy medication confirmation (D-P8) with synthetic data', () => {
  const legacy = (id: string, date: string, medication: string, nextDueDate?: string) =>
    ({ id, date, medication, dosage: '1 chew', notes: '', ...(nextDueDate ? { nextDueDate } : {}) });

  async function seedLegacy(entries: ReturnType<typeof legacy>[]) {
    await environment.withSecurityRulesDisabled(async (context) => {
      for (const { id, ...data } of entries) await setDoc(doc(context.firestore(), 'households', household, 'pets', 'rex', 'medication-logs', id), data);
    });
  }

  async function legacyState() {
    let logs: PetMedicationLog[] = [];
    let courses: CourseView[] = [];
    await environment.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      logs = (await getDocs(collection(db, 'households', household, 'pets', 'rex', 'medication-logs'))).docs.map((entry) => ({ id: entry.id, ...entry.data() }) as PetMedicationLog);
      courses = (await getDocs(collection(db, 'households', household, 'pets', 'rex', 'medication-courses'))).docs.flatMap((entry) => {
        const course = readCourse(entry.id, entry.data());
        return course ? [course] : [];
      });
    });
    return { logs, courses, pending: pendingLegacyGroups(logs, takenLegacyKeys(courses), TZ) };
  }

  test('legacy entries keep their countdown until a member confirms; consistent history is a suggestion, ambiguous gets none', async () => {
    const due = addDays(today(), 3);
    await seedLegacy([
      legacy('h1', `${addDays(due, -60)}T15:00:00.000Z`, 'Heartworm', addDays(due, -30)),
      legacy('h2', `${addDays(due, -30)}T15:00:00.000Z`, 'heartworm ', due),
      legacy('f1', `${addDays(due, -40)}T15:00:00.000Z`, 'Flea', addDays(due, -10)),
      legacy('f2', `${addDays(due, -10)}T15:00:00.000Z`, 'Flea', due),
      legacy('t1', `${addDays(due, -20)}T15:00:00.000Z`, 'Apoquell', addDays(due, -19)),
    ]);
    let state = await legacyState();
    assert.deepEqual(state.pending.map((group) => [group.key, group.reason, group.suggestion?.kind === 'days' ? group.suggestion.everyDays : null]), [
      ['apoquell', 'consistent', 1],
      ['flea', 'conflicting', null],
      ['heartworm', 'consistent', 30],
    ]);
    // Before any confirmation the legacy countdowns still show (no silent conversion).
    assert.deepEqual(medicationDues(state.courses, state.logs, new Date(), TZ).filter((entry) => !entry.courseId).map((entry) => entry.legacyKey).sort(), ['apoquell', 'flea', 'heartworm']);

    // Two members confirm the suggested Heartworm schedule at once: one course.
    const heartworm = state.pending.find((group) => group.key === 'heartworm')!;
    const fields = { name: 'Heartworm', dosage: heartworm.dosage, schedule: heartworm.suggestion!, startDay: heartworm.dueDay, endDay: null };
    const [a, b] = await Promise.all([
      runConfirmLegacy(session(people.owner), { householdId: household, petId: 'rex', key: 'heartworm', fields, user: actor(people.owner) }),
      runConfirmLegacy(session(people.owner), { householdId: household, petId: 'rex', key: 'heartworm', fields, user: actor(people.owner) }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), ['already', 'saved']);
    assert.equal(a.courseId, legacyCourseId('heartworm'));
    // A member finishes the ambiguous one ("no more doses").
    assert.equal(await runFinishLegacy(session(people.sam), { householdId: household, petId: 'rex', key: 'flea', name: 'Flea', dosage: '1 chew', user: actor(people.sam), timeZone: TZ }), 'saved');
    // The typo is merged by hand into the confirmed course.
    assert.equal(await runMergeLegacy(session(people.owner), { householdId: household, petId: 'rex', key: 'apoquell', courseId: legacyCourseId('heartworm'), user: actor(people.owner) }), 'saved');

    state = await legacyState();
    assert.deepEqual(state.pending, [], 'nothing left to confirm');
    // (The beforeEach's own Apoquel course is left out.)
    const dues = medicationDues(state.courses, state.logs, new Date(), TZ).filter((entry) => entry.courseId !== 'apoquel');
    assert.deepEqual(dues.map((entry) => [entry.medication, entry.courseId ?? null, entry.dueDay]), [['Heartworm', legacyCourseId('heartworm'), due]], 'same next due day, now from the course; no phantom');
    assert.equal(state.logs.length, 5, 'every legacy entry is kept as history');
  });
});
