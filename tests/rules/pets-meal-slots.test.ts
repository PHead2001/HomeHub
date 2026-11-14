/**
 * Meal slots (P2) against the Firestore emulator with the real rules: the pet's
 * `mealPlan` / `mealPlanHistory` validation (PE-22a, PE-22g, PE-22k), slot-bearing
 * feedings and the feeding state's `slotsFed` (D-P5, PE-22f), and the real feed
 * transaction (`runFeed`) assigning feeds to slots in two sessions, with a stale
 * "Feed again?" answer.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteField, doc, getDoc, getDocs, serverTimestamp, setDoc, Timestamp, updateDoc, writeBatch, type Firestore } from 'firebase/firestore';
import { localDay, localMinutes } from '../../functions/src/shared/calendar';
import { runFeed, runUndoFeed, type FeedPetInput, type FeedPetResult } from '../../src/lib/pets/feed-transaction';
import { feedConfirmOf, newFeedOpId } from '../../src/lib/pets/feed-plan';
import { timeOfMinutes } from '../../src/lib/pets/schedule-parser';

const projectId = 'demo-homehub-e2e';
const household = 'household-meal-slots';
const otherHousehold = 'household-meal-slots-b';
const TZ = 'America/Chicago';
let environment: RulesTestEnvironment;

const people = {
  owner: { uid: 'slots-owner', email: 'owner.slots@example.test', role: 'owner' },
  admin: { uid: 'slots-admin', email: 'admin.slots@example.test', role: 'admin' },
  sam: { uid: 'slots-sam', email: 'sam.slots@example.test', role: 'member' },
  alex: { uid: 'slots-alex', email: 'alex.slots@example.test', role: 'child' },
  guest: { uid: 'slots-guest', email: 'guest.slots@example.test', role: 'guest' },
  ownerB: { uid: 'slots-owner-b', email: 'owner.b.slots@example.test', role: 'owner' },
} as const;
type Person = (typeof people)[keyof typeof people];

const sessions = new Map<string, Firestore>();
/** One Firestore instance per person (like one device), so a batch never mixes instances. */
const session = (person: Person): Firestore => {
  if (!sessions.has(person.uid)) sessions.set(person.uid, environment.authenticatedContext(person.uid, { email: person.email }).firestore() as unknown as Firestore);
  return sessions.get(person.uid)!;
};
const petRef = (db: Firestore, pet = 'rex', home = household) => doc(db, 'households', home, 'pets', pet);
const logsOf = (db: Firestore, pet = 'rex', home = household) => collection(db, 'households', home, 'pets', pet, 'feeding-logs');
const stateOf = (db: Firestore, pet = 'rex', home = household) => doc(db, 'households', home, 'pets', pet, 'feeding-state', 'current');

const slot = (id: string, time: string, extra: Record<string, unknown> = {}) => ({ id, name: id[0].toUpperCase() + id.slice(1), time, amount: 1, unit: 'Cups', ...extra });
const BREAKFAST = slot('breakfast', '07:00');
const DINNER = slot('dinner', '18:00', { amount: 0.5, unit: 'Cans' });
/** A plan as the client confirms it (server time, the writer). */
const planBy = (person: Person, slots: unknown[], effectiveFrom = '2026-11-10') => ({ slots, effectiveFrom, confirmedAt: serverTimestamp(), confirmedByUid: person.uid, confirmedByName: 'Someone' });
/** A plan as stored (seeded with the rules off). */
const storedPlan = (slots: unknown[], effectiveFrom = '2026-11-10') => ({ slots, effectiveFrom, confirmedAt: Timestamp.fromDate(new Date('2026-11-10T12:00:00Z')), confirmedByUid: people.admin.uid });

async function seedPet(data: Record<string, unknown>, pet = 'rex', home = household) {
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(petRef(context.firestore() as unknown as Firestore, pet, home), { name: 'Rex', type: 'Dog', foodSchedule: 'twice daily', photoUrl: '', dataAiHint: 'dog', ...data });
  });
}

async function seedState(data: Record<string, unknown>) {
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(stateOf(context.firestore() as unknown as Firestore), data);
  });
}

async function seedLog(id: string, data: Record<string, unknown>) {
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(logsOf(context.firestore() as unknown as Firestore), id), data);
  });
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
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'households', household), { name: 'Slots', ownerUid: people.owner.uid, timeZone: TZ });
    await setDoc(doc(db, 'households', otherHousehold), { name: 'Other', ownerUid: people.ownerB.uid, timeZone: TZ });
    for (const person of Object.values(people)) {
      const home = person === people.ownerB ? otherHousehold : household;
      await setDoc(doc(db, 'households', home, 'members', person.uid), { uid: person.uid, role: person.role, status: 'active' });
    }
  });
});

after(async () => environment?.cleanup());

describe('meal plans on the pet: who may write them and what they may hold', () => {
  test('a member with pets.editProfiles creates a pet with a valid plan; others are refused', async () => {
    const data = (person: Person) => ({ name: 'Rex', type: 'Dog', foodSchedule: '', photoUrl: '', dataAiHint: 'dog', mealPlan: planBy(person, [BREAKFAST, DINNER]) });
    await assertSucceeds(setDoc(petRef(session(people.admin)), data(people.admin)));
    // Wrong role (member: no pets.editProfiles), signed out, and another household's owner.
    await assertFails(setDoc(petRef(session(people.sam), 'max'), data(people.sam)));
    await assertFails(setDoc(petRef(environment.unauthenticatedContext().firestore() as unknown as Firestore, 'max'), data(people.admin)));
    await assertFails(setDoc(petRef(session(people.ownerB), 'max'), data(people.ownerB)));
    // The other household's owner may write their own pet.
    await assertSucceeds(setDoc(petRef(session(people.ownerB), 'max', otherHousehold), data(people.ownerB)));
  });

  test('malformed slots are refused', async () => {
    const write = (slots: unknown[]) => setDoc(petRef(session(people.admin)), { name: 'Rex', type: 'Dog', mealPlan: planBy(people.admin, slots) });
    await assertSucceeds(write([BREAKFAST, slot('lunch', '12:00', { offDays: [0, 6] }), DINNER]));
    await assertFails(write([]));
    await assertFails(write(Array.from({ length: 7 }, (_unused, index) => slot(`meal${index}`, `0${index}:30`))));
    await assertFails(write([BREAKFAST, slot('breakfast', '08:00')])); // duplicate id
    await assertFails(write([BREAKFAST, slot('second', '07:00')])); // duplicate time
    await assertFails(write([slot('late', '24:00')]));
    await assertFails(write([slot('late', '7:00')]));
    await assertFails(write([slot('zero', '07:00', { amount: 0 })]));
    await assertFails(write([slot('huge', '07:00', { amount: 51 })]));
    await assertFails(write([slot('bowl', '07:00', { unit: 'Bowls' })]));
    await assertFails(write([slot('sunday', '07:00', { offDays: [7] })]));
    await assertFails(write([slot('never', '07:00', { offDays: [0, 1, 2, 3, 4, 5, 6] })]));
    await assertFails(write([slot('bad id!', '07:00')]));
    await assertFails(write([slot('long', '07:00', { name: 'x'.repeat(31) })]));
    await assertFails(write([slot('empty', '07:00', { name: '' })]));
    await assertFails(write([slot('extra', '07:00', { note: 'x' })]));
    await assertFails(write([{ id: 'missing', name: 'Missing', time: '07:00', amount: 1 }]));
  });

  test('the confirmation is signed by the writer at server time', async () => {
    const pet = (plan: Record<string, unknown>) => setDoc(petRef(session(people.admin)), { name: 'Rex', type: 'Dog', mealPlan: plan });
    await assertFails(pet({ ...planBy(people.admin, [BREAKFAST]), confirmedByUid: people.owner.uid }));
    await assertFails(pet({ ...planBy(people.admin, [BREAKFAST]), confirmedAt: Timestamp.fromDate(new Date('2026-01-01T00:00:00Z')) }));
    await assertFails(pet({ ...planBy(people.admin, [BREAKFAST]), effectiveFrom: 'today' }));
    await assertFails(pet({ ...planBy(people.admin, [BREAKFAST]), source: 'ai' }));
    const { confirmedAt: _dropped, ...unsigned } = planBy(people.admin, [BREAKFAST]);
    void _dropped;
    await assertFails(pet(unsigned));
  });

  test('a first plan may record the legacy target it replaces, nothing else', async () => {
    await seedPet({ feedingsPerDay: 2 });
    const db = session(people.admin);
    await assertFails(updateDoc(petRef(db), { mealPlan: planBy(people.admin, [BREAKFAST, DINNER], '2026-11-14'), mealPlanHistory: [{ until: '2026-11-13', perDay: 2 }] })); // until must be the effective day
    await assertFails(updateDoc(petRef(db), { mealPlan: planBy(people.admin, [BREAKFAST, DINNER], '2026-11-14'), mealPlanHistory: [{ until: '2026-11-14', slots: [BREAKFAST] }] })); // no invented past slots
    await assertFails(updateDoc(petRef(db), { mealPlan: planBy(people.admin, [BREAKFAST, DINNER], '2026-11-14'), mealPlanHistory: [{ until: '2026-11-14', perDay: 40 }] }));
    await assertSucceeds(updateDoc(petRef(db), {
      mealPlan: planBy(people.admin, [BREAKFAST, DINNER], '2026-11-14'),
      mealPlanHistory: [{ until: '2026-11-14', perDay: 2 }],
      feedingsPerDay: 2,
    }));
  });

  test('editing keeps the plan that applied before (PE-22g); history cannot be rewritten', async () => {
    const past = [{ until: '2026-11-10', perDay: 2 }];
    await seedPet({ mealPlan: storedPlan([BREAKFAST, DINNER], '2026-11-10'), mealPlanHistory: past });
    const db = session(people.admin);
    const earlier = (await getDoc(petRef(db))).data()!.mealPlan.slots;
    const later = [BREAKFAST, slot('dinner', '17:30', { amount: 0.5, unit: 'Cans' })];
    // A later effective day must append exactly the replaced slots.
    await assertFails(updateDoc(petRef(db), { mealPlan: planBy(people.admin, later, '2026-11-14') })); // history not kept
    await assertFails(updateDoc(petRef(db), { mealPlan: planBy(people.admin, later, '2026-11-14'), mealPlanHistory: [...past, { until: '2026-11-14', slots: later }] })); // forged previous slots
    await assertFails(updateDoc(petRef(db), { mealPlan: planBy(people.admin, later, '2026-11-14'), mealPlanHistory: [{ until: '2026-11-14', slots: earlier }] })); // an earlier entry dropped
    await assertFails(updateDoc(petRef(db), { mealPlan: planBy(people.admin, later, '2026-11-09'), mealPlanHistory: [...past, { until: '2026-11-09', slots: earlier }] })); // effective day moved back
    await assertSucceeds(updateDoc(petRef(db), { mealPlan: planBy(people.admin, later, '2026-11-14'), mealPlanHistory: [...past, { until: '2026-11-14', slots: earlier }] }));
    // A second edit the same day replaces today's plan and leaves the history alone.
    const history = (await getDoc(petRef(db))).data()!.mealPlanHistory;
    await assertFails(updateDoc(petRef(db), { mealPlan: planBy(people.admin, [BREAKFAST], '2026-11-14'), mealPlanHistory: [] }));
    await assertSucceeds(updateDoc(petRef(db), { mealPlan: planBy(people.admin, [BREAKFAST], '2026-11-14'), mealPlanHistory: history }));
    // A plan cannot be removed, and a member without pets.editProfiles cannot edit it.
    await assertFails(updateDoc(petRef(db), { mealPlan: deleteField() }));
    await assertFails(updateDoc(petRef(session(people.sam)), { mealPlan: planBy(people.sam, [DINNER], '2026-11-14'), mealPlanHistory: history }));
    // Other pet fields still save without touching the plan (older clients).
    await assertSucceeds(updateDoc(petRef(db), { foodSchedule: 'breakfast and dinner', photoUrl: 'https://placehold.co/300x300.png' }));
  });

  test('a full history drops only its oldest entry', async () => {
    const full = Array.from({ length: 10 }, (_unused, index) => ({ until: `2026-10-${String(index + 10)}`, slots: [slot('breakfast', `0${index}:00`)] }));
    await seedPet({ mealPlan: storedPlan([BREAKFAST], '2026-10-20'), mealPlanHistory: full });
    const db = session(people.admin);
    const earlier = (await getDoc(petRef(db))).data()!.mealPlan.slots;
    await assertFails(updateDoc(petRef(db), { mealPlan: planBy(people.admin, [DINNER], '2026-11-14'), mealPlanHistory: [...full.slice(2), full[0], { until: '2026-11-14', slots: earlier }] }));
    await assertSucceeds(updateDoc(petRef(db), { mealPlan: planBy(people.admin, [DINNER], '2026-11-14'), mealPlanHistory: [...full.slice(1), { until: '2026-11-14', slots: earlier }] }));
  });
});

describe('slot-bearing feedings and the feeding state (D-P5, PE-22f)', () => {
  // An override of `undefined` leaves the field out.
  const logData = (person: Person, overrides: Record<string, unknown> = {}) => Object.fromEntries(Object.entries({
    date: serverTimestamp(), loggedAt: serverTimestamp(), cups: 1, foodAmountType: 'Cups', foodType: 'Dry', comments: '', ampm: 'PM',
    loggedByUid: person.uid, loggedByName: 'Someone', repeat: 'none', slotId: 'dinner', ...overrides,
  }).filter(([, value]) => value !== undefined));
  const stateData = (person: Person, logId: string, overrides: Record<string, unknown> = {}) => ({
    lastLogId: logId, lastFedAt: serverTimestamp(), lastFedByUid: person.uid, lastFedByName: 'Someone', day: '2026-11-14', countOnDay: 2,
    slotsFed: { breakfast: 'breakfast-log', dinner: logId }, prev: null, ...overrides,
  });
  // The previous feeding as the derived state writes it (feedingStateHonest names it exactly).
  const STATE_FIELDS = ['lastLogId', 'lastFedAt', 'lastFedByUid', 'lastFedByName'];
  const feed = async (person: Person, logOverrides: Record<string, unknown> = {}, stateOverrides: (logId: string) => Record<string, unknown> = () => ({}), home = household) => {
    const db = session(person);
    const prevSnap = await getDoc(stateOf(db, 'rex', home)).catch(() => null);
    const prev = prevSnap?.exists() ? Object.fromEntries(STATE_FIELDS.map((field) => [field, prevSnap.data()[field] ?? null])) : null;
    const batch = writeBatch(db);
    const ref = doc(logsOf(db, 'rex', home));
    batch.set(ref, logData(person, logOverrides));
    batch.set(stateOf(db, 'rex', home), stateData(person, ref.id, { prev, ...stateOverrides(ref.id) }));
    return batch.commit();
  };

  // The state names its log at exactly the log's own time (feedingStateHonest).
  let breakfastAt = Timestamp.fromMillis(0);
  beforeEach(async () => {
    breakfastAt = Timestamp.fromMillis(Date.now() - 30 * 60_000);
    await seedPet({ mealPlan: storedPlan([BREAKFAST, DINNER]), feedingsPerDay: 2 });
    // Breakfast was fed 30 minutes ago (the latest feed; "today" is the state's day).
    await seedLog('breakfast-log', { date: breakfastAt, loggedAt: breakfastAt, cups: 1, loggedByUid: people.sam.uid, loggedByName: 'Sam', repeat: 'none', slotId: 'breakfast' });
    await seedState({
      lastLogId: 'breakfast-log', lastFedAt: breakfastAt, lastFedByUid: people.sam.uid, lastFedByName: 'Sam',
      day: '2026-11-14', countOnDay: 1, slotsFed: { breakfast: 'breakfast-log' }, prev: null,
    });
  });

  test('an unfed slot may be fed inside 90 minutes of another slot, recorded in slotsFed', async () => {
    await assertSucceeds(feed(people.alex));
  });

  test('a slot already fed today is refused without a confirmation, allowed with one', async () => {
    await assertFails(feed(people.alex, { slotId: 'breakfast' }, (logId) => ({ slotsFed: { breakfast: logId } })));
    await assertFails(feed(people.alex, { slotId: 'breakfast' }, () => ({ slotsFed: { breakfast: 'breakfast-log' } })));
    await assertSucceeds(feed(people.alex, { slotId: 'breakfast', repeat: 'confirmed', confirmOf: 'breakfast-log' }, () => ({ slotsFed: { breakfast: 'breakfast-log' } })));
  });

  test('a fed slot whose log is gone, or fed on another day, is free again', async () => {
    await environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(stateOf(context.firestore() as unknown as Firestore), {
        lastLogId: 'breakfast-log', lastFedAt: breakfastAt, lastFedByUid: people.sam.uid, lastFedByName: 'Sam',
        day: '2026-11-13', countOnDay: 1, slotsFed: { breakfast: 'breakfast-log', dinner: 'deleted-log' }, prev: null,
      });
    });
    await assertSucceeds(feed(people.alex, {}, (logId) => ({ slotsFed: { dinner: logId } })));
  });

  test('a forged or malformed slot, a state that does not record the slot, and other writers are refused', async () => {
    await assertFails(feed(people.alex, { slotId: 'lunch' }, (logId) => ({ slotsFed: { breakfast: 'breakfast-log', lunch: logId } }))); // not in the plan
    await assertFails(feed(people.alex, { slotId: 'din ner' })); // malformed id
    await assertFails(feed(people.alex, { slotId: 42 })); // not a string
    await assertFails(feed(people.alex, {}, () => ({ slotsFed: { breakfast: 'breakfast-log' } }))); // state does not record the slot
    await assertFails(feed(people.alex, {}, () => ({ slotsFed: { dinner: 'someone-else' } }))); // state records another log
    await assertFails(feed(people.alex, {}, () => ({ slotsFed: 'dinner' }))); // slotsFed must be a map
    await assertFails(feed(people.guest)); // wrong role (no pets.addLogs)
    await seedPet({ mealPlan: storedPlan([BREAKFAST, DINNER]) }, 'rex', otherHousehold);
    await assertFails(feed(people.alex, {}, () => ({}), otherHousehold)); // another household
  });

  test('without a slot, the 2.1 checks still apply on a pet with slots', async () => {
    await assertFails(feed(people.alex, { slotId: undefined }, () => ({ slotsFed: { breakfast: 'breakfast-log' } }))); // inside 90 minutes
    await assertSucceeds(feed(people.alex, { slotId: undefined, repeat: 'confirmed', confirmOf: 'breakfast-log' }, () => ({ slotsFed: { breakfast: 'breakfast-log' } })));
  });

  test('a slot never changes after the feeding is written', async () => {
    const original = Timestamp.fromMillis(Date.now() - 60_000);
    await seedLog('own-log', { date: original, loggedAt: original, cups: 1, loggedByUid: people.alex.uid, repeat: 'none', slotId: 'breakfast' });
    const correction = { date: Timestamp.fromMillis(Date.now() - 2 * 60_000), dateCorrectedAt: serverTimestamp(), dateCorrectedByUid: people.alex.uid, originalDate: original };
    await assertFails(updateDoc(doc(logsOf(session(people.alex)), 'own-log'), { ...correction, slotId: 'dinner' }));
    await assertFails(updateDoc(doc(logsOf(session(people.alex)), 'own-log'), { ...correction, slotId: deleteField() }));
    await assertSucceeds(updateDoc(doc(logsOf(session(people.alex)), 'own-log'), correction));
  });
});

describe('the feed transaction with slots, on the emulator with the real rules', () => {
  /** Slots around the real current Chicago time: one whose time has just passed (due now), one six hours away. */
  const slotsAroundNow = () => {
    const now = localMinutes(new Date(), TZ);
    const dueTime = Math.max(0, now - 5);
    const other = dueTime + 6 * 60 < 24 * 60 ? dueTime + 6 * 60 : dueTime - 6 * 60;
    const due = slot('due', timeOfMinutes(dueTime), { name: 'Supper', amount: 0.5, unit: 'Cans' });
    const away = slot('away', timeOfMinutes(other), { name: 'Snack' });
    return { due, away, awayIsLater: other > dueTime };
  };
  const press = (person: Person, overrides: Partial<FeedPetInput> = {}): FeedPetInput => ({
    householdId: household,
    petId: 'rex',
    opId: newFeedOpId(),
    portion: { amount: 1, unit: 'Cups' },
    portionFromSlot: true,
    food: 'Dry',
    user: { uid: person.uid, name: person.uid },
    timeZone: TZ,
    ...overrides,
  });
  const saved = (result: FeedPetResult) => {
    assert.notEqual(result.status, 'needsConfirm', `expected a write, got ${JSON.stringify(result)}`);
    return result as Extract<FeedPetResult, { status: 'saved' | 'queued' }>;
  };
  const allLogs = async () => {
    let docs: Record<string, unknown>[] = [];
    await environment.withSecurityRulesDisabled(async (context) => {
      docs = (await getDocs(logsOf(context.firestore() as unknown as Firestore))).docs.map((entry) => ({ id: entry.id, ...entry.data() }));
    });
    return docs;
  };

  test('a feed goes to the due slot with its portion; the state records it', async () => {
    const { due, away } = slotsAroundNow();
    await seedPet({ mealPlan: storedPlan([due, away], localDay(new Date(), TZ)) });
    const result = saved(await runFeed(session(people.sam), press(people.sam)));
    assert.deepEqual(result.slot, { id: 'due', name: 'Supper' });
    assert.deepEqual(result.portion, { amount: 0.5, unit: 'Cans' });
    const [log] = await allLogs();
    assert.equal(log.slotId, 'due');
    assert.equal(log.cups, 0.5);
    assert.equal(log.foodAmountType, 'Cans');
    const state = (await getDoc(stateOf(session(people.sam)))).data()!;
    assert.deepEqual(state.slotsFed, { due: result.logId });
    // Undo recounts the fed slots from the surviving logs.
    await runUndoFeed(session(people.sam), { householdId: household, petId: 'rex', logId: result.logId, timeZone: TZ });
    const undone = (await getDoc(stateOf(session(people.sam)))).data()!;
    assert.deepEqual(undone.slotsFed, {});
    assert.equal(undone.countOnDay, 0);
  });

  test('two sessions feeding the due slot at once record one meal; the other is asked', async () => {
    const { due, away } = slotsAroundNow();
    await seedPet({ mealPlan: storedPlan([due, away], localDay(new Date(), TZ)) });
    const [a, b] = await Promise.all([runFeed(session(people.sam), press(people.sam)), runFeed(session(people.alex), press(people.alex))]);
    assert.deepEqual([a.status, b.status].sort(), ['needsConfirm', 'saved']);
    const asked = a.status === 'needsConfirm' ? a : b;
    assert.equal(asked.status, 'needsConfirm');
    // The due slot is fed: the next meal is not open yet and the feed was just now (or nothing is left today).
    assert.ok(asked.status === 'needsConfirm' && ['recent', 'slot-fed', 'complete'].includes(asked.reason ?? ''), JSON.stringify(asked));
    const logs = await allLogs();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].slotId, 'due');
  });

  test('a stale "Feed again?" answer is asked again naming the newer feeder; a current one writes once', async () => {
    const { due, away } = slotsAroundNow();
    await seedPet({ mealPlan: storedPlan([due, away], localDay(new Date(), TZ)) });
    saved(await runFeed(session(people.sam), press(people.sam)));
    const alexPress = press(people.alex);
    const asked = await runFeed(session(people.alex), alexPress);
    assert.equal(asked.status, 'needsConfirm');
    const stale = asked.status === 'needsConfirm' ? feedConfirmOf(asked) : null;
    // The owner is asked as well, confirms, and feeds.
    const ownerPress = press(people.owner);
    const ownerAsked = await runFeed(session(people.owner), ownerPress);
    saved(await runFeed(session(people.owner), { ...ownerPress, confirm: ownerAsked.status === 'needsConfirm' ? feedConfirmOf(ownerAsked) : null }));
    const again = await runFeed(session(people.alex), { ...alexPress, confirm: stale });
    assert.equal(again.status, 'needsConfirm');
    assert.equal(again.status === 'needsConfirm' && again.staleConfirm, true);
    assert.equal(again.status === 'needsConfirm' && again.lastFedByUid, people.owner.uid);
    assert.equal((await allLogs()).length, 2);
    const current = again.status === 'needsConfirm' ? feedConfirmOf(again) : null;
    saved(await runFeed(session(people.alex), { ...alexPress, confirm: current }));
    // The same press answered twice still records one.
    saved(await runFeed(session(people.alex), { ...alexPress, confirm: current }));
    const logs = await allLogs();
    assert.equal(logs.length, 3);
    const alexLog = logs.find((log) => log.id === alexPress.opId)!;
    assert.equal(alexLog.repeat, 'confirmed');
    assert.equal(alexLog.confirmOf, ownerPress.opId);
  });

  test('a pet without confirmed slots keeps the 2.1 behaviour and writes no slot', async () => {
    await seedPet({ feedingsPerDay: 2 });
    const result = saved(await runFeed(session(people.sam), press(people.sam)));
    assert.equal(result.slot ?? null, null);
    assert.deepEqual(result.portion, { amount: 1, unit: 'Cups' });
    const [log] = await allLogs();
    assert.equal('slotId' in log, false);
    const state = (await getDoc(stateOf(session(people.sam)))).data()!;
    assert.equal('slotsFed' in state, false);
    const asked = await runFeed(session(people.alex), press(people.alex));
    assert.equal(asked.status === 'needsConfirm' && asked.reason, 'recent');
  });
});
