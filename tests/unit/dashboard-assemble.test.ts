import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { assembleDashboardFacts, feedingFailureKey, type DashboardAccess, type DashboardRaw } from '../../src/lib/dashboard/assemble';
import { buildMorningBrief } from '../../src/lib/dashboard/brief';
import { FEEDING_UNAVAILABLE } from '../../src/lib/dashboard/facts';
import type { Notification } from '../../src/lib/types';

const now = new Date(2026, 7, 1, 12);
const context = { viewer: { uid: 'u1', email: 'u1@example.test' }, now, timeZone: null, recentFeedings: 12 };
const all: DashboardAccess = { chores: true, shopping: true, pantry: true, maintenance: true, pets: true, notifications: true };
const none: DashboardAccess = { chores: false, shopping: false, pantry: false, maintenance: false, pets: false, notifications: false };
const petsOnly: DashboardAccess = { ...none, pets: true };
const pets = [{ id: 'maple', name: 'Maple', type: 'Dog', feedingsPerDay: 1 }];
const fedLog = { id: 'f1', date: new Date(2026, 7, 1, 8) };

describe('assembleDashboardFacts: loading, failed and empty stay distinct', () => {
  it('makes no feeding claim until both date-shape queries have answered', () => {
    const raw: DashboardRaw = { pets, feedings: { maple: { timestamp: [fedLog] } } };
    const { facts, loading } = assembleDashboardFacts(raw, new Set(), petsOnly, context);
    assert.equal(facts.pets?.pets[0].fed, null);
    assert.equal(facts.pets?.hungry, 0);
    assert.equal(loading, true, 'still waiting for the string-shape query');
  });

  it('shows a failed feeding history as unavailable, not "not fed"', () => {
    const raw: DashboardRaw = { pets, feedings: { maple: { timestamp: [] } } };
    const { facts, loading } = assembleDashboardFacts(raw, new Set([feedingFailureKey('maple')]), petsOnly, context);
    const maple = facts.pets!.pets[0];
    assert.equal(maple.fed, null);
    assert.equal(maple.headline, FEEDING_UNAVAILABLE);
    assert.deepEqual([facts.pets!.hungry, facts.pets!.unknown], [0, 1]);
    assert.equal(loading, false);
  });

  it('judges feeding once both shapes have answered', () => {
    const raw: DashboardRaw = { pets, feedings: { maple: { timestamp: [fedLog], string: [] } } };
    const { facts, loading } = assembleDashboardFacts(raw, new Set(), petsOnly, context);
    assert.equal(facts.pets?.pets[0].fed, true);
    assert.equal(loading, false);
  });

  it('waits for every shopping list’s items instead of counting a list as empty', () => {
    const lists = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
    const partial = assembleDashboardFacts({ lists, items: { a: [{ id: 'x', name: 'Milk', status: 'needed' }] } }, new Set(), { ...none, shopping: true }, context);
    assert.equal(partial.facts.shopping, undefined);
    assert.equal(partial.loading, true);
    const complete = assembleDashboardFacts({ lists, items: { a: [{ id: 'x', name: 'Milk', status: 'needed' }], b: [] } }, new Set(), { ...none, shopping: true }, context);
    assert.equal(complete.facts.shopping?.neededItems, 1);
  });

  it('lists failed sections as unavailable with no facts, and never reports 0', () => {
    const raw: DashboardRaw = { rooms: [], templates: [], openChores: [], todayChores: [], doneToday: [], assets: [], vehicles: [] };
    const { facts, loading } = assembleDashboardFacts(raw, new Set(['chores', 'notifications', 'pantry']), { ...all, shopping: false, pets: false }, context);
    assert.equal(facts.chores, undefined);
    assert.equal(facts.notifications, undefined);
    assert.equal(facts.pantry, undefined);
    assert.deepEqual(facts.unavailable, ['chores', 'pantry', 'notifications']);
    assert.ok(facts.maintenance, 'other sections still render');
    assert.equal(loading, false);
  });

  it('waits for every chore listener (templates and today’s completions included)', () => {
    const { facts, loading } = assembleDashboardFacts({ rooms: [], openChores: [] }, new Set(), { ...none, chores: true }, context);
    assert.equal(facts.chores, undefined);
    assert.equal(loading, true);
  });

  it('counts today’s completions found by the server stamp, merged by id with the legacy query', () => {
    const base = { rooms: [{ id: 'kitchen', name: 'Kitchen' }], templates: [], openChores: [], todayChores: [] };
    const stamped = {
      id: 'k', task: 'Reset', assignedToEmail: 'u1@example.test', originalDueDate: '2026-07-31', dueDate: '2026-07-31', roomIds: ['kitchen'],
      isCompleted: true,
      // The client string says yesterday (a skewed clock); the server stamp says today.
      completedAt: '2026-07-31T10:00:00.000Z', completedAtServer: { toDate: () => new Date(2026, 7, 1, 9) },
    };
    // Not ready until the server-stamp listener has answered too.
    const waiting = assembleDashboardFacts({ ...base, doneToday: [] }, new Set(), { ...none, chores: true }, context);
    assert.equal(waiting.facts.chores, undefined);
    assert.equal(waiting.loading, true);
    const { facts } = assembleDashboardFacts({ ...base, doneToday: [], doneTodayServer: [stamped] }, new Set(), { ...none, chores: true }, context);
    assert.equal(facts.chores?.todayDone, 1);
    assert.equal(facts.chores?.rooms.find((room) => room.id === 'kitchen')?.doneToday, 1);
    // Found by both queries: counted once.
    const both = assembleDashboardFacts({ ...base, doneToday: [stamped], doneTodayServer: [stamped] }, new Set(), { ...none, chores: true }, context);
    assert.equal(both.facts.chores?.todayDone, 1);
  });

  it('ignores sections the member cannot view', () => {
    const { facts, loading } = assembleDashboardFacts({}, new Set(['chores']), none, context);
    assert.deepEqual(facts, {});
    assert.equal(loading, false);
  });

  it('never tells the brief "nothing to do" when something could not be read', () => {
    const failedPets = assembleDashboardFacts({ pets, feedings: {} }, new Set([feedingFailureKey('maple')]), petsOnly, context).facts;
    assert.equal(
      buildMorningBrief(failedPets, { greeting: 'Hi' }).text,
      'Hi. Some of your home could not be loaded right now, so there may be more to do.',
    );
    const failedChores = buildMorningBrief({ unavailable: ['chores'], pantry: { total: 1, fridgeItems: 1, expired: 1, expiringSoon: 0, nearest: [] } }, { greeting: 'Hi' });
    assert.equal(failedChores.text, 'Hi. 1 pantry item expired. Some sections could not be loaded.');
  });
});

describe('notifications: the unread count follows the clock, not the last snapshot', () => {
  afterEach(() => mock.timers.reset());

  it('drops an expired notice from the count after its expiry with no new snapshot', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-11-09T22:00:00Z') });
    const notice = (id: string, expiresAt: Date): Notification => ({
      id, householdId: 'h', category: 'general', title: id, message: 'm', createdAt: new Date('2026-11-09T08:00:00Z'),
      expiresAt, sourceType: 'test', sourceId: id, readBy: {}, dismissedBy: {},
    });
    // One snapshot only: the store keeps these documents.
    const raw: DashboardRaw = {
      notifications: [notice('soon', new Date('2026-11-10T00:30:00Z')), notice('later', new Date('2026-11-14T00:00:00Z'))],
    };
    const access: DashboardAccess = { ...none, notifications: true };
    const unreadAt = () => assembleDashboardFacts(raw, new Set(), access, { ...context, now: new Date() }).facts.notifications?.unread;

    assert.equal(unreadAt(), 2);
    mock.timers.tick(2 * 60 * 60_000 + 29 * 60_000); // 00:29 UTC: not yet expired
    assert.equal(unreadAt(), 2);
    mock.timers.tick(2 * 60_000); // 00:31 UTC: past its expiry
    assert.equal(unreadAt(), 1, 'the expired notice no longer counts');
    // And a notice older than the 7-day window drops out too, still without a snapshot.
    mock.timers.tick(7 * 86_400_000);
    assert.equal(unreadAt(), 0);
  });
});
