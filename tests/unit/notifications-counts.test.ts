import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BELL_LIMIT, activeBellNotifications, activeNotifications, unreadBellCount, unreadCount } from '../../src/lib/dashboard/notification-display';
import { assignmentNotificationId, buildNotificationDocument, notificationSince, parseNotificationDoc } from '../../src/lib/notifications';
import { pushTtlSeconds } from '../../functions/src/shared/push-hold';
import type { Notification } from '../../src/lib/types';

// Section 7 "correct counts": NO-7 (one count everywhere, Dismiss all covers everything)
// and the NO-11 list (age after a refresh, fixed assignment IDs, the creator, push TTL).
const NOW = new Date('2026-11-12T18:00:00Z');
const user = { uid: 'u1', email: 'u1@example.test' };
const note = (id: string, fields: Partial<Notification> = {}): Notification => ({
  id, householdId: 'h', category: 'general', message: id, createdAt: new Date(NOW.getTime() - Number(id.replace(/\D/g, '') || 0) * 60_000),
  expiresAt: new Date(NOW.getTime() + 86_400_000), audience: ['*'], readBy: {}, dismissedBy: {}, ...fields,
});

describe('NO-7: counts agree', () => {
  const many = Array.from({ length: 14 }, (_, i) => note(`n${i + 1}`));

  test('the bell lists 10, but counts and dismisses every active notification', () => {
    assert.equal(activeBellNotifications(many, user, NOW).length, BELL_LIMIT);
    const active = activeNotifications(many, user, NOW);
    assert.equal(active.length, 14);
    assert.equal(unreadCount(active, 'u1'), 14, 'counted before the cap, so the badge says 9+ only when there are');
    assert.equal(unreadBellCount(many, user, NOW), 14, 'the dashboard tile says the same');
  });

  test('resolved notifications are not active and not unread', () => {
    const list = [note('n1'), note('n2', { resolvedAt: NOW }), note('n3', { readBy: { u1: { at: NOW } } })];
    const active = activeNotifications(list, user, NOW);
    assert.deepEqual(active.map((n) => n.id), ['n1', 'n3']);
    assert.equal(unreadCount(active, 'u1'), 1);
  });
});

describe('NO-11: smaller bugs', () => {
  const snapshot = (data: Record<string, unknown>) => ({ id: 'x', data: () => data }) as never;

  test('a refreshed reminder keeps the age of its first appearance', () => {
    const first = new Date('2026-10-20T12:00:00Z');
    const parsed = parseNotificationDoc(snapshot({ message: 'm', createdAt: NOW, firstCreatedAt: first }));
    assert.equal(notificationSince(parsed).toISOString(), first.toISOString());
    const plain = parseNotificationDoc(snapshot({ message: 'm', createdAt: NOW }));
    assert.equal(notificationSince(plain).toISOString(), NOW.toISOString());
    assert.equal('firstCreatedAt' in plain, false);
  });

  test('chore-assignment notifications have a fixed ID per source and recipient', () => {
    assert.equal(assignmentNotificationId('tpl-1', 'u2'), assignmentNotificationId('tpl-1', 'u2'));
    assert.notEqual(assignmentNotificationId('tpl-1', 'u2'), assignmentNotificationId('tpl-1', 'u3'));
    assert.match(assignmentNotificationId('a,b,c', 'u2'), /^chore-assignment-[0-9a-z]+$/);
  });

  test('the member who caused a notification is recorded, so the push skips them', () => {
    const doc = buildNotificationDocument({ householdId: 'h', category: 'chores', message: 'm', targetUser: { uid: 'u2' }, createdBy: { uid: 'u1' } });
    assert.equal(doc.createdByUid, 'u1');
    assert.equal('createdByUid' in buildNotificationDocument({ householdId: 'h', category: 'chores', message: 'm' }), false);
  });

  test('push TTL: a day-based reminder lives until the household midnight, anything else a day', () => {
    // 12:00 in Chicago (UTC-6): 12 hours to midnight.
    assert.equal(pushTtlSeconds(true, NOW, 'America/Chicago'), 12 * 3600);
    assert.equal(pushTtlSeconds(false, NOW, 'America/Chicago'), 86400);
    // 23:30: at least an hour.
    assert.equal(pushTtlSeconds(true, new Date('2026-11-13T05:30:00Z'), 'America/Chicago'), 3600);
  });
});
