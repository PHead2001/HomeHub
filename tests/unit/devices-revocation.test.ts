import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CLEAR_ORDER,
  DEVICE_NOTICES_LIMIT,
  clearTabletSession,
  decideSessionEnd,
  destinationAfter,
  deviceNotificationCategories,
  endedNote,
  type ClearDeps,
  type ClearStep,
} from '../../src/lib/devices/device-session';
import { defaultSections } from '../../src/lib/devices/settings';
import { deviceRefusalResponse } from '../../src/lib/devices/action-policy';

// Revocation observation and clearing on the tablet (docs/modules/devices/README.md,
// "Revocation on the tablet"; design 13, WT-19b-d, S3) and the six household-wide
// notification listeners (5.6).

describe('revocation decision (13)', () => {
  const gen = 3;

  it('only the server decides: cached snapshots never end the session', () => {
    assert.equal(decideSessionEnd({ kind: 'record', fromCache: true, exists: false }, gen), null);
    assert.equal(decideSessionEnd({ kind: 'record', fromCache: true, exists: true, status: 'removed', generation: 4 }, gen), null);
    assert.equal(decideSessionEnd({ kind: 'household', fromCache: true, exists: false, deleting: false }, gen), null);
  });

  it('a missing, inactive or re-paired record ends it', () => {
    assert.equal(decideSessionEnd({ kind: 'record', fromCache: false, exists: true, status: 'active', generation: gen }, gen), null);
    assert.equal(decideSessionEnd({ kind: 'record', fromCache: false, exists: false }, gen), 'removed');
    assert.equal(decideSessionEnd({ kind: 'record', fromCache: false, exists: true, status: 'removed', generation: 4 }, gen), 'removed');
    assert.equal(decideSessionEnd({ kind: 'record', fromCache: false, exists: true, status: 'unpaired', generation: 4 }, gen), 'removed');
    assert.equal(decideSessionEnd({ kind: 'record', fromCache: false, exists: true, status: 'active', generation: 4 }, gen), 'repaired');
  });

  it('a missing household or one being deleted ends it (S3, B2)', () => {
    assert.equal(decideSessionEnd({ kind: 'household', fromCache: false, exists: true, deleting: false }, gen), null);
    assert.equal(decideSessionEnd({ kind: 'household', fromCache: false, exists: false, deleting: false }, gen), 'household-deleted');
    assert.equal(decideSessionEnd({ kind: 'household', fromCache: false, exists: true, deleting: true }, gen), 'household-deleted');
  });

  it('a denied read, a sign-out or a revocation answer ends it; outages never do', () => {
    assert.equal(decideSessionEnd({ kind: 'denied', target: 'record' }, gen), 'removed');
    assert.equal(decideSessionEnd({ kind: 'signed-out' }, gen), 'removed');
    for (const code of ['device_revoked', 'unauthenticated', 'wrong_household', 'not_a_device']) assert.equal(decideSessionEnd({ kind: 'refusal', code }, gen), 'removed', code);
    assert.equal(decideSessionEnd({ kind: 'refusal', code: 'household_deleting' }, gen), 'household-deleted');
    for (const code of ['unavailable', 'rate_limited', 'failed', 'busy', 'pin_wrong', 'not_on_tablets']) assert.equal(decideSessionEnd({ kind: 'refusal', code }, gen), null, code);
  });

  it('the setup screen says how it ended', () => {
    assert.equal(endedNote('removed'), 'This tablet was removed.');
    assert.equal(endedNote('repaired'), 'This tablet was set up again on another screen.');
    assert.match(endedNote('household-deleted')!, /household was deleted/);
    assert.match(endedNote('new-code')!, /new code/);
    assert.equal(endedNote(null), null);
    assert.equal(destinationAfter('personal-sign-in'), '/');
    assert.equal(destinationAfter('removed'), '/setup');
    assert.equal(destinationAfter('new-code'), '/setup');
  });

  it('refusal copy keeps "not on tablets" (permanent) apart from "unavailable" (retry)', () => {
    assert.deepEqual(deviceRefusalResponse('not_on_tablets'), { kind: 'message', message: "That isn't available on wall tablets yet. Use your phone." });
    const retry = deviceRefusalResponse('unavailable');
    assert.equal(retry.kind === 'message' && retry.retry, true);
    assert.equal(deviceRefusalResponse('device_revoked').kind, 'revoked');
  });
});

describe('clearing (13, WT-19c)', () => {
  const recorder = (fail: ClearStep[] = []) => {
    const ran: ClearStep[] = [];
    const deps = Object.fromEntries(CLEAR_ORDER.map((step) => [step, async () => {
      ran.push(step);
      if (fail.includes(step)) throw new Error(step);
    }])) as ClearDeps;
    return { ran, deps };
  };

  it('runs every step in order: listeners, PIN and face, queue and journal, household data, Firestore, push, sign-out, note, navigation', async () => {
    const { ran, deps } = recorder();
    assert.deepEqual(await clearTabletSession(deps), []);
    assert.deepEqual(ran, [
      'stop-listeners', 'end-pin-and-face', 'delete-device-database', 'forget-household',
      'clear-firestore', 'clear-push', 'sign-out', 'set-note', 'navigate',
    ]);
  });

  it('a failing step never stops the rest; navigation always happens', async () => {
    const { ran, deps } = recorder(['delete-device-database', 'clear-firestore', 'sign-out']);
    assert.deepEqual(await clearTabletSession(deps), ['delete-device-database', 'clear-firestore', 'sign-out']);
    assert.equal(ran[ran.length - 1], 'navigate');
    assert.equal(ran.length, CLEAR_ORDER.length);
  });
});

describe('household-wide notification listeners (5.6, JC-23)', () => {
  it('one per enabled source, system and general always', () => {
    assert.deepEqual(deviceNotificationCategories(defaultSections()), ['chores', 'pets', 'shopping', 'maintenance', 'system', 'general']);
    assert.deepEqual(deviceNotificationCategories({ ...defaultSections(), chores: false, shopping: false }), ['pets', 'maintenance', 'system', 'general']);
    assert.deepEqual(deviceNotificationCategories({ chores: false, shopping: false, pets: false, calendar: false, maintenance: false }), ['system', 'general']);
    assert.equal(DEVICE_NOTICES_LIMIT, 50);
  });
});
