import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  canSeeCategory,
  categoryViewPermission,
  filterRecipientsByCategory,
  memberCanView,
} from '../../functions/src/shared/push-audience';
import { activeBellNotifications } from '../../src/lib/dashboard/notification-display';
import { getEffectivePermissions } from '../../src/lib/permissions';
import type { Notification } from '../../src/lib/types';

const members = [
  { email: 'owner@example.test', role: 'owner', permissions: { 'pets.view': false } },
  { email: 'kid@example.test', role: 'child' },
  { email: 'nopets@example.test', role: 'member', permissions: { 'pets.view': false } },
  { email: 'granted@example.test', role: 'child', permissions: { 'shopping.view': true } },
  { email: 'guest@example.test', role: 'guest' },
];
const everyone = members.map((m) => m.email);

describe('push recipients by category', () => {
  test('a member without pets.view gets no pets push; the owner always does', () => {
    assert.deepEqual(filterRecipientsByCategory(members, everyone, 'pets'),
      ['owner@example.test', 'kid@example.test', 'granted@example.test', 'guest@example.test']);
  });

  test('an override that grants the permission includes the member', () => {
    assert.deepEqual(filterRecipientsByCategory(members, everyone, 'shopping'),
      ['owner@example.test', 'nopets@example.test', 'granted@example.test', 'guest@example.test']);
  });

  test('module categories need their view permission; system and general need none', () => {
    assert.deepEqual(filterRecipientsByCategory(members, everyone, 'maintenance'),
      ['owner@example.test', 'nopets@example.test', 'guest@example.test']);
    assert.deepEqual(filterRecipientsByCategory(members, everyone, 'automation'),
      ['owner@example.test', 'nopets@example.test']);
    assert.deepEqual(filterRecipientsByCategory(members, everyone, 'chores'), everyone);
    assert.deepEqual(filterRecipientsByCategory(members, everyone, 'system'), everyone);
    assert.deepEqual(filterRecipientsByCategory(members, everyone, undefined), everyone);
  });

  test('recipients without a membership record are dropped for module categories', () => {
    assert.deepEqual(filterRecipientsByCategory(members, ['stranger@example.test'], 'pets'), []);
  });

  test('the server mirror agrees with the app’s effective permissions for every role', () => {
    for (const role of ['owner', 'admin', 'member', 'child', 'guest'] as const) {
      const app = getEffectivePermissions(role, {});
      for (const category of ['chores', 'pets', 'shopping', 'maintenance', 'automation']) {
        const permission = categoryViewPermission(category)!;
        assert.equal(memberCanView({ role }, permission), Boolean(app[permission]), `${role} ${permission}`);
      }
    }
  });
});

describe('bell list matches the push audience', () => {
  const note = (id: string, category: Notification['category']): Notification => ({
    id, householdId: 'h', category, title: id, message: id,
    createdAt: new Date('2026-11-06T10:00:00Z'), expiresAt: new Date('2026-11-13T10:00:00Z'),
    readBy: {}, dismissedBy: {},
  } as Notification);
  const notes = [note('pet', 'pets'), note('sys', 'system'), note('shop', 'shopping')];
  const now = new Date('2026-11-06T12:00:00Z');

  test('without pets.view the pets notification is hidden', () => {
    const app = getEffectivePermissions('member', { 'pets.view': false });
    const user = { uid: 'u', email: 'u@example.test', canView: (p: keyof typeof app) => Boolean(app[p]) };
    assert.deepEqual(activeBellNotifications(notes, user, now).map((n) => n.id), ['sys', 'shop']);
    assert.equal(canSeeCategory('pets', user.canView), false);
  });

  test('callers that pass no permission check keep the old behavior', () => {
    assert.equal(activeBellNotifications(notes, { uid: 'u', email: 'u@example.test' }, now).length, 3);
  });
});
