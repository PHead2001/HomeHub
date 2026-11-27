import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  JOIN_REQUEST_SOURCE_TYPE,
  MEMBER_APPROVED_SOURCE_TYPE,
  MEMBER_ROLE_CHANGED_SOURCE_TYPE,
  isOpenPendingNotice,
  memberNoticeId,
  memberRoleNotice,
  pendingReminderNoticeId,
} from '../../src/lib/household-notices';
import { PENDING_REMINDER_SOURCE_TYPE } from '../../src/lib/household-records';

describe('membership notices (HO-1, HO-7, HO-28)', () => {
  test('approval tells the person they are in, with their role and the household', () => {
    const notice = memberRoleNotice({ approved: true, role: 'member', previousRole: 'newuser', householdName: 'The Foxes' });
    assert.equal(notice.title, "You're in");
    assert.equal(notice.message, 'You joined The Foxes as Member.');
    assert.equal(notice.sourceType, MEMBER_APPROVED_SOURCE_TYPE);
    assert.equal(notice.deepLink, '/');
  });

  test('a role change names the old and new role, never "Pending"', () => {
    const notice = memberRoleNotice({ approved: false, role: 'admin', previousRole: 'member', householdName: 'The Foxes' });
    assert.equal(notice.title, 'Your role changed');
    assert.equal(notice.message, 'Your role in The Foxes changed from Member to Admin.');
    assert.equal(notice.sourceType, MEMBER_ROLE_CHANGED_SOURCE_TYPE);
    const fromPending = memberRoleNotice({ approved: false, role: 'guest', previousRole: 'newuser', householdName: '' });
    assert.equal(fromPending.message, 'Your role in the household changed to Guest.');
  });

  test('ids: one per change and recipient, stable for a retry; reminders one per person, recipient and day', () => {
    const at = new Date('2026-08-01T12:00:00.000Z');
    assert.equal(memberNoticeId(MEMBER_APPROVED_SOURCE_TYPE, 'u1', at), `${MEMBER_APPROVED_SOURCE_TYPE}-u1-${at.getTime()}`);
    const a = pendingReminderNoticeId('p1', 'owner', 'pending|2026-08-01');
    assert.equal(a, pendingReminderNoticeId('p1', 'owner', 'pending|2026-08-01'));
    assert.notEqual(a, pendingReminderNoticeId('p1', 'admin', 'pending|2026-08-01'));
    assert.notEqual(a, pendingReminderNoticeId('p1', 'owner', 'pending|2026-08-02'));
    assert.ok(!a.includes('/') && !a.includes('|'));
  });

  test('only open join-request and reminder notices are resolved', () => {
    assert.equal(isOpenPendingNotice({ sourceType: JOIN_REQUEST_SOURCE_TYPE }), true);
    assert.equal(isOpenPendingNotice({ sourceType: PENDING_REMINDER_SOURCE_TYPE }), true);
    assert.equal(isOpenPendingNotice({ sourceType: JOIN_REQUEST_SOURCE_TYPE, resolvedAt: new Date() }), false);
    assert.equal(isOpenPendingNotice({ sourceType: 'household-member-left' }), false);
    assert.equal(isOpenPendingNotice(undefined), false);
  });
});
