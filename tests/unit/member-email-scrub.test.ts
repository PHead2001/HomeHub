import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { choreStatsAssigneeKey, choreStatsMemberKey } from '../../functions/src/shared/ids';
import { addPurgedChores, creditedPerson, foldLegacyStatsKeys, readChoreStats } from '../../functions/src/shared/chore-stats';
import { choreEmailScrubPlan } from '../../scripts/ops/shared-email-scrub.mjs';
import { choreMemberEmailPlan, memberRecordEmailPlan } from '../../scripts/ops/member-email-scrub.mjs';
import { FORMER_KEY_PREFIX, formerMemberKey, formerMemberSecret } from '../../scripts/ops/former-member-key.mjs';
import {
  choreStatsAssigneeKeyJs,
  choreStatsMemberKeyJs,
  isLegacyStatsKey,
  legacyKeyMap,
  statsRekeyPlan,
} from '../../scripts/ops/chore-stats-rekey.mjs';

// Applies a plan the way the scripts do: sets, then deletions of each path.
const applyPlan = (data: Record<string, unknown>, plan: { remove: string[][]; set?: Record<string, unknown> }) => {
  const next = structuredClone(data);
  Object.assign(next, plan.set ?? {});
  for (const path of plan.remove) {
    let node = next as Record<string, unknown>;
    for (const segment of path.slice(0, -1)) node = node[segment] as Record<string, unknown>;
    delete node[path[path.length - 1]];
  }
  return next;
};

describe('membership record email scrub', () => {
  test('a record without an email is left alone', () => {
    assert.deepEqual(memberRecordEmailPlan({ uid: 'u', role: 'member' }, { email: 'a@example.test' }), { kind: 'clean' });
    assert.deepEqual(memberRecordEmailPlan(null, null), { kind: 'clean' });
  });

  test('the email is removed only when the contact document holds the same one', () => {
    assert.deepEqual(memberRecordEmailPlan({ email: 'Sam@Example.test' }, { email: ' sam@example.test ' }), { kind: 'scrub', remove: [['email']] });
    for (const contact of [null, undefined, {}, { email: '' }, { email: 7 }]) {
      assert.deepEqual(memberRecordEmailPlan({ email: 'sam@example.test' }, contact), { kind: 'no-contact' });
    }
    assert.deepEqual(memberRecordEmailPlan({ email: 'sam@example.test' }, { email: 'other@example.test' }), { kind: 'mismatch' });
  });

  test('an empty or non-text email field is removed, and a second run finds nothing', () => {
    for (const email of ['', '  ', null, 42]) {
      assert.deepEqual(memberRecordEmailPlan({ email }, null), { kind: 'scrub', remove: [['email']] });
    }
    const record = { uid: 'u', email: 'sam@example.test', role: 'member' };
    const plan = memberRecordEmailPlan(record, { email: 'sam@example.test' });
    assert.equal(plan.kind, 'scrub');
    const after = applyPlan(record, plan as { remove: string[][] });
    assert.deepEqual(after, { uid: 'u', role: 'member' });
    assert.deepEqual(memberRecordEmailPlan(after, { email: 'sam@example.test' }), { kind: 'clean' });
  });
});

describe('chore email scrub (release D)', () => {
  const uidByEmail = new Map([['sam@example.test', 'uid-sam'], ['ana@example.test', 'uid-ana']]);

  test('release C kept completed chores without a completer; release D scrubs them too', () => {
    const chore = { isCompleted: true, assignedToEmail: 'sam@example.test' };
    assert.deepEqual(choreEmailScrubPlan(chore, uidByEmail), { kind: 'credit' });
    assert.deepEqual(choreEmailScrubPlan(chore, uidByEmail, { keepForStats: false }), {
      kind: 'repaired', remove: [['assignedToEmail']], set: { assignedToUid: 'uid-sam' },
    });
    const plan = choreMemberEmailPlan(chore, uidByEmail);
    assert.equal(plan.kind, 'scrub');
    assert.deepEqual(applyPlan(chore, plan as { remove: string[][]; set: Record<string, unknown> }), { isCompleted: true, assignedToUid: 'uid-sam' });
  });

  test('completedByEmail is removed; completedByUid is set first when missing', () => {
    const done = { isCompleted: true, assignedToUid: 'uid-ana', completedByUid: 'uid-sam', completedByEmail: 'sam@example.test', completedByName: 'Sam' };
    const plan = choreMemberEmailPlan(done, uidByEmail);
    assert.ok(plan.kind === 'scrub' && plan.completer === 'removed' && plan.assignee === 'clean');
    assert.deepEqual(applyPlan(done, plan as { remove: string[][] }), { isCompleted: true, assignedToUid: 'uid-ana', completedByUid: 'uid-sam', completedByName: 'Sam' });

    const noUid = { isCompleted: true, completedByEmail: 'ANA@example.test' };
    const repaired = choreMemberEmailPlan(noUid, uidByEmail);
    assert.ok(repaired.kind === 'scrub' && repaired.completer === 'repaired');
    assert.deepEqual(applyPlan(noUid, repaired as { remove: string[][]; set: Record<string, unknown> }), { isCompleted: true, completedByUid: 'uid-ana' });
    // Empty value: removed.
    assert.ok(choreMemberEmailPlan({ completedByEmail: '' }, uidByEmail).kind === 'scrub');
  });

  test('a completer who left, without a uid, keeps the email (else the assignee would be credited)', () => {
    assert.deepEqual(choreMemberEmailPlan({ isCompleted: true, assignedToUid: 'uid-ana', completedByEmail: 'gone@example.test' }, uidByEmail), { kind: 'kept' });
    const both = choreMemberEmailPlan({ isCompleted: true, assignedToEmail: 'ana@example.test', completedByEmail: 'gone@example.test' }, uidByEmail);
    assert.ok(both.kind === 'scrub' && both.completer === 'kept' && both.assignee === 'repaired');
    assert.ok(!(both as { remove: string[][] }).remove.some(path => path[0] === 'completedByEmail'));
  });

  test('a completed chore credited to someone who left keeps that credit under a former-member key', () => {
    const keyOf = (email: string) => formerMemberKey('household-secret', email);
    const people = [{ uid: 'uid-sam', email: 'sam@example.test' }, { uid: 'uid-ana', email: 'ana@example.test' }];
    const gone = keyOf('gone@example.test');
    // Assignee who left, known only by email (no uid, no completer recorded).
    const legacy = { isCompleted: true, assignedToEmail: 'Gone@Example.test', assignedToDisplayName: 'Lee' };
    assert.equal(creditedPerson(legacy, people), null, 'the email names nobody: no credit while it is stored');
    const plan = choreMemberEmailPlan(legacy, uidByEmail, keyOf);
    assert.ok(plan.kind === 'scrub' && plan.assignee === 'former' && plan.completer === 'none');
    const after = applyPlan(legacy, plan as { remove: string[][]; set: Record<string, unknown> });
    assert.deepEqual(after, { isCompleted: true, assignedToUid: gone, assignedToDisplayName: 'Lee' });
    assert.deepEqual(creditedPerson(after, people), { uid: gone, name: 'Lee' });
    // A current member's leftover uid next to the email of someone who left (release C clears it):
    // a completed chore gets the former key instead, an open one is cleared as before.
    const stale = { isCompleted: true, assignedToUid: 'uid-ana', assignedToEmail: 'gone@example.test' };
    const stalePlan = choreMemberEmailPlan(stale, uidByEmail, keyOf);
    assert.ok(stalePlan.kind === 'scrub' && stalePlan.assignee === 'former');
    assert.equal(applyPlan(stale, stalePlan as { remove: string[][]; set: Record<string, unknown> }).assignedToUid, gone);
    const open = choreMemberEmailPlan({ ...stale, isCompleted: false }, uidByEmail, keyOf);
    assert.ok(open.kind === 'scrub' && open.assignee === 'cleared');
    assert.equal((open as { set: Record<string, unknown> }).set.assignedToUid, '');
    // A stored uid that is not a current member's (the person's own) already carries the credit.
    const ownUid = choreMemberEmailPlan({ isCompleted: true, assignedToUid: 'uid-lee', assignedToEmail: 'gone@example.test' }, uidByEmail, keyOf);
    assert.ok(ownUid.kind === 'scrub' && ownUid.assignee === 'scrub');
    assert.deepEqual((ownUid as { set: Record<string, unknown> }).set, {});
    // A recorded completer means the assignee's email carries no credit.
    const byCompleter = choreMemberEmailPlan({ isCompleted: true, assignedToEmail: 'gone@example.test', completedByUid: 'uid-sam' }, uidByEmail, keyOf);
    assert.ok(byCompleter.kind === 'scrub' && byCompleter.assignee === 'scrub');
  });

  test('a completer who left, without a uid, gets their former-member key as completedByUid', () => {
    const keyOf = (email: string) => formerMemberKey('household-secret', email);
    const done = { isCompleted: true, assignedToUid: 'uid-ana', completedByEmail: 'GONE@example.test', completedByName: 'Lee' };
    const plan = choreMemberEmailPlan(done, uidByEmail, keyOf);
    assert.ok(plan.kind === 'scrub' && plan.completer === 'former' && plan.assignee === 'clean');
    const after = applyPlan(done, plan as { remove: string[][]; set: Record<string, unknown> });
    assert.deepEqual(after, { isCompleted: true, assignedToUid: 'uid-ana', completedByUid: keyOf('gone@example.test'), completedByName: 'Lee' });
    // The completer, not the assignee, keeps the credit; the same person shares one key across chores.
    const assigneeOnly = { isCompleted: true, assignedToEmail: 'gone@example.test' };
    const assigneeAfter = applyPlan(assigneeOnly, choreMemberEmailPlan(assigneeOnly, uidByEmail, keyOf) as { remove: string[][]; set: Record<string, unknown> });
    const stats = addPurgedChores(readChoreStats(undefined, 2026), [
      { ...after, completedAt: '2026-01-02T00:00:00.000Z' },
      { ...assigneeAfter, completedAt: '2026-01-03T00:00:00.000Z' },
    ]);
    const key = choreStatsMemberKey(keyOf('gone@example.test'));
    assert.deepEqual(stats.byAssignee, { [key]: 2 });
    assert.deepEqual(stats.names, { [key]: 'Lee' });
    assert.ok(!JSON.stringify(stats).includes('gone'), 'nothing readable from the email');
    // Re-running on the result writes nothing.
    assert.deepEqual(choreMemberEmailPlan(after, uidByEmail, keyOf), { kind: 'clean' });
    assert.deepEqual(choreMemberEmailPlan(assigneeAfter, uidByEmail, keyOf), { kind: 'clean' });
  });

  test('without a key function, an email that alone carries a credit is kept', () => {
    assert.deepEqual(choreMemberEmailPlan({ isCompleted: true, assignedToEmail: 'gone@example.test' }, uidByEmail), { kind: 'kept' });
    assert.deepEqual(choreMemberEmailPlan({ isCompleted: true, assignedToUid: 'uid-ana', assignedToEmail: 'gone@example.test' }, uidByEmail), { kind: 'kept' });
    // An open chore carries no credit: scrubbed as before.
    assert.equal(choreMemberEmailPlan({ isCompleted: false, assignedToEmail: 'gone@example.test' }, uidByEmail).kind, 'scrub');
  });

  test('clean documents and re-runs write nothing', () => {
    assert.deepEqual(choreMemberEmailPlan({ assignedToUid: 'uid-sam', completedByUid: 'uid-sam' }, uidByEmail), { kind: 'clean' });
    const template = { assignedToEmail: 'sam@example.test', recurrence: { frequency: 'daily', assignedToEmail: 'sam@example.test' } };
    const plan = choreMemberEmailPlan(template, uidByEmail);
    const after = applyPlan(template, plan as { remove: string[][]; set: Record<string, unknown> });
    assert.deepEqual(after, { assignedToUid: 'uid-sam', recurrence: { frequency: 'daily' } });
    assert.deepEqual(choreMemberEmailPlan(after, uidByEmail), { kind: 'clean' });
  });
});

describe('former-member keys', () => {
  test('stable per person and household, opaque, and left alone by the stats re-key', () => {
    const key = formerMemberKey('secret-a', 'Lee@Example.test ');
    assert.equal(key, formerMemberKey('secret-a', 'lee@example.test'), 'case and spaces do not matter');
    assert.match(key, /^former-[0-9a-f]{24}$/);
    assert.ok(key.startsWith(FORMER_KEY_PREFIX));
    assert.notEqual(key, formerMemberKey('secret-b', 'lee@example.test'), 'another household (secret) gives another key');
    assert.notEqual(key, formerMemberKey('secret-a', 'kim@example.test'));
    assert.ok(!key.includes('lee'));
    assert.equal(isLegacyStatsKey(choreStatsMemberKey(key)), false);
    assert.equal(formerMemberKey('secret-a', ''), '');
    assert.equal(formerMemberKey('', 'lee@example.test'), '');
  });

  // A fake of the one document: get and create as the Admin SDK has them.
  const fakeRef = (initial?: string) => {
    let stored: Record<string, unknown> | undefined = initial === undefined ? undefined : { secret: initial };
    const creates: unknown[] = [];
    const ref = {
      creates,
      onGet: () => {},
      race(secret: string) { stored = { secret }; },
      async get() { const data = stored; ref.onGet(); return { exists: data !== undefined, get: (field: string) => data?.[field] }; },
      async create(data: Record<string, unknown>) {
        if (stored) throw Object.assign(new Error('exists'), { code: 6 });
        creates.push(data);
        stored = data;
      },
    };
    return ref;
  };

  test('the secret is read, stored only when asked, and a concurrent creation wins', async () => {
    const existing = fakeRef('kept-secret');
    assert.deepEqual(await formerMemberSecret(existing, { create: true }), { secret: 'kept-secret', stored: true, created: false });
    assert.equal(existing.creates.length, 0);

    const missing = fakeRef();
    const dry = await formerMemberSecret(missing, { create: false });
    assert.equal(dry.stored, false);
    assert.ok(dry.secret.length >= 40);
    assert.equal(missing.creates.length, 0, 'nothing stored until asked');
    const made = await formerMemberSecret(missing, { create: true, candidate: dry.secret, now: () => 'now' });
    assert.deepEqual(made, { secret: dry.secret, stored: true, created: true });
    assert.deepEqual(missing.creates, [{ secret: dry.secret, createdAt: 'now' }]);

    // Another run stores its secret between our read and our create: we adopt theirs.
    const raced = fakeRef();
    let first = true;
    raced.onGet = () => { if (first) { first = false; raced.race('their-secret'); } };
    assert.deepEqual(await formerMemberSecret(raced, { create: true, candidate: 'mine' }), { secret: 'their-secret', stored: true, created: false });
  });
});

describe('yearly chore stats re-key', () => {
  test('the JavaScript key twins match functions/src/shared/ids.ts', () => {
    for (const email of ['sam@example.test', ' Sam.Member@Example.TEST ', 'ünïcode+tag@example.test', 'x@y', '@nobody']) {
      assert.equal(choreStatsAssigneeKeyJs(email), choreStatsAssigneeKey(email), email);
    }
    for (const uid of ['AbC123', 'owner-a', 'we.ird/uid', ' padded ']) {
      assert.equal(choreStatsMemberKeyJs(uid), choreStatsMemberKey(uid), uid);
    }
    assert.equal(isLegacyStatsKey(choreStatsAssigneeKey('sam@example.test')), true);
    assert.equal(isLegacyStatsKey(choreStatsMemberKey('uid-sam')), false);
    assert.equal(isLegacyStatsKey('former-3'), false);
  });

  test('members are folded into their uid key; people who left get an opaque key', () => {
    const sam = choreStatsAssigneeKey('sam@example.test');
    const gone = choreStatsAssigneeKey('gone@example.test');
    const byLegacy = legacyKeyMap([{ uid: 'uid-sam', email: 'Sam@Example.test' }, { uid: 'uid-ana', email: '' }, { uid: '', email: 'x@example.test' }]);
    assert.deepEqual([...byLegacy.entries()], [[sam, choreStatsMemberKey('uid-sam')]]);
    const data = {
      year: 2026, completed: 12,
      byAssignee: { [sam]: 5, [choreStatsMemberKey('uid-sam')]: 2, [gone]: 4, 'former-1': 1 },
      names: { [sam]: 'Sam M', [choreStatsMemberKey('uid-sam')]: 'Sam Member', [gone]: 'Lee' },
    };
    const plan = statsRekeyPlan(data, byLegacy);
    assert.deepEqual(plan, {
      kind: 'rekey',
      byAssignee: { [choreStatsMemberKey('uid-sam')]: 7, 'former-1': 1, 'former-2': 4 },
      names: { [choreStatsMemberKey('uid-sam')]: 'Sam Member', 'former-2': 'Lee' },
      members: 1,
      former: 1,
    });
    // Nothing left that is derived from an email, and a second run does nothing.
    const after = { ...data, byAssignee: (plan as { byAssignee: Record<string, number> }).byAssignee, names: (plan as { names: Record<string, string> }).names };
    assert.ok(!JSON.stringify(after).includes('sam_') && !JSON.stringify(after).includes('gone'));
    assert.deepEqual(statsRekeyPlan(after, byLegacy), { kind: 'clean' });
  });

  test('a stats document already keyed by uid, or empty, is clean', () => {
    assert.deepEqual(statsRekeyPlan({ byAssignee: { [choreStatsMemberKey('u')]: 1 }, names: {} }, new Map()), { kind: 'clean' });
    assert.deepEqual(statsRekeyPlan(undefined, new Map()), { kind: 'clean' });
    // A label without a count still moves.
    const legacy = choreStatsAssigneeKey('sam@example.test');
    assert.deepEqual(statsRekeyPlan({ names: { [legacy]: 'Sam' } }, new Map()), { kind: 'rekey', byAssignee: {}, names: { 'former-1': 'Sam' }, members: 0, former: 1 });
  });

  test('the script and upkeep fold a member the same way', () => {
    const sam = choreStatsAssigneeKey('sam@example.test');
    const data = { year: 2026, completed: 3, byAssignee: { [sam]: 3 }, names: { [sam]: 'Sam' } };
    const people = [{ uid: 'uid-sam', email: 'sam@example.test' }];
    const script = statsRekeyPlan(data, legacyKeyMap(people)) as { byAssignee: Record<string, number>; names: Record<string, string> };
    const upkeep = foldLegacyStatsKeys(readChoreStats(data, 2026), people);
    assert.deepEqual(script.byAssignee, upkeep.byAssignee);
    assert.deepEqual(script.names, upkeep.names);
  });
});
