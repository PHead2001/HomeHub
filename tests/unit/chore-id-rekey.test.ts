import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { occurrenceChoreId, recurringChoreId, storedOccurrenceKey } from '../../functions/src/shared/ids';
import {
  assertOccurrenceBase,
  choreIdRekeyPlan,
  legacyOccurrenceBase,
  occurrenceChoreIdJs,
  parseOccurrenceKey,
  rekeyTargets,
  rekeyedChoreData,
} from '../../scripts/ops/chore-id-rekey.mjs';
import { stableSlugify } from '../../scripts/ops/occurrence-key.mjs';

// scripts/ops/rekey-chore-ids.mjs (member privacy release E): generated chores
// move from ids with the assignee's email (or uid) to `occurrenceChoreId`.
const EMAIL = 'sam.member@example.test';

describe('chore id re-key decisions', () => {
  test('the JavaScript twin builds the same ids as upkeep', () => {
    for (const [template, room, day] of [['trash', 'general', '2026-11-05'], ['Take Out Trash', 'Kitchen & Bath', '2027-01-31'], ['Ça va / x_y', 'r', '2026-08-01']]) {
      assert.equal(occurrenceChoreIdJs(template, room, day), occurrenceChoreId(template, room, day));
    }
  });

  test('an email-keyed chore with an occurrence key moves to its occurrence id', () => {
    const id = recurringChoreId('trash', 'kitchen', '2026-11-05', EMAIL);
    assert.ok(id.includes('sammemberexampletest'), 'the old id carries the slug of the email');
    const plan = choreIdRekeyPlan(id, { templateId: 'trash', roomIds: ['kitchen'], occurrenceKey: 'trash|kitchen|2026-11-05' });
    assert.deepEqual(plan, { kind: 'rekey', base: occurrenceChoreId('trash', 'kitchen', '2026-11-05'), suffix: 'other', occurrenceKey: null });
  });

  test('a chore moved to another day keeps the identity of the day it was generated for', () => {
    // originalDueDate changes on a move; the id and the key do not.
    const id = recurringChoreId('trash', 'kitchen', '2026-11-05', EMAIL);
    const plan = choreIdRekeyPlan(id, { templateId: 'trash', roomIds: ['kitchen'], originalDueDate: '2026-11-08' });
    assert.equal(plan.kind, 'rekey');
    if (plan.kind !== 'rekey') return;
    assert.equal(plan.base, occurrenceChoreId('trash', 'kitchen', '2026-11-05'));
    // No stored key: the move adds the one recovered from the id.
    assert.equal(plan.occurrenceKey, 'trash|kitchen|2026-11-05');
    assert.equal(storedOccurrenceKey(plan.base, { templateId: 'trash', roomIds: ['kitchen'] }), 'trash|kitchen|2026-11-05',
      'the new id still names its day for upkeep and the calendar');
  });

  test('a chore whose room changed and has no key is moved by the day in its id, without a key', () => {
    const id = recurringChoreId('trash', 'kitchen', '2026-11-05', EMAIL);
    const plan = choreIdRekeyPlan(id, { templateId: 'trash', roomIds: ['garage'] });
    assert.deepEqual(plan, { kind: 'rekey', base: 'trash-kitchen-2026-11-05', suffix: 'other', occurrenceKey: null });
    // The runtime recovery (upkeep, calendar) is anchored on the stored room and reads
    // only the ten characters after it, so it never reaches into the assignee part.
    assert.equal(storedOccurrenceKey(recurringChoreId('trash', 'kitchen', '2026-11-05', 'alice-2025-01-01@work.example.test'), { templateId: 'trash', roomIds: ['kitchen'] }), 'trash|kitchen|2026-11-05');
  });

  test('the day is never taken from date-shaped parts of the email', () => {
    // Keyless, and the chore's room changed since: the id is the only source.
    const rooms = new Set(['general', 'kitchen', 'garage']);
    const fields = { templateId: 'trash', roomIds: ['garage'] };
    const id = recurringChoreId('trash', 'kitchen', '2026-11-05', 'alice-2025-01-01@work.example.test');
    assert.equal(id, 'trash-kitchen-2026-11-05-alice-2025-01-01workexampletest');
    const codexExample = 'trash-kitchen-2026-11-05-alice-2025-01-01-workexampletest';
    for (const legacy of [id, codexExample]) {
      const plan = choreIdRekeyPlan(legacy, fields, new Set(), rooms);
      assert.equal(plan.kind, 'rekey', legacy);
      if (plan.kind === 'rekey') assert.equal(plan.base, 'trash-kitchen-2026-11-05', legacy);
    }
    // An email with several date-like parts.
    const several = recurringChoreId('trash', 'kitchen', '2026-11-05', 'x-2024-02-02-2023-03-03-1999-12-31@example.test');
    const plan = choreIdRekeyPlan(several, fields, new Set(), rooms);
    assert.equal(plan.kind === 'rekey' && plan.base, 'trash-kitchen-2026-11-05');
  });

  test('an id whose day cannot be told apart is left alone and counted as ambiguous', () => {
    const fields = { templateId: 'trash', roomIds: ['garage'] };
    const id = 'trash-kitchen-2026-11-05-alice-2025-01-01-workexampletest';
    // The room it names was deleted (or no rooms are known): two candidate days.
    assert.deepEqual(choreIdRekeyPlan(id, fields, new Set(), new Set(['general', 'garage'])), { kind: 'ambiguous' });
    assert.deepEqual(choreIdRekeyPlan(id, fields), { kind: 'ambiguous' });
    assert.deepEqual(legacyOccurrenceBase(id, 'trash', null), { ambiguous: true });
    // A single date-shaped part is the day, whatever the room.
    assert.deepEqual(legacyOccurrenceBase('trash-kitchen-2026-11-05-samexampletest', 'trash', null), { base: 'trash-kitchen-2026-11-05' });
  });

  test('a move target never keeps anything after the day', () => {
    assert.throws(() => assertOccurrenceBase('trash-kitchen-2026-11-05-alice', 'trash'));
    assert.throws(() => assertOccurrenceBase('mop-kitchen-2026-11-05', 'trash'));
    assert.equal(assertOccurrenceBase('trash-kitchen-2026-11-05', 'trash'), 'trash-kitchen-2026-11-05');
    const cases: Array<[string, Record<string, unknown>]> = [
      [recurringChoreId('trash', 'kitchen', '2026-11-05', 'a-2020-01-01@b.c'), { templateId: 'trash', roomIds: ['kitchen'] }],
      [recurringChoreId('trash', 'kitchen', '2026-11-05', 'a-2020-01-01@b.c'), { templateId: 'trash', roomIds: [], occurrenceKey: 'trash|kitchen|2026-11-05' }],
      [recurringChoreId('trash', 'kitchen', '2026-11-05', 'a-2020-01-01@b.c'), { templateId: 'trash', roomIds: ['garage'] }],
    ];
    for (const [id, chore] of cases) {
      const plan = choreIdRekeyPlan(id, chore, new Set(), new Set(['general', 'kitchen', 'garage']));
      assert.equal(plan.kind, 'rekey');
      if (plan.kind === 'rekey') assert.match(plan.base, /^trash-kitchen-2026-11-05$/);
    }
  });

  test('uid-keyed chores move too, counted as uids of current members', () => {
    const uid = 'AbC123xyzUid';
    const id = recurringChoreId('mop', 'general', '2026-11-05', uid);
    const plan = choreIdRekeyPlan(id, { templateId: 'mop', roomIds: [], occurrenceKey: 'mop|general|2026-11-05' }, new Set([stableSlugify(uid)]));
    assert.equal(plan.kind, 'rekey');
    if (plan.kind === 'rekey') assert.equal(plan.suffix, 'uid');
  });

  test('ids already email-free, numbered duplicates and one-time chores are left alone', () => {
    const base = occurrenceChoreId('trash', 'general', '2026-11-05');
    const fields = { templateId: 'trash', roomIds: [], occurrenceKey: 'trash|general|2026-11-05' };
    assert.deepEqual(choreIdRekeyPlan(base, fields), { kind: 'current' });
    assert.deepEqual(choreIdRekeyPlan(`${base}-2`, fields), { kind: 'current' });
    assert.deepEqual(choreIdRekeyPlan(`${base}-9`, { templateId: 'trash', roomIds: [] }), { kind: 'current' });
    assert.deepEqual(choreIdRekeyPlan('AbCdEf0123456789wxyz', { templateId: 'trash', sourceType: 'temporary' }), { kind: 'one-time' });
    assert.deepEqual(choreIdRekeyPlan(recurringChoreId('trash', 'general', '2026-11-05', EMAIL), { templateId: 'trash', sourceType: 'template' }), { kind: 'one-time' });
    assert.deepEqual(choreIdRekeyPlan('anything', { task: 'No template' }), { kind: 'one-time' });
    assert.deepEqual(choreIdRekeyPlan('AbCdEf0123456789wxyz', { templateId: 'trash', roomIds: [] }), { kind: 'unrecognized' });
    // A template whose id contains a date: its own date is part of the prefix, not a day.
    assert.deepEqual(choreIdRekeyPlan('x-2025-01-01-r-2026-11-05', { templateId: 'x-2025-01-01', roomIds: ['elsewhere'] }), { kind: 'current' });
    assert.deepEqual(choreIdRekeyPlan('x-2025-01-01-r', { templateId: 'x-2025-01-01', roomIds: ['elsewhere'] }), { kind: 'unrecognized' });
  });

  test('running the plan on its own output finds nothing to do', () => {
    const id = recurringChoreId('Take Out Trash', 'Kitchen', '2026-11-05', EMAIL);
    const data = { templateId: 'Take Out Trash', roomIds: ['Kitchen'], occurrenceKey: 'Take Out Trash|Kitchen|2026-11-05' };
    const plan = choreIdRekeyPlan(id, data);
    assert.equal(plan.kind, 'rekey');
    if (plan.kind !== 'rekey') return;
    for (const target of rekeyTargets(plan.base)) assert.deepEqual(choreIdRekeyPlan(target, data), { kind: 'current' });
  });

  test('targets and moved data', () => {
    assert.deepEqual(rekeyTargets('a-b-2026-11-05'), ['a-b-2026-11-05', ...[2, 3, 4, 5, 6, 7, 8, 9].map(n => `a-b-2026-11-05-${n}`)]);
    const stamp = { seconds: 1, nanoseconds: 2 };
    const data = { task: 'Trash', completedByUid: 'u1', completedByName: 'Sam', completionId: 'c1', completedAtServer: stamp, occurrenceKey: 'trash|general|2026-11-05' };
    const kept = rekeyedChoreData(data, { occurrenceKey: 'other|x|2026-01-01' });
    assert.deepEqual(kept, data, 'every field kept, a stored key never replaced');
    assert.equal(kept.completedAtServer, stamp);
    assert.deepEqual(rekeyedChoreData({ task: 'Trash' }, { occurrenceKey: 'trash|general|2026-11-05' }), { task: 'Trash', occurrenceKey: 'trash|general|2026-11-05' });
    assert.deepEqual(rekeyedChoreData({ task: 'Trash' }, { occurrenceKey: null }), { task: 'Trash' });
  });

  test('occurrence keys parse from the end', () => {
    assert.deepEqual(parseOccurrenceKey('a|b|2026-11-05'), { templateId: 'a', roomId: 'b', day: '2026-11-05' });
    assert.deepEqual(parseOccurrenceKey('a|x|b|2026-11-05'), { templateId: 'a|x', roomId: 'b', day: '2026-11-05' });
    assert.equal(parseOccurrenceKey('a|b|soon'), null);
    assert.equal(parseOccurrenceKey('a|2026-11-05'), null);
  });
});
