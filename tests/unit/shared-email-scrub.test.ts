import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  choreEmailScrubPlan,
  householdEmailScrubPlan,
  householdUidsByEmail,
  notificationActionEmailPaths,
  notificationEmailScrubPlan,
  statsEmailScrubPlan,
} from '../../scripts/ops/shared-email-scrub.mjs';
import { resolveAssigneeUid } from '../../functions/src/shared/assignee';
import { isAddressedToMember } from '../../functions/src/shared/notification-audience';

const uidByEmail = householdUidsByEmail([
  { uid: 'uid-ana', contactEmail: 'Ana@Example.test', recordEmail: 'old-ana@example.test' },
  { uid: 'uid-sam', recordEmail: 'sam@example.test' },
  { uid: 'uid-none' },
]);
const people = [{ uid: 'uid-ana', email: 'ana@example.test' }, { uid: 'uid-sam', email: 'sam@example.test' }];

/** Applies a plan to plain data the way Firestore would. */
function applyPlan(data: Record<string, unknown>, plan: { remove?: string[][]; set?: Record<string, unknown> }) {
  const copy = structuredClone(data);
  Object.assign(copy, plan.set ?? {});
  for (const path of plan.remove ?? []) {
    let node = copy as Record<string, unknown>;
    for (const segment of path.slice(0, -1)) node = node[segment] as Record<string, unknown>;
    delete node[path[path.length - 1]];
  }
  return copy;
}

describe('member emails for the scrub', () => {
  test('the contact document wins over the record, case-insensitively', () => {
    assert.equal(uidByEmail.get('ana@example.test'), 'uid-ana');
    assert.equal(uidByEmail.get('old-ana@example.test'), undefined);
    assert.equal(uidByEmail.get('sam@example.test'), 'uid-sam');
    assert.equal(uidByEmail.size, 2);
  });
});

describe('chore and template assignee emails', () => {
  test('records without an email are left alone', () => {
    assert.deepEqual(choreEmailScrubPlan({ assignedToUid: 'uid-sam' }, uidByEmail), { kind: 'clean' });
    assert.deepEqual(choreEmailScrubPlan({ assignedToUid: 'uid-sam', assignedToEmail: '' }, uidByEmail), { kind: 'clean' });
    assert.deepEqual(choreEmailScrubPlan({ recurrence: { frequency: 'daily', assignedToEmail: '' } }, uidByEmail), { kind: 'clean' });
  });

  test('an email the uid agrees with is removed (top level and inside the recurrence)', () => {
    const template = { assignedToUid: 'uid-sam', assignedToEmail: 'sam@example.test', recurrence: { frequency: 'weekly', assignedToEmail: 'sam@example.test' } };
    const plan = choreEmailScrubPlan(template, uidByEmail);
    assert.deepEqual(plan, { kind: 'scrub', remove: [['assignedToEmail'], ['recurrence', 'assignedToEmail']], set: {} });
    assert.deepEqual(applyPlan(template, plan), { assignedToUid: 'uid-sam', recurrence: { frequency: 'weekly' } });
  });

  test('a missing or stale uid is set to the member the email names before the email goes', () => {
    for (const record of [{ assignedToEmail: 'SAM@example.test' }, { assignedToUid: 'uid-ana', assignedToEmail: 'sam@example.test' }]) {
      const before = resolveAssigneeUid(record, people);
      const plan = choreEmailScrubPlan(record, uidByEmail);
      assert.equal(plan.kind, 'repaired');
      const after = applyPlan(record, plan);
      assert.equal(after.assignedToEmail, undefined);
      // Readers resolve the same member afterwards, by uid alone.
      assert.equal(resolveAssigneeUid(after, people), before);
      assert.equal(resolveAssigneeUid(after, people.map(({ uid }) => ({ uid }))), before);
    }
  });

  test("a former member's email next to a current member's uid clears the uid", () => {
    const record = { assignedToUid: 'uid-ana', assignedToEmail: 'gone@example.test' };
    assert.equal(resolveAssigneeUid(record, people), null);
    const plan = choreEmailScrubPlan(record, uidByEmail);
    assert.equal(plan.kind, 'cleared');
    assert.equal(resolveAssigneeUid(applyPlan(record, plan), people), null);
    // Without a current member's uid the email is simply removed.
    assert.equal(choreEmailScrubPlan({ assignedToEmail: 'gone@example.test' }, uidByEmail).kind, 'scrub');
  });

  test('a completed chore without a recorded completer keeps its email for the yearly stats', () => {
    assert.deepEqual(choreEmailScrubPlan({ isCompleted: true, assignedToUid: 'uid-sam', assignedToEmail: 'sam@example.test' }, uidByEmail), { kind: 'credit' });
    assert.equal(choreEmailScrubPlan({ isCompleted: true, completedByEmail: 'sam@example.test', assignedToUid: 'uid-sam', assignedToEmail: 'sam@example.test' }, uidByEmail).kind, 'scrub');
    assert.equal(choreEmailScrubPlan({ isCompleted: false, assignedToUid: 'uid-sam', assignedToEmail: 'sam@example.test' }, uidByEmail).kind, 'scrub');
  });
});

describe('notification emails', () => {
  test('action-entry emails are found under readBy, dismissedBy and resolvedBy', () => {
    const data = {
      readBy: { 'uid-ana': { uid: 'uid-ana', email: 'ana@example.test' }, 'uid-sam': { uid: 'uid-sam' } },
      dismissedBy: { 'a.b': { email: 'x@example.test' } },
      resolvedBy: { uid: 'uid-sam', email: 'sam@example.test' },
    };
    assert.deepEqual(notificationActionEmailPaths(data), [['readBy', 'uid-ana', 'email'], ['dismissedBy', 'a.b', 'email'], ['resolvedBy', 'email']]);
    const plan = notificationEmailScrubPlan(data, uidByEmail);
    assert.equal(plan.kind, 'scrub');
    assert.deepEqual(applyPlan(data, plan), {
      readBy: { 'uid-ana': { uid: 'uid-ana' }, 'uid-sam': { uid: 'uid-sam' } },
      dismissedBy: { 'a.b': {} },
      resolvedBy: { uid: 'uid-sam' },
    });
  });

  test('a notification without emails is clean', () => {
    assert.deepEqual(notificationEmailScrubPlan({ audience: ['*'], readBy: { u: { uid: 'u' } } }, uidByEmail), { kind: 'clean' });
  });

  test('the target email goes when the uid names the member; a missing audience is added', () => {
    const data = { targetUserUid: 'uid-sam', targetUserEmail: 'sam@example.test' };
    const plan = notificationEmailScrubPlan(data, uidByEmail);
    assert.deepEqual(plan, { kind: 'scrub', remove: [['targetUserEmail']], set: { audience: ['uid-sam'] } });
    assert.deepEqual(notificationEmailScrubPlan({ ...data, audience: ['uid-sam'] }, uidByEmail), { kind: 'scrub', remove: [['targetUserEmail']], set: {} });
  });

  test('an email-only target is named by uid first, so it never becomes household-wide', () => {
    for (const data of [{ targetUserEmail: 'Sam@example.test' }, { targetUserEmail: 'sam@example.test', audience: [] }, { targetUserEmail: 'other@example.test', audience: ['uid-sam'] }]) {
      const plan = notificationEmailScrubPlan(data, uidByEmail);
      assert.equal(plan.kind, 'retargeted');
      const after = applyPlan(data, plan);
      assert.equal(after.targetUserEmail, undefined);
      assert.equal(after.targetUserUid, 'uid-sam');
      assert.equal(isAddressedToMember(after, { uid: 'uid-sam' }), true);
      assert.equal(isAddressedToMember(after, { uid: 'uid-ana' }), false);
    }
  });

  test("a former member's email-only target is kept (removing it would address everyone)", () => {
    const plan = notificationEmailScrubPlan({ targetUserEmail: 'gone@example.test', audience: [] }, uidByEmail);
    assert.deepEqual(plan, { kind: 'unresolvable', remove: [], set: {} });
    const withAction = notificationEmailScrubPlan({ targetUserEmail: 'gone@example.test', readBy: { g: { email: 'gone@example.test' } } }, uidByEmail);
    assert.equal(withAction.kind, 'unresolvable');
    assert.deepEqual(withAction.remove, [['readBy', 'g', 'email']]);
  });
});

describe('household and stats emails', () => {
  test('memberEmails and ownerEmail are removed; ownerEmail stays without an ownerUid', () => {
    assert.deepEqual(householdEmailScrubPlan({ name: 'H', ownerUid: 'o', ownerEmail: 'o@example.test', memberEmails: ['o@example.test'] }),
      { kind: 'scrub', remove: [['memberEmails'], ['ownerEmail']] });
    assert.deepEqual(householdEmailScrubPlan({ name: 'H', ownerUid: 'o' }), { kind: 'clean' });
    assert.deepEqual(householdEmailScrubPlan({ name: 'H', ownerEmail: 'o@example.test' }), { kind: 'no-owner-uid' });
    assert.deepEqual(householdEmailScrubPlan({ name: 'H', ownerEmail: 'o@example.test', memberEmails: [] }), { kind: 'scrub', remove: [['memberEmails']] });
  });

  test('stats labels that are an email are removed, counts untouched', () => {
    const data = { completed: 3, byAssignee: { 'sam-1a': 2, 'ana-2b': 1 }, names: { 'sam-1a': 'Sam', 'ana-2b': 'ana@example.test' } };
    const plan = statsEmailScrubPlan(data);
    assert.deepEqual(plan, { kind: 'scrub', remove: [['names', 'ana-2b']] });
    assert.deepEqual(applyPlan(data, plan), { completed: 3, byAssignee: { 'sam-1a': 2, 'ana-2b': 1 }, names: { 'sam-1a': 'Sam' } });
    assert.deepEqual(statsEmailScrubPlan({ names: { k: 'Sam' } }), { kind: 'clean' });
    assert.deepEqual(statsEmailScrubPlan({}), { kind: 'clean' });
  });
});
