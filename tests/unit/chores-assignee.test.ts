import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  assigneeFields,
  isAssignedTo,
  occurrenceAssigneeKey,
  resolveAssigneeUid,
  unassignedChoreFields,
} from '../../functions/src/shared/assignee';
import { choreNotificationsFor } from '../../functions/src/shared/chore-reminders';
import { addPurgedChores } from '../../functions/src/shared/chore-stats';
import { recurringChoreId } from '../../functions/src/shared/ids';
import { assigneeBackfillDecision, memberUidsByEmail, resolveAssigneeUidJs } from '../../scripts/ops/chore-assignee.mjs';
import { occurrenceIds } from '../../src/lib/chores/calendar';
import { computeChoreStats } from '../../src/lib/chores/stats';
import type { ChoreRecord } from '../../src/lib/chores/dates';
import {
  approvedPeople,
  canSeeMemberEmails,
  memberProfileDiffers,
  pendingHouseholdView,
  personFromMemberRecord,
  publicDisplayName,
} from '../../src/lib/member-directory';
import { buildNotificationDocument, createNotificationAction } from '../../src/lib/notifications';

const people = [
  { uid: 'uid-ana', email: 'Ana@Example.test' },
  { uid: 'uid-sam', email: 'sam@example.test' },
];
// Once emails are no longer readable by everyone, readers only know uids.
const uidOnly = people.map(({ uid }) => ({ uid }));

const cases: Array<[string, Record<string, unknown>]> = [
  ['email only (older record)', { assignedToEmail: 'sam@example.test' }],
  ['email in another case', { assignedToEmail: 'ANA@example.test' }],
  ['uid and email agree', { assignedToUid: 'uid-sam', assignedToEmail: 'sam@example.test' }],
  ['older build reassigned by email', { assignedToUid: 'uid-ana', assignedToEmail: 'sam@example.test' }],
  ['uid, email unknown to the writer', { assignedToUid: 'uid-sam', assignedToEmail: '' }],
  ['uid of a former member', { assignedToUid: 'uid-gone', assignedToEmail: '' }],
  ['email of a former member', { assignedToEmail: 'gone@example.test' }],
  ['former email, current uid', { assignedToUid: 'uid-ana', assignedToEmail: 'gone@example.test' }],
  ['unassigned', { assignedToEmail: '', assignedToDisplayName: 'Unassigned' }],
  ['unassigned by the server', { assignedToUid: '', assignedToEmail: '' }],
  ['template: email only in recurrence', { recurrence: { frequency: 'daily', assignedToEmail: 'ana@example.test' } }],
  ['template: stopped by an older build', { assignedToUid: 'uid-sam', assignedToEmail: null, recurrence: null }],
  ['not strings', { assignedToUid: 7, assignedToEmail: { x: 1 } }],
];

describe('chore assignee (uid with email fallback)', () => {
  test('resolves each record shape', () => {
    const resolved = Object.fromEntries(cases.map(([name, record]) => [name, resolveAssigneeUid(record, people)]));
    assert.deepEqual(resolved, {
      'email only (older record)': 'uid-sam',
      'email in another case': 'uid-ana',
      'uid and email agree': 'uid-sam',
      'older build reassigned by email': 'uid-sam',
      'uid, email unknown to the writer': 'uid-sam',
      'uid of a former member': null,
      'email of a former member': null,
      'former email, current uid': null,
      unassigned: null,
      'unassigned by the server': null,
      'template: email only in recurrence': 'uid-ana',
      'template: stopped by an older build': 'uid-sam',
      'not strings': null,
    });
  });

  test('a stale uid never wins over the stored email', () => {
    // Alice's chore reassigned to Bob by an older build: email Bob, uid still Alice's.
    const alice = { uid: 'uid-alice', email: 'alice@example.test' };
    const bob = { uid: 'uid-bob', email: 'bob@example.test' };
    const moved = { assignedToUid: 'uid-alice', assignedToEmail: 'bob@example.test' };
    // Stale uid + current member email: Bob's.
    assert.equal(resolveAssigneeUid(moved, [alice, bob]), 'uid-bob');
    assert.equal(isAssignedTo(moved, alice), false);
    assert.equal(isAssignedTo(moved, bob), true);
    // Stale uid + departed member email: nobody's, never Alice's.
    assert.equal(resolveAssigneeUid(moved, [alice]), null);
    assert.equal(resolveAssigneeUidJs(moved, [alice]), null);
    assert.equal(isAssignedTo(moved, alice), false);
    const done = { id: 'd', task: 'd', dueDate: '2026-11-09', originalDueDate: '2026-11-09', isCompleted: true, completedAt: '2026-11-09T09:00:00Z', ...moved } as unknown as ChoreRecord;
    const stats = computeChoreStats([done], [{ uid: alice.uid, name: 'Alice', email: alice.email }], new Date('2026-11-09T20:00:00Z'));
    assert.equal(stats.members[0].weekCompleted, 0, "Bob's completed work never becomes Alice's points");
    // Uid only (legacy email missing): the uid decides.
    for (const record of [{ assignedToUid: 'uid-alice' }, { assignedToUid: 'uid-alice', assignedToEmail: '' }, { assignedToUid: 'uid-alice', assignedToEmail: null }]) {
      assert.equal(resolveAssigneeUid(record, [alice, bob]), 'uid-alice');
      assert.equal(isAssignedTo(record, alice), true);
    }
    // Matching pair, in any case.
    const pair = { assignedToUid: 'uid-alice', assignedToEmail: 'Alice@Example.test' };
    assert.equal(resolveAssigneeUid(pair, [alice, bob]), 'uid-alice');
    assert.equal(isAssignedTo(pair, alice), true);
    assert.equal(isAssignedTo(pair, bob), false);
    // A reader who cannot see the uid's member email keeps the uid.
    assert.equal(resolveAssigneeUid(moved, [{ uid: 'uid-alice' }]), 'uid-alice');
  });

  test('without readable emails, the uid decides', () => {
    assert.equal(resolveAssigneeUid({ assignedToUid: 'uid-sam', assignedToEmail: 'sam@example.test' }, uidOnly), 'uid-sam');
    assert.equal(resolveAssigneeUid({ assignedToEmail: 'sam@example.test' }, uidOnly), null, 'needs the backfill');
  });

  test('isAssignedTo agrees with resolveAssigneeUid for current members', () => {
    for (const [name, record] of cases) {
      for (const person of people) {
        const expected = resolveAssigneeUid(record, people) === person.uid;
        assert.equal(isAssignedTo(record, person), expected, `${name} / ${person.uid}`);
      }
    }
    // A person who knows only their own email: an email naming someone else wins over a stale uid.
    assert.equal(isAssignedTo({ assignedToUid: 'uid-ana', assignedToEmail: 'sam@example.test' }, people[0]), false);
    assert.equal(isAssignedTo({ assignedToUid: 'uid-ana', assignedToEmail: '' }, { uid: 'uid-ana' }), true);
  });

  test('writers dual-write, and unassigning clears both', () => {
    assert.deepEqual(assigneeFields({ uid: 'uid-sam', email: ' sam@example.test ' }), { assignedToUid: 'uid-sam', assignedToEmail: 'sam@example.test' });
    assert.deepEqual(assigneeFields({ uid: 'uid-sam' }), { assignedToUid: 'uid-sam', assignedToEmail: '' });
    const unassigned = unassignedChoreFields();
    assert.deepEqual(unassigned, { assignedToUid: '', assignedToEmail: '', assignedToDisplayName: 'Unassigned' });
    assert.equal(resolveAssigneeUid(unassigned, people), null);
  });

  test('occurrence ids keep the key each template was generated with', () => {
    assert.equal(occurrenceAssigneeKey({ assignedToUid: 'uid-sam', assignedToEmail: 'Sam@example.test' }), 'Sam@example.test');
    assert.equal(occurrenceAssigneeKey({ recurrence: { assignedToEmail: 'ana@example.test' } }), 'ana@example.test');
    assert.equal(occurrenceAssigneeKey({ assignedToUid: 'uid-sam', assignedToEmail: '' }), 'uid-sam');
    assert.equal(occurrenceAssigneeKey({}), '');
    // Same ids as before the uid existed, for a template with an email.
    assert.deepEqual(occurrenceIds({ id: 't1', roomIds: ['kitchen'] }, '2026-11-09', 'sam@example.test'),
      [recurringChoreId('t1', 'kitchen', '2026-11-09', 'sam@example.test')]);
  });

  test('the backfill script decides like the shared helper', () => {
    const byEmail = memberUidsByEmail(people);
    for (const [name, record] of cases) {
      assert.equal(resolveAssigneeUidJs(record, people), resolveAssigneeUid(record, people), name);
    }
    const decisions = Object.fromEntries(cases.map(([name, record]) => [name, assigneeBackfillDecision(record, byEmail)]));
    assert.deepEqual(decisions['email only (older record)'], { kind: 'missing', assignedToUid: 'uid-sam' });
    assert.deepEqual(decisions['email in another case'], { kind: 'missing', assignedToUid: 'uid-ana' });
    assert.deepEqual(decisions['uid and email agree'], { kind: 'present' });
    assert.deepEqual(decisions['older build reassigned by email'], { kind: 'mismatch', assignedToUid: 'uid-sam' });
    assert.deepEqual(decisions['uid, email unknown to the writer'], { kind: 'present' });
    assert.deepEqual(decisions['email of a former member'], { kind: 'former' });
    assert.deepEqual(decisions.unassigned, { kind: 'unassigned' });
    assert.deepEqual(decisions['former email, current uid'], { kind: 'stale', assignedToUid: '' });
    assert.deepEqual(decisions['uid of a former member'], { kind: 'present' });
    assert.deepEqual(decisions['template: email only in recurrence'], { kind: 'missing', assignedToUid: 'uid-ana' });
    // Every write the backfill makes matches what readers already resolve.
    for (const [name, record] of cases) {
      const decision = assigneeBackfillDecision(record, byEmail);
      if (decision.kind === 'missing' || decision.kind === 'mismatch') {
        assert.equal(decision.assignedToUid, resolveAssigneeUid(record, people), name);
      }
      if (decision.kind === 'stale') assert.equal(resolveAssigneeUid(record, people), null, name);
    }
  });

  test('chore reminders find chores by uid or email, and target by uid only', () => {
    const person = { uid: 'uid-sam', email: 'sam@example.test', timeZone: 'UTC', reminderEnabled: true, reminderTime: '08:00' };
    const chores = [
      { id: 'a', task: 'Old', assignedToEmail: 'sam@example.test', originalDueDate: '2026-11-09' },
      { id: 'b', task: 'New', assignedToUid: 'uid-sam', assignedToEmail: '', originalDueDate: '2026-11-09' },
      { id: 'c', task: 'Moved away', assignedToUid: 'uid-sam', assignedToEmail: 'ana@example.test', originalDueDate: '2026-11-09' },
    ];
    const notes = choreNotificationsFor(person, chores, new Date('2026-11-09T09:00:00Z'));
    assert.equal(notes.length, 1);
    assert.equal(notes[0].message, '2 chores due today.');
    assert.equal('targetUserEmail' in notes[0], false);
  });

  test('chore stats count by uid, older chores by email', () => {
    const chore = (id: string, fields: Record<string, unknown>) => ({
      id, task: id, dueDate: '2026-11-09', originalDueDate: '2026-11-09', isCompleted: true, completedAt: '2026-11-09T09:00:00Z', ...fields,
    }) as unknown as ChoreRecord;
    const stats = computeChoreStats([
      chore('a', { assignedToEmail: 'sam@example.test' }),
      chore('b', { assignedToUid: 'uid-sam', assignedToEmail: '' }),
      chore('c', { assignedToUid: 'uid-gone', assignedToEmail: '' }),
    ], [{ uid: 'uid-sam', name: 'Sam', email: 'sam@example.test' }], new Date('2026-11-09T20:00:00Z'));
    assert.equal(stats.members[0].weekCompleted, 2);
    assert.equal('email' in stats.members[0], false);
  });

  test('yearly stats never store an email as a name', () => {
    const next = addPurgedChores({ year: 2026, completed: 0, byAssignee: {}, names: {} }, [
      { assignedToEmail: 'sam@example.test', completedAt: '2026-01-01T00:00:00Z' },
      { assignedToEmail: 'ana@example.test', assignedToDisplayName: 'ana@example.test', completedAt: '2026-01-01T00:00:00Z' },
    ]);
    assert.equal(next.completed, 2);
    assert.deepEqual(next.names, {});
  });
});

describe('public member data', () => {
  test('display names are never emails', () => {
    assert.equal(publicDisplayName('  Sam Member '), 'Sam Member');
    assert.equal(publicDisplayName('sam@example.test'), 'Member');
    assert.equal(publicDisplayName('Sam <sam@example.test>'), 'Member');
    assert.equal(publicDisplayName(''), 'Member');
    assert.equal(publicDisplayName(undefined, 'Unassigned'), 'Unassigned');
    assert.equal(publicDisplayName('x'.repeat(100)).length, 80);
  });

  test('member records become public people; only approved, active ones are listed', () => {
    assert.deepEqual(personFromMemberRecord({ uid: 'u1', email: 'a@x.test', displayName: 'a@x.test', role: 'member', joinedAt: '2026-01-01' }), {
      uid: 'u1', displayName: 'Member', avatarUrl: null, role: 'member', status: 'active', joinedAt: '2026-01-01', email: 'a@x.test',
    });
    assert.equal(personFromMemberRecord({}), null);
    const listed = approvedPeople([
      { id: 'a', data: { displayName: 'Ana', role: 'owner' } },
      { id: 'p', data: { displayName: 'Pending', role: 'newuser', status: 'pending' } },
      { id: 'r', data: { displayName: 'Removed', role: 'member', status: 'removed' } },
      { id: 'd', data: { displayName: 'Deleting', role: 'member', status: 'deleting' } },
      { id: 'l', data: { displayName: 'Legacy', role: 'super-admin' } },
    ]);
    assert.deepEqual(listed.map((person) => person.uid), ['a']);
  });

  test('only member managers may see other people\'s emails', () => {
    assert.equal(canSeeMemberEmails({ 'household.manageMembers': true }), true);
    assert.equal(canSeeMemberEmails({ 'household.manageMembers': false, 'chores.view': true }), false);
    assert.equal(canSeeMemberEmails(null), false);
  });

  test('a pending person sees the household name from their own record', () => {
    assert.deepEqual(pendingHouseholdView('h1', { role: 'newuser', status: 'pending', householdName: ' Maple House ' }), { id: 'h1', name: 'Maple House' });
    assert.equal(pendingHouseholdView('h1', { role: 'newuser', status: 'pending' }), null, 'older record: read the household');
    assert.equal(pendingHouseholdView('h1', { role: 'member', status: 'active', householdName: 'Maple House' }), null);
  });

  test('profile drift is detected on name and photo only', () => {
    const photo = 'https://firebasestorage.googleapis.com/v0/b/x/o/a.png';
    assert.equal(memberProfileDiffers({ displayName: 'Sam', avatarUrl: photo }, { displayName: 'Sam', avatarUrl: photo }), false);
    assert.equal(memberProfileDiffers({ displayName: 'Sam' }, { displayName: 'Samuel', avatarUrl: null }), true);
    assert.equal(memberProfileDiffers({ displayName: 'Sam', avatarUrl: null }, { displayName: 'Sam', avatarUrl: photo }), true);
    // An email-like profile name is never copied, so it is not drift either.
    assert.equal(memberProfileDiffers({}, { displayName: 'sam@example.test', avatarUrl: null }), false);
  });
});

describe('notifications without emails', () => {
  test('action entries hold the uid and name only', () => {
    const action = createNotificationAction({ uid: 'uid-sam', displayName: 'Sam' });
    assert.equal(action.uid, 'uid-sam');
    assert.equal(action.displayName, 'Sam');
    assert.equal('email' in action, false);
  });

  test('targeted notifications name the target by uid only', () => {
    const document = buildNotificationDocument({
      householdId: 'h1', category: 'chores', message: 'You have a new chore.', targetUser: { uid: 'uid-sam', email: 'sam@example.test' } as { uid: string },
    });
    assert.equal(document.targetUserUid, 'uid-sam');
    assert.equal('targetUserEmail' in document, false);
  });
});
