import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deduplicateNotifications } from '../../src/lib/notifications';
import type { Notification } from '../../src/lib/types';

const note = (id: string, overrides: Partial<Notification> = {}): Notification => ({
  id,
  householdId: 'h',
  category: 'system',
  title: 'New member needs approval',
  message: 'Sam joined with an invite code.',
  createdAt: new Date('2026-08-01T12:00:00Z'),
  expiresAt: new Date('2026-08-08T12:00:00Z'),
  readBy: {},
  dismissedBy: {},
  sourceType: 'household-newuser',
  sourceId: 'sam',
  ...overrides,
} as Notification);

describe('notification de-duplication', () => {
  test('per-recipient copies of one event stay separate', () => {
    const result = deduplicateNotifications([
      note('a', { targetUserUid: 'owner' }),
      note('b', { targetUserUid: 'admin' }),
    ]);
    assert.deepEqual(result.map(n => n.targetUserUid).sort(), ['admin', 'owner']);
  });

  test('true duplicates for the same recipient still merge', () => {
    const result = deduplicateNotifications([
      note('a', { targetUserUid: 'owner', readBy: { owner: true } as never }),
      note('b', { targetUserUid: 'owner', createdAt: new Date('2026-08-02T12:00:00Z') }),
      note('c'),
      note('d'),
    ]);
    assert.equal(result.length, 2);
    assert.ok(result.some(n => n.targetUserUid === 'owner' && (n.readBy as Record<string, unknown>).owner));
  });
});
