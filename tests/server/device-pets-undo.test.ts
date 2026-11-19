import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { doc, serverTimestamp, Timestamp as ClientTimestamp, writeBatch, type Firestore as ClientFirestore } from 'firebase/firestore';
import { adminAuth, adminDb } from '../../src/lib/server/firebase-admin';
import { DeviceActionError } from '../../src/lib/server/device-gate';
import {
  addCareFromTablet,
  feedPetFromTablet,
  undoCareFromTablet,
  undoFeedFromTablet,
  type DeviceFeedRequest,
} from '../../src/lib/server/device-pets';
import { createDeviceRepairCode, redeemDeviceCode } from '../../src/lib/server/device-management';
import { completeChoreFromTablet } from '../../src/lib/server/device-chores';
import { setMyPin, verifyDevicePin } from '../../src/lib/server/pins';
import { UNDO_PROVEN } from '../../src/lib/devices/action-policy';
import { feedPetFromTabletAction } from '../../src/app/pets/device-actions';
import { runCorrectFeedTime, runFeed, type FeedPetInput } from '../../src/lib/pets/feed-transaction';
import { feedConfirmOf } from '../../src/lib/pets/feed-plan';
import { householdDay } from '../../src/lib/pets/feed-decision';
import { localMinutes } from '../../functions/src/shared/calendar';
import { clientSession, deleteDeviceUsers, nonce, personToken, seedHousehold, signIn, type Person } from './device-test-helpers';
import { house, opId, pairTablet, seedKid, tokenGeneration, type Tablet } from './device-actor-helpers';

// The Undo proof for Pets on wall tablets (design 10.4; tracker WT-20f), with real ID
// tokens: for `pets.feed` (live, and backdated within 12 hours) and `pets.care.add`:
// (1) a personal client and another tablet change things in between: the Undo removes only
// its own entry and a later feed stays the latest (or refuses `changed_since` for an edited
// entry), (2) a reload Undoes by the journal's opId inside the window and is refused after
// it, (3) a dropped connection repeats the action (one entry) and the Undo (then `already`),
// (4) action, Undo, late retry, (5) Undo before the action, (6) a queued send in flight with
// its Undo concurrently, both orders, (7) the wrong principal. Plus the bound "Feed again?"
// across devices (PE-23g), meal slots (D-P5/D-P21), attribution (PE-17c), PIN for backdating
// older than 12 hours (JC-27), the points PIN not applying (D-P6), answers without emails,
// and the server's writes replayed through the rules as the person would write them.
// Real time is used (feeds carry the emulator's server time); several tablets keep every
// group inside the per-tablet rate window.

const H = 'dev-pets-house';
const TZ = 'America/Chicago';
const owner: Person = { uid: 'dp-owner', email: 'dp.owner@example.test', displayName: 'Olive', role: 'owner' };
const member: Person = { uid: 'dp-member', email: 'dp.member@example.test', displayName: 'Max', role: 'member' };
const child: Person = { uid: 'dp-child', email: 'dp.child@example.test', displayName: 'Cleo', role: 'child' };
const KID = 'kid_DevPetsKid000000000';
const created = new Set<string>();
const tablets: Record<'feed' | 'backdated' | 'care' | 'extra' | 'parity' | 'other' | 'line' | 'reuse', Tablet> = {} as never;
let ownerDb: ClientFirestore;
let memberDb: ClientFirestore;
const closers: Array<() => Promise<void>> = [];

const pet = (id: string) => house(H).collection('pets').doc(id);
const logs = (id: string) => pet(id).collection('feeding-logs');
const care = (id: string) => pet(id).collection('care-logs');
const state = (id: string) => pet(id).collection('feeding-state').doc('current');
const countLogs = async (id: string) => (await logs(id).get()).size;
const later = (ms: number) => new Date(Date.now() + ms);

const refused = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DeviceActionError, `expected DeviceActionError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
};

const seedPet = async (id: string, extra: Record<string, unknown> = {}) => {
  await adminDb.recursiveDelete(pet(id));
  await pet(id).set({ name: `Pet ${id}`, type: 'Dog', foodSchedule: '1 cup twice daily', feedingsPerDay: 2, portionAmount: 1, portionUnit: 'Cups', ...extra });
};

type Variant = 'live' | 'backdated';
const variantExtra = (variant: Variant) => (variant === 'backdated' ? { backdatedAt: later(-60 * 60_000).toISOString() } : {});

const feedRequest = (t: Tablet, actorUid: string, op: string, petId: string, extra: Partial<DeviceFeedRequest> = {}): DeviceFeedRequest => ({
  idToken: t.idToken, householdId: H, actorUid, opId: op, petId, portion: { amount: 1, unit: 'Cups' }, food: 'Dry', ...extra,
});
const feed = (t: Tablet, actorUid: string, op: string, petId: string, extra: Partial<DeviceFeedRequest> = {}, now?: Date) =>
  feedPetFromTablet(feedRequest(t, actorUid, op, petId, extra), now ? { clock: () => now } : {});
/** Feeds, answering "Feed again?" with the state it was shown for (as the tablet's prompt does). */
const feedSure = async (t: Tablet, actorUid: string, op: string, petId: string, extra: Partial<DeviceFeedRequest> = {}) => {
  let answer = await feed(t, actorUid, op, petId, extra);
  for (let i = 0; answer.result.status === 'needsConfirm' && i < 3; i += 1) {
    const check = answer.result;
    answer = await feed(t, actorUid, op, petId, { ...extra, confirm: { lastLogId: check.lastLogId, countToday: check.countToday, ...(check.slotId !== undefined ? { slotId: check.slotId } : {}) } });
  }
  assert.equal(answer.result.status, 'saved');
  return answer;
};
const undoFeed = (t: Tablet, actorUid: string, op: string, extra: Record<string, unknown> = {}, now?: Date) =>
  undoFeedFromTablet({ idToken: t.idToken, householdId: H, actorUid, opId: op, ...extra }, now ? { clock: () => now } : {});
const addCare = (t: Tablet, actorUid: string, op: string, petId: string, extra: Record<string, unknown> = {}, now?: Date) =>
  addCareFromTablet({ idToken: t.idToken, householdId: H, actorUid, opId: op, petId, activity: 'Walk', notes: '', ...extra }, now ? { clock: () => now } : {});
const undoCare = (t: Tablet, actorUid: string, op: string, extra: Record<string, unknown> = {}, now?: Date) =>
  undoCareFromTablet({ idToken: t.idToken, householdId: H, actorUid, opId: op, ...extra }, now ? { clock: () => now } : {});
const queued = (t: Tablet, msAgo: number) => ({ queued: { createdAt: later(-msAgo).toISOString(), generation: tokenGeneration(t.idToken) } });

/** A personal client's feed (the shared client operation), answering "Feed again?" once. */
const personalFeed = async (db: ClientFirestore, person: Person, petId: string, op: string) => {
  const input: FeedPetInput = {
    householdId: H, petId, opId: op, portion: { amount: 1, unit: 'Cups' }, food: 'Dry', timeZone: TZ,
    user: { uid: person.uid, name: person.displayName ?? person.uid },
  };
  let result = await runFeed(db, input);
  if (result.status === 'needsConfirm') result = await runFeed(db, { ...input, confirm: feedConfirmOf(result) });
  assert.equal(result.status, 'saved');
};

before(async () => {
  await seedHousehold(H, [owner, member, child], { timeZone: TZ });
  await seedKid(H, KID, 'Mia');
  tablets.feed = await pairTablet(H, owner, created, 'Kitchen tablet');
  tablets.backdated = await pairTablet(H, owner, created, 'Pantry tablet');
  tablets.care = await pairTablet(H, owner, created, 'Mudroom tablet');
  tablets.extra = await pairTablet(H, owner, created, 'Den tablet');
  tablets.parity = await pairTablet(H, owner, created, 'Office tablet');
  tablets.other = await pairTablet(H, owner, created, 'Hall tablet');
  tablets.line = await pairTablet(H, owner, created, 'Porch tablet');
  tablets.reuse = await pairTablet(H, owner, created, 'Garage tablet');
  for (const person of [owner, member]) {
    await adminAuth.deleteUser(person.uid).catch(() => undefined);
    await adminAuth.createUser({ uid: person.uid, email: person.email });
  }
  const ownerSession = await clientSession(await adminAuth.createCustomToken(owner.uid));
  const memberSession = await clientSession(await adminAuth.createCustomToken(member.uid));
  ownerDb = ownerSession.db;
  memberDb = memberSession.db;
  closers.push(ownerSession.close, memberSession.close);
});

after(async () => {
  await Promise.all(closers.map((close) => close()));
  await deleteDeviceUsers([...created]);
  await adminDb.recursiveDelete(house(H));
  const codes = await adminDb.collection('deviceCodes').where('householdId', '==', H).get();
  await Promise.all(codes.docs.map((d) => d.ref.delete()));
});

describe('pets feeding and care are face-level with their Undo proven', () => {
  test('UNDO_PROVEN holds the pets capabilities proven in this file', () => {
    for (const capability of ['pets.feed', 'pets.feed.backdated', 'pets.feed.undo', 'pets.care.add', 'pets.care.undo'] as const) {
      assert.ok(UNDO_PROVEN.has(capability), capability);
    }
    assert.equal(UNDO_PROVEN.has('pets.feed.backdated.old'), false, 'older backdating stays PIN-level (JC-27)');
  });
});

for (const variant of ['live', 'backdated'] as const) {
  const t = () => (variant === 'live' ? tablets.feed : tablets.backdated);
  const extra = () => variantExtra(variant);
  describe(`pets.feed (${variant})`, () => {
    test('the selected person is credited; the log carries the tablet attribution; log id == opId (PE-17c)', async () => {
      const id = `${variant}-credit`;
      await seedPet(id);
      const op = opId();
      const { result, level, capability } = await feed(t(), KID, op, id, extra());
      assert.equal(result.status, 'saved');
      assert.equal(level, 'face');
      assert.equal(capability, variant === 'live' ? 'pets.feed' : 'pets.feed.backdated');
      const log = (await logs(id).doc(op).get()).data()!;
      assert.equal(log.loggedByUid, KID);
      assert.equal(log.loggedByName, 'Mia');
      assert.deepEqual(log.deviceAttribution, { deviceId: t().deviceId, deviceName: variant === 'live' ? 'Kitchen tablet' : 'Pantry tablet', generation: 1, actorUid: KID, level: 'face' });
      assert.equal(log.repeat, 'none');
      if (variant === 'backdated') assert.equal(log.backdated, true);
      assert.equal((await state(id).get()).get('lastLogId'), op);
    });

    test('case 1: a personal client and another tablet feed in between: the Undo removes only its own feed and the later feed stays the latest', async () => {
      const id = `${variant}-between`;
      await seedPet(id);
      const op = opId();
      await feed(t(), member.uid, op, id, extra());
      const personalOp = opId();
      await personalFeed(ownerDb, owner, id, personalOp);
      const hallOp = opId();
      await feedSure(tablets.other, child.uid, hallOp, id);
      assert.equal((await undoFeed(t(), member.uid, op, {}, later(3000))).status, 'undone');
      assert.equal((await logs(id).doc(op).get()).exists, false);
      assert.equal((await logs(id).doc(personalOp).get()).exists, true);
      const current = (await state(id).get()).data()!;
      assert.equal(current.lastLogId, hallOp, 'the latest feed stays the latest');
      assert.equal(current.prev.lastLogId, personalOp);

      // A personal correction of the tablet's feed in between: never reverted here.
      const fixed = `${variant}-corrected`;
      await seedPet(fixed);
      const corrected = opId();
      await feed(t(), member.uid, corrected, fixed, extra());
      await runCorrectFeedTime(ownerDb, { householdId: H, petId: fixed, logId: corrected, date: later(-2 * 60 * 60_000), user: { uid: owner.uid, name: 'Olive' }, canDeleteLogs: true, timeZone: TZ });
      await refused(undoFeed(t(), member.uid, corrected, {}, later(2000)), 'changed_since');
      assert.equal((await logs(fixed).doc(corrected).get()).exists, true);
    });

    test('case 2: after a reload the journal opId Undoes inside the window and is refused after it', async () => {
      const id = `${variant}-reload`;
      await seedPet(id);
      const inside = opId();
      await feed(t(), member.uid, inside, id, extra());
      assert.equal((await undoFeed(t(), member.uid, inside, {}, later(9000))).status, 'undone');
      const outside = opId();
      await feedSure(t(), member.uid, outside, id, extra());
      await refused(undoFeed(t(), member.uid, outside, {}, later(15_500)), 'undo_expired');
      assert.equal((await logs(id).doc(outside).get()).exists, true);
    });

    test('case 3: a dropped connection repeats the feed (one log) and the Undo (then already)', async () => {
      const id = `${variant}-dropped`;
      await seedPet(id);
      const op = opId();
      await feed(t(), member.uid, op, id, extra());
      const repeat = await feed(t(), member.uid, op, id, extra());
      assert.equal(repeat.result.status, 'saved');
      assert.equal(await countLogs(id), 1);
      assert.equal((await undoFeed(t(), member.uid, op)).status, 'undone');
      assert.equal((await undoFeed(t(), member.uid, op)).status, 'already');
      assert.equal(await countLogs(id), 0);
    });

    test('case 4: feed, Undo, then a late retry of the feed is already undone', async () => {
      const id = `${variant}-late`;
      await seedPet(id);
      const op = opId();
      await feed(t(), member.uid, op, id, extra());
      await undoFeed(t(), member.uid, op);
      await refused(feed(t(), member.uid, op, id, extra()), 'already_undone');
      assert.equal(await countLogs(id), 0);
    });

    test('case 5: the Undo arrives first (a tombstone), then the feed is refused', async () => {
      const id = `${variant}-first`;
      await seedPet(id);
      const op = opId();
      assert.equal((await undoFeed(t(), member.uid, op)).status, 'not_applied');
      await refused(feed(t(), member.uid, op, id, extra()), 'already_undone');
      assert.equal(await countLogs(id), 0);
    });

    test('case 6: a queued feed in flight and its Undo at once, both orders, leave no log', async () => {
      for (const order of ['action-first', 'undo-first'] as const) {
        const id = `${variant}-race-${order}`;
        await seedPet(id);
        const op = opId();
        const action = feedPetFromTablet({ ...feedRequest(t(), member.uid, op, id, extra()), ...queued(t(), 30_000) }).catch((error) => error);
        const undo = undoFeedFromTablet({ idToken: t().idToken, householdId: H, actorUid: member.uid, opId: op, ...queued(t(), 25_000) }).catch((error) => error);
        await Promise.all(order === 'action-first' ? [action, undo] : [undo, action]);
        assert.equal(await countLogs(id), 0, order);
        await refused(feed(t(), member.uid, op, id, extra()), 'already_undone');
      }
    });

    test('case 7: another tablet, another person, an older generation, or after the window cannot Undo it', async () => {
      const id = `${variant}-principal`;
      await seedPet(id);
      const op = opId();
      await feed(t(), member.uid, op, id, extra());
      assert.equal((await undoFeed(tablets.other, member.uid, op)).status, 'not_applied');
      // A child without pets.deleteLogs; an owner who has it needs a PIN for someone else's feed (D-P6).
      await refused(undoFeed(t(), child.uid, op), 'forbidden');
      await refused(undoFeed(t(), owner.uid, op), 'pin_required');
      await refused(undoFeed(t(), member.uid, op, {}, later(16_000)), 'undo_expired');
      assert.equal((await logs(id).doc(op).get()).exists, true);
    });
  });
}

describe('pets.feed: re-paired tablet and the queued path', () => {
  test('case 7 (generation): a re-paired tablet cannot Undo what the older credential fed', async () => {
    const spare = await pairTablet(H, owner, created, 'Spare tablet');
    await seedPet('gen');
    const op = opId();
    await feed(spare, member.uid, op, 'gen');
    const { code } = await createDeviceRepairCode(owner, { householdId: H, deviceId: spare.deviceId });
    const repaired = await redeemDeviceCode({ code, nonce: nonce() });
    const fresh = { ...spare, idToken: (await signIn(repaired.customToken)).idToken };
    await refused(undoFeed(fresh, member.uid, op), 'not_undoable');
    assert.equal(await countLogs('gen'), 1);
  });

  test('PE-23l: a queued feed is recorded once at the device time as an offline entry, never asked "Feed again?"', async () => {
    await seedPet('offline');
    await feedSure(tablets.extra, owner.uid, opId(), 'offline');
    const op = opId();
    const sent = await feedPetFromTablet({ ...feedRequest(tablets.extra, member.uid, op, 'offline'), ...queued(tablets.extra, 60_000) });
    assert.equal(sent.result.status, 'saved');
    const again = await feedPetFromTablet({ ...feedRequest(tablets.extra, member.uid, op, 'offline'), ...queued(tablets.extra, 60_000) });
    assert.equal(again.result.status, 'saved');
    const log = (await logs('offline').doc(op).get()).data()!;
    assert.equal(log.repeat, 'offline');
    assert.equal(log.clockSource, 'device');
    assert.equal(await countLogs('offline'), 2);
  });
});

describe('"Feed again?" across devices, meal slots, levels and answers', () => {
  test('PE-23g: the question is bound to what was shown; a feed on another tablet meanwhile asks again naming it', async () => {
    await seedPet('again');
    const first = opId();
    await feed(tablets.extra, member.uid, first, 'again');
    const asking = opId();
    const asked = await feed(tablets.other, owner.uid, asking, 'again');
    assert.equal(asked.result.status, 'needsConfirm');
    if (asked.result.status !== 'needsConfirm') return;
    assert.equal(asked.result.lastLogId, first);
    assert.equal(asked.result.lastFedByName, 'Max');
    assert.equal(await countLogs('again'), 1, 'asking writes nothing');
    // Someone feeds on the kitchen tablet while the question is open.
    const meanwhile = opId();
    await feedSure(tablets.extra, child.uid, meanwhile, 'again');
    const stale = await feed(tablets.other, owner.uid, asking, 'again', { confirm: { lastLogId: asked.result.lastLogId, countToday: asked.result.countToday } });
    assert.equal(stale.result.status, 'needsConfirm');
    if (stale.result.status !== 'needsConfirm') return;
    assert.equal(stale.result.staleConfirm, true);
    assert.equal(stale.result.lastLogId, meanwhile);
    const saved = await feed(tablets.other, owner.uid, asking, 'again', { confirm: { lastLogId: stale.result.lastLogId, countToday: stale.result.countToday } });
    assert.equal(saved.result.status, 'saved');
    const log = (await logs('again').doc(asking).get()).data()!;
    assert.equal(log.repeat, 'confirmed');
    assert.equal(log.confirmOf, meanwhile);
  });

  test('D-P5/D-P21: a feed is assigned to the due meal slot and logs its portion; the next one asks', async () => {
    const minutes = localMinutes(new Date(), TZ);
    const at = Math.max(0, minutes - 30);
    const time = `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;
    await seedPet('slots', {
      mealPlan: { slots: [{ id: 'slot-dinner', name: 'Dinner', time, amount: 0.5, unit: 'Cans' }], effectiveFrom: householdDay(new Date(), TZ), confirmedAt: Timestamp.now(), confirmedByUid: owner.uid, confirmedByName: 'Olive' },
    });
    const op = opId();
    const { result } = await feed(tablets.extra, member.uid, op, 'slots', { portionFromSlot: true });
    assert.equal(result.status, 'saved');
    if (result.status !== 'saved') return;
    assert.deepEqual(result.slot, { id: 'slot-dinner', name: 'Dinner' });
    const log = (await logs('slots').doc(op).get()).data()!;
    assert.equal(log.slotId, 'slot-dinner');
    assert.equal(log.cups, 0.5);
    assert.equal(log.foodAmountType, 'Cans');
    assert.deepEqual((await state('slots').get()).get('slotsFed'), { 'slot-dinner': op });
    const next = await feed(tablets.extra, member.uid, opId(), 'slots', { portionFromSlot: true });
    assert.equal(next.result.status, 'needsConfirm');
    // The Undo keeps the state derived from the surviving logs: the slot is free again.
    assert.equal((await undoFeed(tablets.extra, member.uid, op)).status, 'undone');
    assert.deepEqual((await state('slots').get()).get('slotsFed'), {});
  });

  test('Feed earlier: a tablet backdated feed records the meal whose window holds its time (or an extra), as the personal operation does', async (t) => {
    const minutes = localMinutes(new Date(), TZ);
    if (minutes < 130) {
      t.skip('needs two hours of today behind the current Chicago time');
      return;
    }
    const hhmm = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
    // A meal 20 minutes ago (its window opened two hours before) and one six hours away (or long before).
    const laterAt = minutes + 6 * 60 < 24 * 60 ? minutes + 6 * 60 : minutes - 9 * 60;
    const mealPlan = {
      slots: [{ id: 'slot-meal', name: 'Supper', time: hhmm(minutes - 20), amount: 0.5, unit: 'Cans' }, { id: 'slot-later', name: 'Snack', time: hhmm(laterAt), amount: 1, unit: 'Cups' }],
      effectiveFrom: householdDay(new Date(), TZ), confirmedAt: Timestamp.now(), confirmedByUid: owner.uid, confirmedByName: 'Olive',
    };
    for (const id of ['earlier-tablet', 'earlier-personal']) await seedPet(id, { mealPlan });
    const thirty = later(-30 * 60_000).toISOString();
    const ten = later(-10 * 60_000).toISOString();

    // The tablet: 30 minutes ago is the unfed meal, recorded with its portion; 10 minutes ago that meal is fed: an extra.
    const first = opId();
    const one = await feed(tablets.extra, member.uid, first, 'earlier-tablet', { backdatedAt: thirty, portionFromSlot: true });
    assert.equal(one.result.status, 'saved');
    if (one.result.status === 'saved') assert.deepEqual(one.result.slot, { id: 'slot-meal', name: 'Supper' });
    const second = opId();
    const two = await feed(tablets.extra, member.uid, second, 'earlier-tablet', { backdatedAt: ten, portionFromSlot: true });
    assert.equal(two.result.status, 'saved');
    if (two.result.status === 'saved') assert.equal(two.result.slot, null);
    const tabletOne = (await logs('earlier-tablet').doc(first).get()).data()!;
    const tabletTwo = (await logs('earlier-tablet').doc(second).get()).data()!;
    assert.equal(tabletOne.slotId, 'slot-meal');
    assert.equal(tabletOne.cups, 0.5);
    assert.equal(tabletOne.extra, undefined);
    assert.equal(tabletOne.backdated, true);
    assert.equal(tabletTwo.extra, true);
    assert.equal(tabletTwo.slotId, undefined);
    assert.deepEqual((await state('earlier-tablet').get()).get('slotsFed'), { 'slot-meal': first });

    // The personal operation with the same times writes the same.
    const personal = (backdatedAt: string) => runFeed(memberDb, {
      householdId: H, petId: 'earlier-personal', opId: opId(), portion: { amount: 1, unit: 'Cups' }, portionFromSlot: true, food: 'Dry', timeZone: TZ,
      user: { uid: member.uid, name: 'Max' }, backdatedAt: new Date(backdatedAt),
    });
    const p1 = await personal(thirty);
    const p2 = await personal(ten);
    assert.equal(p1.status, 'saved');
    assert.equal(p2.status, 'saved');
    const personalOne = (await logs('earlier-personal').doc((p1 as { logId: string }).logId).get()).data()!;
    const personalTwo = (await logs('earlier-personal').doc((p2 as { logId: string }).logId).get()).data()!;
    assert.equal(personalOne.slotId, tabletOne.slotId);
    assert.equal(personalOne.cups, tabletOne.cups);
    assert.equal(personalTwo.extra, true);
    assert.equal(personalTwo.slotId, undefined);
  });

  test('JC-27: a feed backdated more than 12 hours needs a PIN (and is recorded at PIN level with an activity entry)', async () => {
    await seedPet('old');
    const old = { backdatedAt: later(-13 * 60 * 60_000).toISOString() };
    await refused(feed(tablets.extra, owner.uid, opId(), 'old', old), 'no_pin_set');
    await setMyPin(owner, { householdId: H, pin: '2580' });
    await refused(feed(tablets.extra, owner.uid, opId(), 'old', old), 'pin_required');
    const { pinSessionId } = await verifyDevicePin({ idToken: tablets.extra.idToken, householdId: H, actorUid: owner.uid, pin: '2580' });
    const op = opId();
    const { level, capability } = await feed(tablets.extra, owner.uid, op, 'old', { ...old, pinSessionId });
    assert.equal(level, 'pin');
    assert.equal(capability, 'pets.feed.backdated.old');
    assert.equal((await logs('old').doc(op).get()).get('deviceAttribution').level, 'pin');
    const entries = (await house(H).collection('auditLogs').where('action', '==', 'device.action').get()).docs.map((d) => d.data());
    assert.ok(entries.some((entry) => entry.details?.capability === 'pets.feed.backdated.old' && entry.targetName === 'Pet old'));
  });

  test('D-P6: the points-PIN setting never applies to pets; a member without pets.addLogs is refused', async () => {
    await house(H).update({ devicePolicy: { pointsPin: 'everyone' } });
    await seedPet('points');
    assert.equal((await feed(tablets.extra, member.uid, opId(), 'points')).level, 'face');
    await house(H).update({ devicePolicy: { pointsPin: 'off' } });
    await house(H).collection('members').doc(child.uid).update({ permissions: { 'pets.addLogs': false } });
    await refused(feed(tablets.extra, child.uid, opId(), 'points'), 'forbidden');
    await house(H).collection('members').doc(child.uid).update({ permissions: {} });
  });

  test('answers to a tablet carry no email; a personal token is not a tablet', async () => {
    await seedPet('email');
    const older = opId();
    await logs('email').doc(older).set({ date: Timestamp.fromDate(later(-60_000)), loggedAt: Timestamp.fromDate(later(-60_000)), cups: 1, foodAmountType: 'Cups', foodType: 'Dry', comments: '', ampm: 'AM', loggedByUid: 'someone', loggedByName: 'someone@example.test', repeat: 'none' });
    await state('email').set({ lastLogId: older, lastFedAt: Timestamp.fromDate(later(-60_000)), lastFedByUid: 'someone', lastFedByName: 'someone@example.test', day: householdDay(new Date(), TZ), countOnDay: 1, prev: null });
    const answer = await feed(tablets.extra, member.uid, opId(), 'email');
    assert.equal(answer.result.status, 'needsConfirm');
    assert.equal(JSON.stringify(answer).includes('@'), false, JSON.stringify(answer));
    const personal = await feedPetFromTabletAction({ idToken: await personToken(owner), householdId: H, actorUid: member.uid, opId: opId(), petId: 'email', portion: { amount: 1, unit: 'Cups' }, food: 'Dry' });
    assert.equal(personal.ok ? 'ok' : personal.code, 'not_a_device');
  });
});

describe('pets.care.add', () => {
  const t = () => tablets.care;
  test('the selected person is credited, with the tablet attribution; log id == opId', async () => {
    await seedPet('care-credit');
    const op = opId();
    assert.equal((await addCare(t(), KID, op, 'care-credit', { activity: 'Brushing', notes: 'Calm' })).status, 'added');
    const entry = (await care('care-credit').doc(op).get()).data()!;
    assert.equal(entry.loggedByUid, KID);
    assert.equal(entry.activity, 'Brushing');
    assert.equal(entry.deviceAttribution.deviceName, 'Mudroom tablet');
    assert.equal(typeof entry.date, 'string');
    // Server time of the write: the author's 10-minute delete window in the rules (review B1).
    assert.ok(entry.loggedAt instanceof Timestamp);
    assert.ok(Math.abs(entry.loggedAt.toMillis() - Date.now()) < 60_000);
  });

  test('case 1: another tablet adds an entry meanwhile (kept); an entry edited since is never undone', async () => {
    await seedPet('care-between');
    const op = opId();
    await addCare(t(), member.uid, op, 'care-between');
    const otherOp = opId();
    await addCare(tablets.other, child.uid, otherOp, 'care-between');
    assert.equal((await undoCare(t(), member.uid, op)).status, 'undone');
    assert.equal((await care('care-between').doc(otherOp).get()).exists, true);
    const edited = opId();
    await addCare(t(), member.uid, edited, 'care-between');
    // A personal client edits the note (the update rule allows the notes to change).
    await care('care-between').doc(edited).update({ notes: 'Edited on a phone' });
    await refused(undoCare(t(), member.uid, edited), 'changed_since');
    assert.equal((await care('care-between').doc(edited).get()).exists, true);
  });

  test('cases 2-5: reload inside and outside the window, dropped connection, late retry, Undo first', async () => {
    await seedPet('care-cases');
    const inside = opId();
    await addCare(t(), member.uid, inside, 'care-cases');
    assert.equal((await undoCare(t(), member.uid, inside, {}, later(9000))).status, 'undone');
    const outside = opId();
    await addCare(t(), member.uid, outside, 'care-cases');
    await refused(undoCare(t(), member.uid, outside, {}, later(15_500)), 'undo_expired');
    const dropped = opId();
    await addCare(t(), member.uid, dropped, 'care-cases');
    assert.equal((await addCare(t(), member.uid, dropped, 'care-cases')).status, 'added');
    assert.equal((await undoCare(t(), member.uid, dropped)).status, 'undone');
    assert.equal((await undoCare(t(), member.uid, dropped)).status, 'already');
    await refused(addCare(t(), member.uid, dropped, 'care-cases'), 'already_undone');
    const first = opId();
    assert.equal((await undoCare(t(), member.uid, first)).status, 'not_applied');
    await refused(addCare(t(), member.uid, first, 'care-cases'), 'already_undone');
    const left = (await care('care-cases').get()).docs.map((d) => d.id);
    assert.deepEqual(left, [outside]);
  });

  test('case 6: a queued entry in flight and its Undo at once, both orders, leave nothing', async () => {
    for (const order of ['action-first', 'undo-first'] as const) {
      const id = `care-race-${order}`;
      await seedPet(id);
      const op = opId();
      const action = addCareFromTablet({ idToken: t().idToken, householdId: H, actorUid: member.uid, opId: op, petId: id, activity: 'Walk', ...queued(t(), 30_000) }).catch((error) => error);
      const undo = undoCareFromTablet({ idToken: t().idToken, householdId: H, actorUid: member.uid, opId: op, ...queued(t(), 25_000) }).catch((error) => error);
      await Promise.all(order === 'action-first' ? [action, undo] : [undo, action]);
      assert.equal((await care(id).get()).size, 0, order);
    }
  });

  test('case 7: another tablet, another person, after the window', async () => {
    await seedPet('care-principal');
    const op = opId();
    await addCare(t(), member.uid, op, 'care-principal');
    assert.equal((await undoCare(tablets.other, member.uid, op)).status, 'not_applied');
    await refused(undoCare(t(), child.uid, op), 'forbidden');
    await refused(undoCare(t(), member.uid, op, {}, later(16_000)), 'undo_expired');
    assert.equal((await care('care-principal').doc(op).get()).exists, true);
  });
});

describe('the server writes exactly what the rules accept from the person (replayed as a client)', () => {
  /** Admin SDK Timestamps (read back from the emulator) as client SDK Timestamps of the same instant. */
  const asClientValues = (value: unknown): unknown => {
    if (value && typeof value === 'object' && typeof (value as { toMillis?: unknown }).toMillis === 'function' && !(value instanceof ClientTimestamp)) {
      return ClientTimestamp.fromMillis((value as { toMillis: () => number }).toMillis());
    }
    if (Array.isArray(value)) return value.map(asClientValues);
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, asClientValues(child)]));
    }
    return value;
  };

  /** The person's own client writes the same documents: server times as request.time, no deviceAttribution. */
  const replay = async (writes: Array<{ path: string; data: Record<string, unknown>; serverTimes: string[] }>) => {
    const batch = writeBatch(memberDb);
    for (const write of writes) {
      const data: Record<string, unknown> = { ...write.data };
      delete data.deviceAttribution;
      for (const field of write.serverTimes) {
        if (field.includes('.')) {
          const [outer, inner] = field.split('.');
          data[outer] = { ...(data[outer] as Record<string, unknown>), [inner]: serverTimestamp() };
        } else {
          data[field] = serverTimestamp();
        }
      }
      // Admin Timestamps become client Timestamps with the same instant (nested ones too).
      batch.set(doc(memberDb, write.path), asClientValues(data) as Record<string, unknown>);
      continue;
      batch.set(doc(memberDb, write.path), data);
    }
    await batch.commit();
  };

  /** Runs a server write, captures what it wrote, puts the documents back as they were, then replays them as the person. */
  const parity = async (petId: string, run: () => Promise<string>, kind: 'feed' | 'care') => {
    const before = (await state(petId).get()).data() ?? null;
    const op = await run();
    const logRef = (kind === 'feed' ? logs(petId) : care(petId)).doc(op);
    const log = (await logRef.get()).data()!;
    const after = kind === 'feed' ? (await state(petId).get()).data()! : null;
    assert.ok(log.deviceAttribution, 'the server stores the attribution');
    await logRef.delete();
    if (kind === 'feed') {
      if (before) await state(petId).set(before);
      else await state(petId).delete();
    }
    const live = kind === 'feed' && log.repeat !== 'offline' && log.backdated !== true;
    const writes = [{ path: logRef.path, data: log, serverTimes: kind === 'feed' ? (live ? ['date', 'loggedAt'] : ['loggedAt']) : ['loggedAt'] }];
    if (after) {
      const stateTimes = after.lastLogId === op && live ? ['lastFedAt'] : [];
      writes.push({ path: state(petId).path, data: after, serverTimes: stateTimes });
    }
    await replay(writes);
    assert.equal((await logRef.get()).exists, true);
  };

  test('a plain feed, a confirmed feed, a slot feed and a backdated feed', async () => {
    await seedPet('parity');
    await parity('parity', async () => { const op = opId(); await feed(tablets.parity, member.uid, op, 'parity'); return op; }, 'feed');
    await parity('parity', async () => { const op = opId(); await feedSure(tablets.parity, member.uid, op, 'parity'); return op; }, 'feed');
    const minutes = localMinutes(new Date(), TZ);
    const at = Math.max(0, minutes - 30);
    const time = `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;
    await seedPet('parity-slots', {
      mealPlan: { slots: [{ id: 'slot-dinner', name: 'Dinner', time, amount: 0.5, unit: 'Cans' }], effectiveFrom: householdDay(new Date(), TZ), confirmedAt: Timestamp.now(), confirmedByUid: owner.uid, confirmedByName: 'Olive' },
    });
    await parity('parity-slots', async () => { const op = opId(); await feed(tablets.parity, member.uid, op, 'parity-slots', { portionFromSlot: true }); return op; }, 'feed');
    await seedPet('parity-back');
    await parity('parity-back', async () => { const op = opId(); await feed(tablets.parity, member.uid, op, 'parity-back', { backdatedAt: later(-60 * 60_000).toISOString() }); return op; }, 'feed');
  });

  test('a care entry', async () => {
    await seedPet('parity-care');
    await parity('parity-care', async () => { const op = opId(); await addCare(tablets.parity, member.uid, op, 'parity-care', { notes: 'Fine' }); return op; }, 'care');
  });

  test('the Undo: the same delete and derived state the person may write (author within 10 minutes)', async () => {
    await seedPet('parity-undo');
    const first = opId();
    await feed(tablets.parity, member.uid, first, 'parity-undo');
    const op = opId();
    await feedSure(tablets.parity, member.uid, op, 'parity-undo');
    const before = (await state('parity-undo').get()).data()!;
    const log = (await logs('parity-undo').doc(op).get()).data()!;
    assert.equal((await undoFeed(tablets.parity, member.uid, op)).status, 'undone');
    const afterUndo = (await state('parity-undo').get()).data()!;
    assert.equal(afterUndo.lastLogId, first);
    // Put the feed back, then the person deletes it and writes the same state.
    await logs('parity-undo').doc(op).set(log);
    await state('parity-undo').set(before);
    const batch = writeBatch(memberDb);
    batch.delete(doc(memberDb, logs('parity-undo').doc(op).path));
    batch.set(doc(memberDb, state('parity-undo').path), asClientValues(afterUndo) as Record<string, unknown>);
    await batch.commit();
    assert.equal((await logs('parity-undo').doc(op).get()).exists, false);
  });

  test('the care Undo: the same delete the person may make (author within 10 minutes of loggedAt, review B1)', async () => {
    await seedPet('parity-care-undo');
    const op = opId();
    await addCare(tablets.parity, member.uid, op, 'parity-care-undo');
    const entry = care('parity-care-undo').doc(op);
    const log = (await entry.get()).data()!;
    assert.equal((await undoCare(tablets.parity, member.uid, op)).status, 'undone');
    assert.equal((await entry.get()).exists, false);
    // Put the entry back as the server wrote it, then the person (a member without
    // pets.deleteLogs) deletes it from their own client: the rules accept it.
    await entry.set(log);
    const batch = writeBatch(memberDb);
    batch.delete(doc(memberDb, entry.path));
    await batch.commit();
    assert.equal((await entry.get()).exists, false);
  });
});

describe('review F4b-1: the 12-hour line once per press, opId reuse, the log the Undo deletes', () => {
  const H11 = 11 * 60 * 60_000 + 59 * 60_000 + 30_000;
  const queuedAt = (t: Tablet, at: Date) => ({ queued: { createdAt: at.toISOString(), generation: tokenGeneration(t.idToken) } });

  test('S1: a queued feed is classified by its queue time: within 12 hours face, older needs a PIN (a forged createdAt 23 hours back is refused)', async () => {
    await seedPet('line-queued');
    await setMyPin(member, { householdId: H, pin: '1470' });
    const recent = opId();
    const ok = await feedPetFromTablet({ ...feedRequest(tablets.line, member.uid, recent, 'line-queued'), ...queued(tablets.line, 11 * 60 * 60_000) });
    assert.equal(ok.result.status, 'saved');
    assert.equal(ok.capability, 'pets.feed');
    assert.equal(ok.level, 'face');
    for (const hours of [13, 23]) {
      const forged = opId();
      await refused(feedPetFromTablet({ ...feedRequest(tablets.line, member.uid, forged, 'line-queued'), ...queued(tablets.line, hours * 60 * 60_000) }), 'pin_required');
      assert.equal((await logs('line-queued').doc(forged).get()).exists, false, `${hours} h`);
    }
    // Even with a PIN session: .old is never queueable (a queued intent is never upgraded).
    const { pinSessionId } = await verifyDevicePin({ idToken: tablets.line.idToken, householdId: H, actorUid: member.uid, pin: '1470' });
    await refused(feedPetFromTablet({ ...feedRequest(tablets.line, member.uid, opId(), 'line-queued', { pinSessionId }), ...queued(tablets.line, 23 * 60 * 60_000) }), 'invalid_input');
    // Past the gate's 24 hours: still the queue's stale notice.
    await refused(feedPetFromTablet({ ...feedRequest(tablets.line, member.uid, opId(), 'line-queued'), ...queued(tablets.line, 25 * 60 * 60_000) }), 'stale_intent');
    assert.equal(await countLogs('line-queued'), 1);
  });

  test('S2: a retry that crosses the 12-hour line after a commit gets the stored answer (live, queued, backdated and queued plain)', async () => {
    await seedPet('line-retry');
    const start = new Date();
    const crossed = new Date(start.getTime() + 90_000);
    // A live backdated feed at 11 h 59 min 30 s, its answer lost, retried 90 s later (12 h 01 min).
    const live = opId();
    const backdatedAt = new Date(start.getTime() - H11).toISOString();
    const first = await feed(tablets.line, member.uid, live, 'line-retry', { backdatedAt }, start);
    assert.equal(first.capability, 'pets.feed.backdated');
    const retry = await feed(tablets.line, member.uid, live, 'line-retry', { backdatedAt }, crossed);
    assert.equal(retry.capability, 'pets.feed.backdated', 'the recorded capability, not the clock\'s');
    assert.equal(retry.level, 'face');
    assert.equal(retry.result.status === 'saved' && retry.result.replayed, true);
    // The same retry with a PIN session open: still the stored answer, never a conflict.
    const { pinSessionId } = await verifyDevicePin({ idToken: tablets.line.idToken, householdId: H, actorUid: member.uid, pin: '1470' });
    const withPin = await feed(tablets.line, member.uid, live, 'line-retry', { backdatedAt, pinSessionId }, crossed);
    assert.equal(withPin.result.status === 'saved' && withPin.result.replayed, true);
    // A queued backdated feed, then its queued retry after the line.
    const queuedBack = opId();
    await feedPetFromTablet({ ...feedRequest(tablets.line, member.uid, queuedBack, 'line-retry', { backdatedAt }), ...queuedAt(tablets.line, new Date(start.getTime() - 30_000)) }, { clock: () => start });
    const queuedRetry = await feedPetFromTablet({ ...feedRequest(tablets.line, member.uid, queuedBack, 'line-retry', { backdatedAt }), ...queuedAt(tablets.line, new Date(start.getTime() - 30_000)) }, { clock: () => crossed });
    assert.equal(queuedRetry.result.status === 'saved' && queuedRetry.result.replayed, true);
    // A queued plain feed made 11 h 59 min 30 s ago, retried after the line.
    const queuedPlain = opId();
    const madeAt = new Date(start.getTime() - H11);
    const plain = await feedPetFromTablet({ ...feedRequest(tablets.line, member.uid, queuedPlain, 'line-retry'), ...queuedAt(tablets.line, madeAt) }, { clock: () => start });
    assert.equal(plain.capability, 'pets.feed');
    const plainRetry = await feedPetFromTablet({ ...feedRequest(tablets.line, member.uid, queuedPlain, 'line-retry'), ...queuedAt(tablets.line, madeAt) }, { clock: () => crossed });
    assert.equal(plainRetry.capability, 'pets.feed');
    assert.equal(plainRetry.result.status === 'saved' && plainRetry.result.replayed, true);
    assert.equal(await countLogs('line-retry'), 3, 'one log per press');
    // A new press at the same times is on the other side of the line: a PIN, never face.
    await refused(feed(tablets.line, member.uid, opId(), 'line-retry', { backdatedAt }, crossed), 'pin_required');
    // The recorded feed is still undone by its own Undo.
    assert.equal((await undoFeed(tablets.line, member.uid, live, {}, new Date(start.getTime() + 5000))).status, 'undone');
  });

  test('N1: an opId reused for another pet is a conflict, never the other pet\'s answer', async () => {
    await seedPet('reuse-a');
    await seedPet('reuse-b');
    const op = opId();
    await feed(tablets.reuse, member.uid, op, 'reuse-a');
    await refused(feed(tablets.reuse, member.uid, op, 'reuse-b'), 'conflict');
    assert.equal(await countLogs('reuse-b'), 0);
    const careOp = opId();
    await addCare(tablets.reuse, member.uid, careOp, 'reuse-a');
    await refused(addCare(tablets.reuse, member.uid, careOp, 'reuse-b'), 'conflict');
    assert.equal((await care('reuse-b').get()).size, 0);
    // The same pet still replays.
    const again = await feed(tablets.reuse, member.uid, op, 'reuse-a');
    assert.equal(again.result.status === 'saved' && again.result.replayed, true);
  });

  test('N2: a log deleted and recreated under the same id by someone else (or another tablet) is never undone', async () => {
    await seedPet('recreated');
    const op = opId();
    await feed(tablets.reuse, member.uid, op, 'recreated');
    const original = (await logs('recreated').doc(op).get()).data()!;
    // Someone with pets.deleteLogs deletes it and writes their own feeding with the same id.
    await logs('recreated').doc(op).delete();
    await logs('recreated').doc(op).set({ ...original, loggedByUid: owner.uid, loggedByName: 'Olive', deviceAttribution: null });
    await refused(undoFeed(tablets.reuse, member.uid, op), 'changed_since');
    assert.equal((await logs('recreated').doc(op).get()).get('loggedByUid'), owner.uid);
    // Same author, but written by another tablet.
    const careOp = opId();
    await addCare(tablets.reuse, member.uid, careOp, 'recreated');
    const entry = (await care('recreated').doc(careOp).get()).data()!;
    await care('recreated').doc(careOp).delete();
    await care('recreated').doc(careOp).set({ ...entry, deviceAttribution: { ...entry.deviceAttribution, deviceId: tablets.other.deviceId } });
    await refused(undoCare(tablets.reuse, member.uid, careOp), 'changed_since');
    assert.equal((await care('recreated').doc(careOp).get()).exists, true);
  });
});

describe('no email is kept in the op ledger (design 10.1)', () => {
  test('a chore answered "already done" by a legacy completion with an email, and every pets entry: no summary holds an email', async () => {
    await house(H).collection('chores').doc('legacy-done').set({
      task: 'Legacy chore', dueDate: new Date().toISOString(), isCompleted: true, subTasks: [], completedSubTasks: [], roomIds: [],
      completedByUid: 'someone', completedByEmail: 'someone@example.test', completedByName: 'someone@example.test', completedAt: new Date().toISOString(), completionId: 'old',
    });
    const op = opId();
    const { outcome } = await completeChoreFromTablet({ idToken: tablets.extra.idToken, householdId: H, actorUid: member.uid, opId: op, choreId: 'legacy-done' });
    assert.equal(outcome.status, 'already');
    const devices = await house(H).collection('devices').get();
    const summaries = (await Promise.all(devices.docs.map((d) => d.ref.collection('ops').get()))).flatMap((q) => q.docs.map((entry) => entry.get('summary')));
    assert.ok(summaries.length > 20, "the ledger holds this suite's entries");
    const emailKey = (value: unknown): boolean => Boolean(value && typeof value === 'object' && Object.entries(value as Record<string, unknown>).some(([key, child]) => /email/i.test(key) || emailKey(child)));
    for (const summary of summaries) {
      assert.equal(JSON.stringify(summary ?? {}).includes('@'), false, JSON.stringify(summary));
      assert.equal(emailKey(summary), false, JSON.stringify(summary));
    }
    const entry = (await house(H).collection('devices').doc(tablets.extra.deviceId).collection('ops').doc(op).get()).data()!;
    assert.equal(entry.summary.noop, true, 'the no-op answer is recorded (without the email)');
  });
});
