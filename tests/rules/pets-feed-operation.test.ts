/**
 * The shared feed operation against the Firestore emulator with the real rules
 * (PE-23c/g/h, PE-5e): `runFeed`, `runUndoFeed` and `runCorrectFeedTime` from
 * src/lib/pets/feed-transaction.ts, the same code the app runs (it only binds
 * the app's Firestore instead of these test sessions).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, setDoc, type Firestore } from 'firebase/firestore';
import { runCorrectFeedTime, runFeed, runUndoFeed, type FeedPetInput, type FeedPetResult } from '../../src/lib/pets/feed-transaction';
import { feedConfirmOf, newFeedOpId } from '../../src/lib/pets/feed-plan';
import { toDate } from '../../src/lib/pets/care';

const projectId = 'demo-homehub-e2e';
const household = 'household-feed-op';
const TZ = 'America/Chicago';
let environment: RulesTestEnvironment;

const people = {
  sam: { uid: 'feed-sam', email: 'sam.feed@example.test', role: 'member' },
  alex: { uid: 'feed-alex', email: 'alex.feed@example.test', role: 'child' },
  owner: { uid: 'feed-owner', email: 'owner.feed@example.test', role: 'owner' },
} as const;
type Person = (typeof people)[keyof typeof people];

/** A separate signed-in session (its own Firestore instance), like a second device. */
const session = (person: Person) => environment.authenticatedContext(person.uid, { email: person.email }).firestore() as unknown as Firestore;
const logsOf = (db: Firestore) => collection(db, 'households', household, 'pets', 'rex', 'feeding-logs');
const stateOf = (db: Firestore) => doc(db, 'households', household, 'pets', 'rex', 'feeding-state', 'current');

const press = (person: Person, overrides: Partial<FeedPetInput> = {}): FeedPetInput => ({
  householdId: household,
  petId: 'rex',
  opId: newFeedOpId(),
  portion: { amount: 1, unit: 'Cups' },
  food: 'Dry',
  user: { uid: person.uid, name: person.uid },
  timeZone: TZ,
  ...overrides,
});

const saved = (result: FeedPetResult) => {
  assert.notEqual(result.status, 'needsConfirm', `expected a write, got ${JSON.stringify(result)}`);
  return result as Extract<FeedPetResult, { status: 'saved' | 'queued' }>;
};

async function feedingCount(): Promise<number> {
  let count = 0;
  await environment.withSecurityRulesDisabled(async (context) => {
    count = (await getDocs(collection(context.firestore(), 'households', household, 'pets', 'rex', 'feeding-logs'))).size;
  });
  return count;
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
    await setDoc(doc(db, 'households', household), { name: 'Feed op', ownerUid: people.owner.uid, timeZone: TZ });
    for (const person of Object.values(people)) {
      await setDoc(doc(db, 'households', household, 'members', person.uid), { uid: person.uid, role: person.role, status: 'active' });
    }
    await setDoc(doc(db, 'households', household, 'pets', 'rex'), { name: 'Rex', type: 'Dog', foodSchedule: 'twice daily', feedingsPerDay: 2 });
  });
});

after(async () => environment?.cleanup());

describe('the feed operation on the emulator with the real rules', () => {
  test('two concurrent runs of the same press (two sessions) record one feeding', async () => {
    const input = press(people.sam);
    const [first, second] = await Promise.all([runFeed(session(people.sam), input), runFeed(session(people.sam), input)]);
    const results = [saved(first), saved(second)];
    assert.ok(results.every((result) => result.logId === input.opId));
    assert.equal(results.filter((result) => result.replayed).length, 1, 'one run wrote, the other found it');
    assert.equal(await feedingCount(), 1);
    // A retry after an uncertain response (the same press again) still records nothing new.
    const retry = saved(await runFeed(session(people.sam), input));
    assert.equal(retry.replayed, true);
    assert.equal(await feedingCount(), 1);
    const state = (await getDoc(stateOf(session(people.sam)))).data()!;
    assert.equal(state.lastLogId, input.opId);
    assert.equal(state.countOnDay, 1);
  });

  test('two different presses at once: one feeds, the other is asked "Feed again?"', async () => {
    const [a, b] = await Promise.all([runFeed(session(people.sam), press(people.sam)), runFeed(session(people.alex), press(people.alex))]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, ['needsConfirm', 'saved']);
    assert.equal(await feedingCount(), 1);
  });

  test('a stale "Feed again?" is refused and asked again with the newer feeder; a current one writes once', async () => {
    saved(await runFeed(session(people.sam), press(people.sam)));
    // Alex is asked about Sam's feed.
    const alexPress = press(people.alex);
    const asked = await runFeed(session(people.alex), alexPress);
    assert.equal(asked.status, 'needsConfirm');
    assert.equal(asked.status === 'needsConfirm' && asked.lastFedByUid, people.sam.uid);
    const staleAnswer = asked.status === 'needsConfirm' ? feedConfirmOf(asked) : null;
    // Meanwhile the owner is asked too, confirms, and feeds.
    const ownerPress = press(people.owner);
    const ownerAsked = await runFeed(session(people.owner), ownerPress);
    assert.equal(ownerAsked.status, 'needsConfirm');
    saved(await runFeed(session(people.owner), { ...ownerPress, confirm: ownerAsked.status === 'needsConfirm' ? feedConfirmOf(ownerAsked) : null }));
    assert.equal(await feedingCount(), 2);
    // Alex's answer was for Sam's feed: it does not write, and the new question names the owner.
    const again = await runFeed(session(people.alex), { ...alexPress, confirm: staleAnswer });
    assert.equal(again.status, 'needsConfirm');
    assert.equal(again.status === 'needsConfirm' && again.staleConfirm, true);
    assert.equal(again.status === 'needsConfirm' && again.lastFedByUid, people.owner.uid);
    assert.equal(await feedingCount(), 2);
    // Answering the current question writes exactly one confirmed feeding, bound to the owner's feed.
    const confirmed = saved(await runFeed(session(people.alex), { ...alexPress, confirm: again.status === 'needsConfirm' ? feedConfirmOf(again) : null }));
    assert.equal(await feedingCount(), 3);
    const log = (await getDoc(doc(logsOf(session(people.alex)), confirmed.logId))).data()!;
    assert.equal(log.repeat, 'confirmed');
    assert.equal(log.confirmOf, ownerPress.opId);
    // Pressing "Feed again" twice (the same press) still records one.
    saved(await runFeed(session(people.alex), { ...alexPress, confirm: again.status === 'needsConfirm' ? feedConfirmOf(again) : null }));
    assert.equal(await feedingCount(), 3);
  });

  test('after a correction makes an older feeding the newest, "Feed again?" binds to it and a current answer writes', async () => {
    // A by Sam, then B by the owner (confirmed), then A corrected to after B: A is the newest by effective time.
    const a = saved(await runFeed(session(people.sam), press(people.sam)));
    const ownerPress = press(people.owner);
    const ownerAsked = await runFeed(session(people.owner), ownerPress);
    assert.equal(ownerAsked.status, 'needsConfirm');
    const b = saved(await runFeed(session(people.owner), { ...ownerPress, confirm: ownerAsked.status === 'needsConfirm' ? feedConfirmOf(ownerAsked) : null }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runCorrectFeedTime(session(people.owner), {
      householdId: household, petId: 'rex', logId: a.logId, date: new Date(), user: { uid: people.owner.uid, name: 'Owner' }, canDeleteLogs: true, timeZone: TZ,
    });
    const state = (await getDoc(stateOf(session(people.owner)))).data()!;
    assert.equal(state.lastLogId, b.logId, 'the state still names B');
    // Alex is asked about A (the newest by effective time) and answers: the feed is written once.
    const alexPress = press(people.alex);
    const asked = await runFeed(session(people.alex), alexPress);
    assert.equal(asked.status, 'needsConfirm');
    assert.equal(asked.status === 'needsConfirm' && asked.lastLogId, a.logId);
    const answer = asked.status === 'needsConfirm' ? feedConfirmOf(asked) : null;
    const fed = saved(await runFeed(session(people.alex), { ...alexPress, confirm: answer }));
    assert.equal((await getDoc(doc(logsOf(session(people.alex)), fed.logId))).data()!.confirmOf, a.logId);
    assert.equal(await feedingCount(), 3);
    // That answer is now stale for a new press: it asks again (naming Alex) and writes nothing.
    const again = await runFeed(session(people.sam), press(people.sam, { confirm: answer }));
    assert.equal(again.status, 'needsConfirm');
    assert.equal(again.status === 'needsConfirm' && again.staleConfirm, true);
    assert.equal(again.status === 'needsConfirm' && again.lastFedByUid, people.alex.uid);
    assert.equal(await feedingCount(), 3);
  });

  test('Undo restores the previous feed; a correction moves the effective time and keeps the recorded one', async () => {
    const first = saved(await runFeed(session(people.sam), press(people.sam)));
    const asked = await runFeed(session(people.alex), press(people.alex, { opId: 'alex-press-0001' }));
    assert.equal(asked.status, 'needsConfirm');
    const second = saved(await runFeed(session(people.alex), press(people.alex, { opId: 'alex-press-0001', confirm: asked.status === 'needsConfirm' ? feedConfirmOf(asked) : null })));
    await runUndoFeed(session(people.alex), { householdId: household, petId: 'rex', logId: second.logId, timeZone: TZ });
    let state = (await getDoc(stateOf(session(people.sam)))).data()!;
    assert.equal(state.lastLogId, first.logId);
    assert.equal(state.countOnDay, 1);

    // Sam corrects his own feeding (within 10 minutes) to 40 minutes ago.
    const before = (await getDoc(doc(logsOf(session(people.sam)), first.logId))).data()!;
    const corrected = new Date(Date.now() - 40 * 60_000);
    corrected.setMilliseconds(0);
    await runCorrectFeedTime(session(people.sam), {
      householdId: household, petId: 'rex', logId: first.logId, date: corrected, user: { uid: people.sam.uid, name: 'Sam' }, canDeleteLogs: false, timeZone: TZ,
    });
    const after = (await getDoc(doc(logsOf(session(people.sam)), first.logId))).data()!;
    assert.equal(toDate(after.date)?.getTime(), corrected.getTime());
    assert.equal(toDate(after.originalDate)?.getTime(), toDate(before.date)?.getTime());
    assert.equal(toDate(after.loggedAt)?.getTime(), toDate(before.loggedAt)?.getTime(), 'loggedAt never changes');
    assert.equal(after.dateCorrectedByUid, people.sam.uid);
    state = (await getDoc(stateOf(session(people.sam)))).data()!;
    assert.equal(toDate(state.lastFedAt)?.getTime(), corrected.getTime());
    // Alex (a child, not the author, no pets.deleteLogs) cannot correct it.
    await assert.rejects(runCorrectFeedTime(session(people.alex), {
      householdId: household, petId: 'rex', logId: first.logId, date: new Date(Date.now() - 50 * 60_000), user: { uid: people.alex.uid, name: 'Alex' }, canDeleteLogs: false, timeZone: TZ,
    }));
  });
});
