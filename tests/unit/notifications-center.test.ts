import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isHouseholdWide, matchesNotificationFilter, notificationFilterOptions } from '../../src/lib/dashboard/notification-display';
import type { Notification } from '../../src/lib/types';

// NO-13 (Household filter), NO-18 (chips from what the member can see), NO-7 (Unread).
const NOW = new Date('2026-11-12T18:00:00Z');
const note = (fields: Partial<Notification> = {}): Notification => ({
  id: 'n', householdId: 'h', category: 'general', message: 'm', createdAt: NOW, expiresAt: NOW,
  audience: ['*'], readBy: {}, dismissedBy: {}, ...fields,
});

describe('center filters', () => {
  test('a child sees no Shopping, Maintenance or Automation chip; everyone gets Household', () => {
    const child = new Set(['chores.view', 'pets.view']);
    const values = notificationFilterOptions((p) => child.has(p)).map((o) => o.value);
    assert.deepEqual(values, ['unread', 'all', 'household', 'dismissed', 'chores', 'pets']);
    const all = notificationFilterOptions(() => true).map((o) => o.value);
    assert.deepEqual(all, ['unread', 'all', 'household', 'dismissed', 'chores', 'pets', 'shopping', 'maintenance', 'automation']);
  });

  test('Household is what is addressed to everyone', () => {
    assert.equal(isHouseholdWide(note()), true);
    assert.equal(isHouseholdWide(note({ audience: ['u1'], targetUserUid: 'u1' })), false);
    assert.equal(isHouseholdWide(note({ audience: undefined })), true, 'a legacy untargeted document');
    assert.equal(isHouseholdWide(note({ audience: undefined, targetUserUid: 'u1' })), false);
    assert.equal(matchesNotificationFilter(note(), 'household', 'u1'), true);
    assert.equal(matchesNotificationFilter(note({ audience: ['u1'] }), 'household', 'u1'), false);
  });

  test('Unread leaves out read, dismissed and resolved notifications', () => {
    assert.equal(matchesNotificationFilter(note(), 'unread', 'u1'), true);
    assert.equal(matchesNotificationFilter(note({ resolvedAt: NOW }), 'unread', 'u1'), false);
    assert.equal(matchesNotificationFilter(note({ readBy: { u1: { at: NOW } } }), 'unread', 'u1'), false);
    assert.equal(matchesNotificationFilter(note({ dismissedBy: { u1: { at: NOW } } }), 'unread', 'u1'), false);
    assert.equal(matchesNotificationFilter(note({ dismissedBy: { u1: { at: NOW } } }), 'dismissed', 'u1'), true);
    assert.equal(matchesNotificationFilter(note({ category: 'pets' }), 'pets', 'u1'), true);
    assert.equal(matchesNotificationFilter(note({ category: 'pets' }), 'chores', 'u1'), false);
  });
});
