import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { releaseHeldPushes } from '../../functions/src/held-pushes';
import { deterministicNotificationId } from '../../functions/src/shared/ids';

// NO-3 / 16.3: pushes held for the morning or quiet hours are released by hourly upkeep,
// once, only to members who have not seen the notification, never for a closed one.
const HOUSE = 'held-push-house';
const house = () => adminDb.collection('households').doc(HOUSE);
const notes = () => house().collection('notifications');
const ts = (d: Date) => Timestamp.fromDate(d) as never;
const NOW = new Date('2026-11-13T13:05:00Z');
const at = (iso: string) => Timestamp.fromDate(new Date(iso));
const note = (id: string, fields: Record<string, unknown>) => notes().doc(id).set({
  householdId: HOUSE, category: 'maintenance', title: 'Filter', message: 'Due today', audience: ['*'],
  createdAt: at('2026-11-13T06:05:00Z'), expiresAt: at('2026-11-20T06:05:00Z'), readBy: {}, dismissedBy: {}, ...fields,
});
const release = () => releaseHeldPushes(adminDb as never, house() as never, NOW, ts);

beforeEach(async () => {
  await adminDb.recursiveDelete(house());
  await house().set({ name: 'Held', ownerUid: 'o1', timeZone: 'America/Chicago' });
});

after(async () => {
  await adminDb.recursiveDelete(house());
});

describe('held pushes (NO-3)', () => {
  test('due holds are released once; later holds wait', async () => {
    await note('n1', {
      pushHeld: { a: at('2026-11-13T13:00:00Z'), b: at('2026-11-13T13:00:00Z'), c: at('2026-11-14T02:00:00Z') },
      pushHeldNext: at('2026-11-13T13:00:00Z'),
    });
    assert.equal(await release(), 1);
    const data = (await notes().doc('n1').get()).data()!;
    assert.deepEqual(data.pushRelease.uids, ['a', 'b']);
    assert.equal(data.pushRelease.at.toMillis(), NOW.getTime());
    assert.deepEqual(Object.keys(data.pushHeld), ['c']);
    assert.equal(data.pushHeldNext.toMillis(), Date.parse('2026-11-14T02:00:00Z'));
    assert.equal(await release(), 0, 'nothing due any more: never sent twice');
    assert.equal((await notes().doc('n1').get()).data()!.pushRelease.at.toMillis(), NOW.getTime());
  });

  test('someone who already read or dismissed it in the bell is not pushed', async () => {
    await note('n2', {
      pushHeld: { a: at('2026-11-13T13:00:00Z'), b: at('2026-11-13T13:00:00Z') },
      pushHeldNext: at('2026-11-13T13:00:00Z'),
      readBy: { a: { at: at('2026-11-13T12:00:00Z'), uid: 'a' } },
      dismissedBy: { b: { at: at('2026-11-13T12:00:00Z'), uid: 'b' } },
    });
    assert.equal(await release(), 0);
    const data = (await notes().doc('n2').get()).data()!;
    assert.equal(data.pushRelease, undefined);
    assert.deepEqual(data.pushHeld, {});
    assert.equal(data.pushHeldNext, null);
  });

  test('resolved before the morning: no push at all', async () => {
    await note('n3', {
      pushHeld: { a: at('2026-11-13T13:00:00Z') }, pushHeldNext: at('2026-11-13T13:00:00Z'),
      resolvedAt: at('2026-11-13T12:00:00Z'),
    });
    assert.equal(await release(), 0);
    const data = (await notes().doc('n3').get()).data()!;
    assert.equal(data.pushRelease, undefined);
    assert.equal(data.pushHeldNext, null);
  });

  test('a household being deleted releases nothing', async () => {
    await note('n4', { pushHeld: { a: at('2026-11-13T13:00:00Z') }, pushHeldNext: at('2026-11-13T13:00:00Z') });
    await house().update({ deletingAt: Timestamp.now() });
    assert.equal(await release(), 0);
    assert.equal((await notes().doc('n4').get()).data()!.pushRelease, undefined);
  });
  test('a held "due" dose push is dropped once the overdue reminder for the same dose exists', async () => {
    const held = { pushHeld: { a: at('2026-11-13T13:00:00Z') }, pushHeldNext: at('2026-11-13T13:00:00Z') };
    const due = deterministicNotificationId('pet_medication', 'maple:course:c1', 'due|c1@2026-11-12T23:00');
    const overdue = deterministicNotificationId('pet_medication', 'maple:course:c1', 'overdue|c1@2026-11-12T23:00');
    await note(due, { category: 'pets', sourceType: 'pet_medication', sourceId: 'maple:course:c1', stateKey: 'due|c1@2026-11-12T23:00', ...held });
    await note(overdue, { category: 'pets', sourceType: 'pet_medication', sourceId: 'maple:course:c1', stateKey: 'overdue|c1@2026-11-12T23:00', ...held });
    assert.equal(await release(), 1, 'one push for the dose');
    assert.equal((await notes().doc(due).get()).data()!.pushRelease, undefined, 'the superseded due notice is not pushed');
    assert.deepEqual((await notes().doc(due).get()).data()!.pushHeld, {});
    assert.deepEqual((await notes().doc(overdue).get()).data()!.pushRelease.uids, ['a']);
  });
});
