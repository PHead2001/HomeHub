import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  choreAnswerMeaning,
  feedAgainCheck,
  queuedSendResult,
  SENDABLE_CAPABILITIES,
  UNDO_CAPABILITY_OF,
} from '../../src/lib/devices/device-action-answers';
import { DEVICE_ACTION_POLICY, backdatedCapability, policyOf, requiredLevel } from '../../src/lib/devices/action-policy';
import { queueAllowed } from '../../src/lib/devices/offline-queue';
import { personMay, rosterFrom } from '../../src/lib/devices/roster';
import { PET_PERMISSIONS } from '../../src/lib/permissions';
import { feedLogDocument, feedStateDocument, withStampFor } from '../../src/lib/pets/feed-documents';
import { loggedOnDevice } from '../../src/components/pets/logged-by';

// Pets on a registered wall tablet (docs/modules/devices/README.md, "Device actions: pets";
// F4b-1: PE-2c/d, PE-17a/b/c/e, PE-23g/l, D-P6, JC-27, R5): what the tablet sends and how it
// reads the answers, the shared permission names, the shared document builders, a child's
// options, history naming the tablet, and that every feeding entry point uses the device path.

const read = (path: string) => readFileSync(path, 'utf8');

describe('what the tablet sends for pets', () => {
  it('feeding (live and backdated) and care, each with its Undo; doses, notes, weight, deletes and profile edits stay refused', () => {
    for (const capability of ['pets.feed', 'pets.feed.backdated', 'pets.feed.backdated.old', 'pets.feed.undo', 'pets.care.add', 'pets.care.undo'] as const) {
      assert.ok(SENDABLE_CAPABILITIES.has(capability), capability);
    }
    for (const capability of ['pets.dose.give', 'pets.note.add', 'pets.weight.add', 'pets.log.delete', 'pets.profile.edit', 'pets.log.correctTime'] as const) {
      assert.equal(SENDABLE_CAPABILITIES.has(capability), false, capability);
    }
    assert.equal(UNDO_CAPABILITY_OF['pets.feed'], 'pets.feed.undo');
    assert.equal(UNDO_CAPABILITY_OF['pets.feed.backdated.old'], 'pets.feed.undo');
    assert.equal(UNDO_CAPABILITY_OF['pets.care.add'], 'pets.care.undo');
  });

  it('levels: face once proven, the points PIN never applies (D-P6), backdating older than 12 h is PIN (JC-27)', () => {
    for (const pointsPin of ['off', 'kids', 'everyone'] as const) {
      assert.equal(requiredLevel('pets.feed', { pointsPin, actorRole: 'child' }), 'face');
      assert.equal(requiredLevel('pets.care.add', { pointsPin, actorRole: 'child' }), 'face');
    }
    assert.equal(requiredLevel('pets.feed.backdated.old', { pointsPin: 'off', actorRole: 'owner' }), 'pin');
    const now = new Date('2026-11-14T20:00:00Z');
    assert.equal(backdatedCapability('feed', new Date(now.getTime() - 11 * 3_600_000), now), 'pets.feed.backdated');
    assert.equal(backdatedCapability('feed', new Date(now.getTime() - 13 * 3_600_000), now), 'pets.feed.backdated.old');
    assert.equal(queueAllowed('pets.feed', { pointsPin: 'everyone', actorRole: 'child' }), true, 'face-level feeds can wait offline (PE-23l)');
    assert.equal(queueAllowed('pets.feed.backdated.old', { pointsPin: 'off', actorRole: 'owner' }), false);
  });
});

describe('reading pets answers', () => {
  const saved = { result: { status: 'saved', logId: 'l1', countToday: 1, perDay: 2, slot: null, portion: { amount: 1, unit: 'Cups' }, mealsComplete: false } };
  it('a saved feed offers Undo, a replay of the same press too; a cancelled "Feed again?" says nothing', () => {
    assert.deepEqual(choreAnswerMeaning('pets.feed', saved, 'Fed Maple'), { undoable: true, message: 'Fed Maple.' });
    assert.equal(choreAnswerMeaning('pets.feed', { result: { ...saved.result, replayed: true } }, 'Fed Maple').undoable, true);
    assert.deepEqual(choreAnswerMeaning('pets.feed', { cancelled: true }, 'Fed Maple'), { undoable: false, notice: true, message: '' });
    assert.equal(choreAnswerMeaning('pets.care.add', { status: 'added', logId: 'c1' }, 'Maple: Walk').undoable, true);
  });

  it('"Feed again?" is read from the answer, dates and names included, never an email', () => {
    const check = feedAgainCheck('pets.feed', { result: { status: 'needsConfirm', staleConfirm: true, reason: 'recent', lastLogId: 'l0', lastFedAt: '2026-11-14T19:50:00.000Z', lastFedByUid: 'u', lastFedByName: 'sam@example.test', countToday: 1, perDay: 2 } });
    assert.ok(check);
    assert.equal(check!.staleConfirm, true);
    assert.equal(check!.lastFedAt?.toISOString(), '2026-11-14T19:50:00.000Z');
    assert.equal(check!.lastFedByName, null);
    assert.equal(feedAgainCheck('pets.feed', saved), null);
    assert.equal(feedAgainCheck('pets.care.add', { result: { status: 'needsConfirm' } }), null);
  });

  it('queued replays: a saved feed or added entry is applied; Undo answers leave nothing to do; anything else is dropped', () => {
    assert.deepEqual(queuedSendResult('pets.feed', { ok: true, data: saved }), { ok: true });
    assert.deepEqual(queuedSendResult('pets.care.add', { ok: true, data: { status: 'added' } }), { ok: true });
    assert.equal(queuedSendResult('pets.feed', { ok: true, data: { result: { status: 'needsConfirm' } } }).ok, false);
    for (const status of ['undone', 'already', 'not_applied']) {
      assert.deepEqual(queuedSendResult('pets.feed.undo', { ok: true, data: { status } }), { ok: true });
      assert.deepEqual(queuedSendResult('pets.care.undo', { ok: true, data: { status } }), { ok: true });
    }
  });
});

describe('R5: the tablet uses the same permission names as the personal paths', () => {
  it('the policy names PET_PERMISSIONS; the rules gate pet logs with the same names', () => {
    assert.deepEqual(DEVICE_ACTION_POLICY['pets.feed'].permissions, [PET_PERMISSIONS.addLogs]);
    assert.deepEqual(DEVICE_ACTION_POLICY['pets.care.add'].permissions, [PET_PERMISSIONS.addLogs]);
    assert.equal(policyOf('pets.feed.undo').actorRulePermission, PET_PERMISSIONS.deleteLogs);
    const rules = read('firestore.rules');
    const careBlock = rules.slice(rules.indexOf('match /care-logs/{logId}'), rules.indexOf('match /care-logs/{logId}') + 700);
    assert.match(careBlock, new RegExp(`allow create: if hasHouseholdPermission\\(householdId, '${PET_PERMISSIONS.addLogs.replace('.', '\\.')}'\\)`));
    assert.match(careBlock, new RegExp(`allow delete: if hasHouseholdPermission\\(householdId, '${PET_PERMISSIONS.deleteLogs.replace('.', '\\.')}'\\)`));
    const feedBlock = rules.slice(rules.indexOf('match /feeding-logs/{logId}'), rules.indexOf('match /feeding-logs/{logId}') + 1500);
    assert.ok(feedBlock.includes(`'${PET_PERMISSIONS.addLogs}'`) && feedBlock.includes(`'${PET_PERMISSIONS.deleteLogs}'`));
  });
});

describe('one set of feed documents for the client and the server', () => {
  const times = { serverTime: () => 'SERVER', timestamp: (at: Date) => ({ at: at.toISOString(), toMillis: () => at.getTime() }) };
  const input = { portion: { amount: 1, unit: 'Cups' as const }, food: 'Dry' as const, user: { uid: 'kid_x', name: 'Mia' } };

  it('a live feed is at server time; a backdated one at its stamp; server-only fields come in through extra', () => {
    const live = feedLogDocument(input, { fedAt: new Date('2026-11-14T20:00:00Z'), live: true, repeat: 'none', slotId: 'slot-a' }, times, { extra: { deviceAttribution: { deviceName: 'Kitchen tablet' } } });
    assert.equal(live.date, 'SERVER');
    assert.equal(live.loggedAt, 'SERVER');
    assert.equal(live.loggedByUid, 'kid_x');
    assert.equal(live.slotId, 'slot-a');
    assert.deepEqual(live.deviceAttribution, { deviceName: 'Kitchen tablet' });
    const stamp = { at: 'stamp', toMillis: () => 1 };
    const back = feedLogDocument({ ...input, backdatedAt: new Date('2026-11-14T18:00:00Z') }, { fedAt: new Date('2026-11-14T18:00:00Z'), live: false, repeat: 'none' }, times, { stamp });
    assert.equal(back.date, stamp);
    assert.equal(back.backdated, true);
    const offline = feedLogDocument(input, { fedAt: new Date('2026-11-14T18:00:00Z'), live: false, repeat: 'offline' }, times);
    assert.equal(offline.clockSource, 'device');
  });

  it('the state names a live log at server time and a stamped log at its stamp', () => {
    const derived = {
      latest: { logId: 'l2', at: new Date('2026-11-14T20:00:00Z'), rawDate: null, byUid: 'kid_x', byName: 'Mia' },
      prev: { logId: 'l1', at: new Date('2026-11-14T18:00:00Z'), rawDate: { toMillis: () => 5 }, byUid: 'u', byName: 'Sam' },
      day: '2026-11-14', countOnDay: 2,
    };
    const state = feedStateDocument(derived, 'l2', times);
    assert.equal(state.lastFedAt, 'SERVER');
    assert.deepEqual((state.prev as { lastFedAt: unknown }).lastFedAt, derived.prev.rawDate);
    const stamp = { toMillis: () => 9 };
    const stamped = feedStateDocument(withStampFor(derived, 'l2', stamp), null, times);
    assert.equal(stamped.lastFedAt, stamp, 'the state names the log at the identical stored time');
  });

  it('guards: both writers use the shared builders', () => {
    assert.match(read('src/lib/pets/feed-transaction.ts'), /feedLogDocument\(logInput\(input\), plan, CLIENT_TIMES/);
    const server = read('src/lib/server/pet-feeding.ts');
    assert.match(server, /feedLogDocument\(logInput, \{ fedAt: plan\.fedAt/);
    assert.match(server, /feedStateDocument\(state, plan\.live \? logId : null, ADMIN_TIMES\)/);
  });
});

describe("a face gets only that person's options (PE-17e)", () => {
  it('the roster carries effective permissions; a child may feed but not delete logs', () => {
    const roster = rosterFrom([
      { id: 'kid_a', data: { role: 'child', kind: 'identity', status: 'active', displayName: 'Mia' } },
      { id: 'u_m', data: { role: 'member', status: 'active', displayName: 'Max', permissions: { 'pets.addLogs': false } } },
    ]);
    const kid = roster.find((p) => p.uid === 'kid_a')!;
    const max = roster.find((p) => p.uid === 'u_m')!;
    assert.equal(personMay(kid, policyOf('pets.feed').permissions), true);
    assert.equal(personMay(kid, [PET_PERMISSIONS.deleteLogs]), false);
    assert.equal(personMay(max, policyOf('pets.feed').permissions), false, 'an override applies');
  });

  it('guards: the shell refuses an option the chosen person lacks before sending; quick add offers only theirs', () => {
    assert.match(read('src/components/devices/tablet-shell.tsx'), /if \(!personMay\(who, policy\.permissions\)\) \{\s*message\('forbidden', who\);/);
    assert.match(read('src/components/devices/tablet-quick-add.tsx'), /personMay\(remembered, policyOf\(intent\.capability\)\.permissions\)/);
  });
});

describe('every feeding entry point on a tablet is a device action (PE-17a), and history names the tablet (PE-17c)', () => {
  it('the shared feed hook sends pets.feed through the shell when a tablet is present', () => {
    const hook = read('src/components/pets/use-feed-action.tsx');
    assert.match(hook, /const tablet = React\.useContext\(TabletContext\);/);
    assert.match(hook, /tablet \? runOnTablet\(request\) : execute\(/);
    assert.match(hook, /await tablet\.runAction\(\{\s*capability,/);
  });

  it('Feed, hold, quick add and dashboard Fed all reach it', () => {
    const views = read('src/components/devices/tablet-views.tsx');
    assert.match(views, /useFeedAction\(pet\.id, pet\.name/);
    assert.match(views, /useHoldToFeed\(controller, avatar\)/);
    assert.match(read('src/components/devices/tablet-quick-add.tsx'), /capability: 'pets\.feed',/);
    // Dashboard Fed uses the same hook (and on a tablet shows no failed state of its own).
    assert.match(read('src/components/dashboard/one-tap.tsx'), /if \(result === null && !tablet\) setFailed\(true\);/);
  });

  it('"Feed again?" on a tablet goes back with the same opId', () => {
    const runtime = read('src/components/devices/use-device-actions.tsx');
    assert.match(runtime, /const answered = confirm \? await confirm\(check\) : null;/);
    assert.match(runtime, /answer = await send\(capability, base, intent\);/);
  });

  it('history: "by Mia on Kitchen tablet"', () => {
    assert.equal(loggedOnDevice({ loggedByName: 'Mia', deviceAttribution: { deviceName: 'Kitchen tablet', level: 'face' } }), 'Kitchen tablet');
    assert.equal(loggedOnDevice({ loggedByName: 'Mia' }), null);
    assert.match(read('src/components/pets/logged-by.tsx'), /by \{name\}\{device \? ` on \$\{device\}` : ''\}/);
  });
});

describe('no email in answers or the op ledger (WT-10e, design 10.1)', () => {
  it('withoutEmails drops every …Email field at any depth, keeps public names, and leaves timestamps as they are', async () => {
    const { withoutEmails } = await import('../../src/lib/devices/without-emails');
    const stamp = new Date('2026-11-14T20:00:00Z');
    const cleaned = withoutEmails({ outcome: { completion: { completedByEmail: 'a@b.co', completedByName: 'a@b.co', completedAt: stamp } }, list: [{ ownerEmail: 'x@y.z', ownerName: 'Sam' }] });
    assert.equal(JSON.stringify(cleaned).includes('@'), false);
    assert.equal(cleaned.outcome.completion.completedAt, stamp, 'non-plain objects are kept as they are');
    assert.deepEqual(cleaned.list, [{ ownerName: 'Sam' }]);
  });

  it('guard: the gate stores every ledger summary through withoutEmails', () => {
    assert.match(read('src/lib/server/device-gate.ts'), /summary: withoutEmails\(outcome\.summary\)/);
  });
});
