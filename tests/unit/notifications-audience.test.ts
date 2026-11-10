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

describe('notification queries filter categories before the cap', () => {
  test('full access needs no category filter (the existing query)', async () => {
    const { viewableNotificationCategories, categoriesKey } = await import('../../src/app/notifications/notification-query');
    for (const role of ['owner', 'admin', 'member'] as const) {
      const app = getEffectivePermissions(role, {});
      assert.equal(viewableNotificationCategories((p) => Boolean(app[p])), null, role);
    }
    assert.equal(categoriesKey(null), '*');
  });

  test('restricted members query only what they can see, always including system and general', async () => {
    const { viewableNotificationCategories } = await import('../../src/app/notifications/notification-query');
    const child = getEffectivePermissions('child', {});
    assert.deepEqual(viewableNotificationCategories((p) => Boolean(child[p])), ['chores', 'pets', 'system', 'general']);
    const guest = getEffectivePermissions('guest', {});
    assert.deepEqual(viewableNotificationCategories((p) => Boolean(guest[p])), ['chores', 'pets', 'shopping', 'maintenance', 'system', 'general']);
    const noPets = getEffectivePermissions('member', { 'pets.view': false });
    assert.deepEqual(viewableNotificationCategories((p) => Boolean(noPets[p])), ['chores', 'shopping', 'maintenance', 'automation', 'system', 'general']);
    // Within Firestore's `in` limit.
    assert.ok(viewableNotificationCategories(() => false)!.length <= 30);
  });

  test('the audience and category filters are part of the query, before the limit', async () => {
    const { initializeApp } = await import('firebase/app');
    const { collection, getFirestore } = await import('firebase/firestore');
    const { notificationWindowQuery, notificationsBySourceQuery } = await import('../../src/app/notifications/notification-query');
    const db = getFirestore(initializeApp({ projectId: 'demo-unit' }, 'notification-query-unit'));
    const ref = collection(db, 'households', 'h', 'notifications');
    // Inspect the query's internal constraints (stable in the firebase JS SDK).
    type Filter = { field: { toString(): string }; op: string; value: unknown };
    const internal = (q: unknown) => (q as { _query: { filters: Filter[]; limit: number | null } })._query;
    const shape = (filters: Filter[]) => filters.map((f) => [f.field.toString(), f.op]);
    const audienceValues = (filters: Filter[]) => {
      const value = filters.find((f) => f.field.toString() === 'audience')?.value as { arrayValue?: { values?: { stringValue?: string }[] } };
      return value?.arrayValue?.values?.map((v) => v.stringValue);
    };
    const restricted = internal(notificationWindowQuery(ref, 'uid-1', new Date(0), ['chores', 'system', 'general'], 30));
    assert.deepEqual(shape(restricted.filters), [['audience', 'array-contains-any'], ['category', 'in'], ['createdAt', '>=']]);
    assert.deepEqual(audienceValues(restricted.filters), ['uid-1', '*']);
    assert.equal(restricted.limit, 30);
    const full = internal(notificationWindowQuery(ref, 'uid-1', new Date(0), null));
    assert.deepEqual(shape(full.filters), [['audience', 'array-contains-any'], ['createdAt', '>=']]);
    assert.equal(full.limit, null);
    // Maintenance Center resolvers.
    const resolver = internal(notificationsBySourceQuery(ref, 'uid-1', ['maintenance_asset_schedule'], ['a:1', 'a-0:overdue']));
    assert.deepEqual(shape(resolver.filters), [['audience', 'array-contains-any'], ['sourceType', '=='], ['sourceId', 'in']]);
    assert.deepEqual(audienceValues(resolver.filters), ['uid-1', '*']);
    const registry = internal(notificationsBySourceQuery(ref, 'uid-1', ['maintenance_asset_schedule', 'maintenance_asset_warranty']));
    assert.deepEqual(shape(registry.filters), [['audience', 'array-contains-any'], ['sourceType', 'in']]);
  });
});
