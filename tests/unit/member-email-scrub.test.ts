import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { choreStatsAssigneeKey, choreStatsMemberKey } from '../../functions/src/shared/ids';
import { addPurgedChores, creditedPerson, foldLegacyStatsKeys, readChoreStats } from '../../functions/src/shared/chore-stats';
import { choreEmailScrubPlan } from '../../scripts/ops/shared-email-scrub.mjs';
import { choreMemberEmailPlan, memberRecordEmailPlan } from '../../scripts/ops/member-email-scrub.mjs';
import { FORMER_KEY_PREFIX, formerEvidence, formerMemberKey, proposeFormerIdentity, unknownLegacyKey } from '../../scripts/ops/former-member-key.mjs';
import {
  choreStatsAssigneeKeyJs,
  addFormerLegacyKeys,
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
    // The identity is the person's own uid (settled from the chores): a chore holding it is left as is,
    // one holding another uid is credited to the identity.
    const identityIsUid = (email: string) => (email === 'gone@example.test' ? 'uid-lee' : '');
    const ownUid = choreMemberEmailPlan({ isCompleted: true, assignedToUid: 'uid-lee', assignedToEmail: 'gone@example.test' }, uidByEmail, identityIsUid);
    assert.ok(ownUid.kind === 'scrub' && ownUid.assignee === 'scrub');
    assert.deepEqual((ownUid as { set: Record<string, unknown> }).set, {});
    const otherUid = choreMemberEmailPlan({ isCompleted: true, assignedToUid: 'uid-kim', assignedToEmail: 'gone@example.test' }, uidByEmail, identityIsUid);
    assert.ok(otherUid.kind === 'scrub' && otherUid.assignee === 'former');
    assert.equal((otherUid as { set: Record<string, unknown> }).set.assignedToUid, 'uid-lee');
    // An email with no settled identity yet is kept, never dropped.
    assert.deepEqual(choreMemberEmailPlan({ isCompleted: true, assignedToEmail: 'new@example.test' }, uidByEmail, () => ''), { kind: 'kept' });
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

  test('a departed email is their uid only when the chores pair it with exactly one, and that uid with no other email', () => {
    const current = { uids: new Set(['uid-sam']), emails: new Set(['sam@example.test']) };
    const evidence = formerEvidence([
      { assignedToEmail: 'Lee@example.test', assignedToUid: 'uid-lee', isCompleted: true },
      { completedByEmail: 'lee@example.test', completedByUid: 'uid-lee' },
      { assignedToEmail: 'lee@example.test' },
      // Kim's email next to two uids (an older build's email-only reassignment left one behind).
      { assignedToEmail: 'kim@example.test', assignedToUid: 'uid-kim' },
      { assignedToEmail: 'kim@example.test', assignedToUid: 'uid-old' },
      // Two emails next to one uid.
      { assignedToEmail: 'ann@example.test', assignedToUid: 'uid-shared' },
      { recurrence: { assignedToEmail: 'bo@example.test' }, assignedToUid: 'uid-shared' },
      // A current member's uid is never evidence, and a current member is never departed.
      { assignedToEmail: 'max@example.test', assignedToUid: 'uid-sam' },
      { assignedToEmail: 'sam@example.test', assignedToUid: 'uid-sam' },
    ], current);
    assert.deepEqual([...evidence.emails].sort(), ['ann@example.test', 'bo@example.test', 'kim@example.test', 'lee@example.test', 'max@example.test']);
    assert.equal(proposeFormerIdentity('lee@example.test', evidence, 's'), 'uid-lee');
    assert.equal(proposeFormerIdentity('kim@example.test', evidence, 's'), formerMemberKey('s', 'kim@example.test'), 'ambiguous: two uids');
    assert.equal(proposeFormerIdentity('ann@example.test', evidence, 's'), formerMemberKey('s', 'ann@example.test'), 'ambiguous: uid with two emails');
    assert.equal(proposeFormerIdentity('max@example.test', evidence, 's'), formerMemberKey('s', 'max@example.test'), 'no evidence');
  });

  test('a legacy key nobody is named for any more gets its own stable opaque key', () => {
    const legacy = choreStatsAssigneeKey('gone@example.test');
    assert.match(unknownLegacyKey('s', legacy), /^former-[0-9a-f]{24}$/);
    assert.equal(unknownLegacyKey('s', legacy), unknownLegacyKey('s', legacy));
    assert.notEqual(unknownLegacyKey('s', legacy), formerMemberKey('s', 'gone@example.test'));
    assert.equal(unknownLegacyKey('', legacy), '');
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

  test('members and departed people go to their identities; anyone else to a stable opaque key', () => {
    const sam = choreStatsAssigneeKey('sam@example.test');
    const lee = choreStatsAssigneeKey('lee@example.test');
    const gone = choreStatsAssigneeKey('gone@example.test');
    const byLegacy = legacyKeyMap([{ uid: 'uid-sam', email: 'Sam@Example.test' }, { uid: 'uid-ana', email: '' }, { uid: '', email: 'x@example.test' }]);
    assert.deepEqual([...byLegacy.entries()], [[sam, choreStatsMemberKey('uid-sam')]]);
    const leeIdentity = formerMemberKey('s', 'lee@example.test');
    addFormerLegacyKeys(byLegacy, ['lee@example.test', 'sam@example.test'], email => (email === 'lee@example.test' ? leeIdentity : 'never-used'));
    assert.equal(byLegacy.get(lee), choreStatsMemberKey(leeIdentity));
    assert.equal(byLegacy.get(sam), choreStatsMemberKey('uid-sam'), 'a current member keeps their uid key');
    const data = {
      year: 2026, completed: 18,
      byAssignee: { [sam]: 5, [choreStatsMemberKey('uid-sam')]: 2, [lee]: 6, [gone]: 4, 'former-1': 1 },
      names: { [sam]: 'Sam M', [choreStatsMemberKey('uid-sam')]: 'Sam Member', [lee]: 'Lee', [gone]: 'Gil' },
    };
    const unknownKeyOf = (key: string) => unknownLegacyKey('s', key);
    const plan = statsRekeyPlan(data, byLegacy, unknownKeyOf);
    const goneKey = choreStatsMemberKey(unknownLegacyKey('s', gone));
    assert.deepEqual(plan, {
      kind: 'rekey',
      byAssignee: { [choreStatsMemberKey('uid-sam')]: 7, 'former-1': 1, [choreStatsMemberKey(leeIdentity)]: 6, [goneKey]: 4 },
      names: { [choreStatsMemberKey('uid-sam')]: 'Sam Member', [choreStatsMemberKey(leeIdentity)]: 'Lee', [goneKey]: 'Gil' },
      moved: 2,
      unknown: 1,
      removeAliases: false,
    });
    // Nothing left that is derived from an email, and a second run does nothing.
    const after = { ...data, byAssignee: (plan as { byAssignee: Record<string, number> }).byAssignee, names: (plan as { names: Record<string, string> }).names };
    assert.ok(!JSON.stringify(after).includes('sam_') && !JSON.stringify(after).includes('lee_') && !JSON.stringify(after).includes('gone'));
    assert.deepEqual(statsRekeyPlan(after, byLegacy, unknownKeyOf), { kind: 'clean' });
    // Without unknownKeyOf (the scrub's re-key), a legacy key of nobody known is left for the re-key script.
    const partial = statsRekeyPlan(data, byLegacy) as { byAssignee: Record<string, number>; unknown: number };
    assert.equal(partial.byAssignee[gone], 4);
    assert.equal(partial.unknown, 0);
  });

  test('a departure alias (release C) sends the legacy key of that person to their uid key, in the re-key and the scrub', () => {
    const gone = choreStatsAssigneeKey('gone@example.test');
    const data = { byAssignee: { [gone]: 6 }, names: { [gone]: 'Gil' }, aliases: { 'uid-gil': gone } };
    assert.deepEqual(statsRekeyPlan(data, new Map(), k => unknownLegacyKey('s', k)), {
      kind: 'rekey', byAssignee: { [choreStatsMemberKey('uid-gil')]: 6 }, names: { [choreStatsMemberKey('uid-gil')]: 'Gil' }, moved: 1, unknown: 0, removeAliases: true,
    });
    // The alias itself is removed with it; an alias-only document is not clean either, and a re-run is.
    assert.deepEqual(statsRekeyPlan({ aliases: { 'uid-gil': gone } }, new Map()), { kind: 'rekey', byAssignee: {}, names: {}, moved: 0, unknown: 0, removeAliases: true });
    assert.deepEqual(statsRekeyPlan({ byAssignee: { [choreStatsMemberKey('uid-gil')]: 6 }, names: {} }, new Map()), { kind: 'clean' });
    // Upkeep and Home Wrapped fold it the same way.
    assert.deepEqual(foldLegacyStatsKeys(readChoreStats(data, 2026)).byAssignee, { [choreStatsMemberKey('uid-gil')]: 6 });
    // The scrub's identity for that email is the aliased uid, over any other evidence.
    const evidence = formerEvidence([{ assignedToEmail: 'gone@example.test', assignedToUid: 'uid-other' }], { uids: new Set(), emails: new Set() });
    assert.equal(proposeFormerIdentity('gone@example.test', { ...evidence, aliasUids: new Map([['gone@example.test', 'uid-gil']]) }, 's'), 'uid-gil');
  });

  test('a stats document already keyed by uid, or empty, is clean', () => {
    assert.deepEqual(statsRekeyPlan({ byAssignee: { [choreStatsMemberKey('u')]: 1 }, names: {} }, new Map()), { kind: 'clean' });
    assert.deepEqual(statsRekeyPlan(undefined, new Map()), { kind: 'clean' });
    // A label without a count still moves.
    const legacy = choreStatsAssigneeKey('sam@example.test');
    const key = choreStatsMemberKey(unknownLegacyKey('s', legacy));
    assert.deepEqual(statsRekeyPlan({ names: { [legacy]: 'Sam' } }, new Map(), k => unknownLegacyKey('s', k)), { kind: 'rekey', byAssignee: {}, names: { [key]: 'Sam' }, moved: 0, unknown: 1, removeAliases: false });
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
