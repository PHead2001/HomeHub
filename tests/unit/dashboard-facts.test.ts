import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeChoreFacts,
  computeMaintenanceFacts,
  computePantryFacts,
  computePetFacts,
  computeShoppingFacts,
  timeAgo,
} from '../../src/lib/dashboard/facts';
import { buildMorningBrief } from '../../src/lib/dashboard/brief';
import { maintenanceSpend, summarizeChores, topPurchasedItem, firstNameOnly } from '../../src/lib/dashboard/wrapped';
import { dayKey, daysBetween, toDateValue } from '../../src/lib/dashboard/dates';

// Local noon on 2026-08-01 (matches the E2E seed's day in any time zone).
const now = new Date(2026, 7, 1, 12, 0, 0);
const viewer = { uid: 'owner-uid', email: 'owner@example.test' };

const rooms = [
  { id: 'kitchen', name: 'Kitchen' },
  { id: 'living-room', name: 'Living Room' },
  { id: 'garage', name: 'Garage' },
];

const chores = [
  { id: 'kitchen', task: 'Reset the kitchen', assignedToEmail: viewer.email, dueDate: '2026-08-01', originalDueDate: '2026-08-01', isCompleted: false, roomIds: ['kitchen'] },
  { id: 'laundry', task: 'Fold clean laundry', assignedToEmail: 'sam@example.test', dueDate: '2026-08-01', originalDueDate: '2026-08-01', isCompleted: false, roomIds: ['living-room'] },
  { id: 'bins', task: 'Take bins to curb', assignedToEmail: 'morgan@example.test', dueDate: '2026-07-31', isCompleted: true, completedAt: '2026-07-31T20:10:00.000Z', roomIds: ['garage'] },
  { id: 'late', task: 'Clean gutters', assignedToEmail: viewer.email, dueDate: '2026-07-29', isCompleted: false, roomIds: ['garage'] },
  { id: 'nowhere', task: 'Water plants', assignedToEmail: viewer.email, dueDate: '2026-08-03', isCompleted: false },
];

describe('dashboard dates', () => {
  it('reads yyyy-MM-dd as a local day and ISO strings as instants', () => {
    assert.equal(dayKey(toDateValue('2026-08-01')!), '2026-08-01');
    assert.equal(daysBetween(toDateValue('2026-07-29')!, now), -3);
    assert.equal(toDateValue('not a date'), null);
    assert.equal(toDateValue({ toDate: () => new Date(2026, 0, 2) })!.getDate(), 2);
  });
});

describe('computeChoreFacts', () => {
  const facts = computeChoreFacts(chores, rooms, viewer, now);

  it('counts the viewer’s open, overdue and due-today chores', () => {
    assert.equal(facts.mineOpen, 3);
    assert.equal(facts.mineOverdue, 1);
    assert.equal(facts.mineDueToday, 1);
    assert.equal(facts.overdueTotal, 1);
  });

  it('tracks today’s household progress', () => {
    assert.equal(facts.todayTotal, 2);
    assert.equal(facts.todayDone, 0);
  });

  it('gives each room a status and keeps rooms sorted by name', () => {
    const byId = Object.fromEntries(facts.rooms.map((room) => [room.id, room]));
    assert.deepEqual(facts.rooms.map((room) => room.id), ['garage', 'kitchen', 'living-room', 'general']);
    assert.equal(byId.garage.status, 'overdue');
    assert.equal(byId.garage.overdue, 1);
    assert.equal(byId.kitchen.status, 'due');
    assert.equal(byId['living-room'].dueToday, 1);
    assert.equal(byId.general.upcoming, 1);
    assert.equal(byId.general.name, 'Around the house');
  });

  it('lists the soonest open chores, overdue first', () => {
    assert.equal(facts.nextUp[0].task, 'Clean gutters');
    assert.equal(facts.nextUp[0].overdue, true);
  });

  it('marks a room clear and done when today’s chore there was finished', () => {
    const done = computeChoreFacts([{ ...chores[0], isCompleted: true, completedAt: new Date(2026, 7, 1, 9).toISOString() }], rooms, viewer, now);
    const kitchen = done.rooms.find((room) => room.id === 'kitchen')!;
    assert.equal(kitchen.status, 'clear');
    assert.equal(kitchen.doneToday, 1);
    assert.equal(done.todayDone, 1);
    assert.equal(done.rooms.some((room) => room.id === 'general'), false);
  });
});

describe('shopping, pantry, maintenance and pets', () => {
  it('counts needed items and keeps the oldest three', () => {
    const facts = computeShoppingFacts(
      [{ id: 'weekly', name: 'Weekly Groceries' }, { id: 'hardware', name: 'Hardware Run' }],
      {
        weekly: [
          { id: 'milk', name: 'Whole milk', status: 'needed', createdAt: new Date(2026, 6, 31, 14) },
          { id: 'apples', name: 'Honeycrisp apples', status: 'needed', createdAt: new Date(2026, 6, 31, 15) },
          { id: 'coffee', name: 'Coffee beans', status: 'purchased' },
        ],
        hardware: [{ id: 'filters', name: 'HVAC filters', status: 'needed', createdAt: new Date(2026, 6, 29) }],
      },
    );
    assert.equal(facts.neededItems, 3);
    assert.equal(facts.activeLists, 2);
    assert.equal(facts.firstItems.length, 3);
    assert.deepEqual(facts.lists.map((list) => list.needed), [1, 2]);
  });

  it('finds what expires soon', () => {
    const facts = computePantryFacts([
      { id: 'yogurt', name: 'Greek yogurt', location: 'Fridge', expiryDate: '2026-08-04' },
      { id: 'rice', name: 'Rice', location: 'Pantry', expiryDate: '2027-02-01' },
      { id: 'old', name: 'Old milk', location: 'Fridge', expiryDate: '2026-07-20' },
    ], now);
    assert.equal(facts.expiringSoon, 1);
    assert.equal(facts.expired, 1);
    assert.equal(facts.fridgeItems, 2);
    assert.equal(facts.nearest[0].label, 'expires in 3 days');
  });

  it('never calls a warranty overdue and flags HVAC and vehicle service', () => {
    const facts = computeMaintenanceFacts(
      [{
        id: 'hvac', name: 'Main HVAC System', category: 'HVAC', status: 'needs_attention', warrantyExpiration: '2026-07-01',
        schedules: [{ scheduleName: 'Replace air filter', nextDueDate: '2026-08-01' }],
      }],
      [{
        id: 'suv', nickname: 'Family SUV', currentMileage: 48750, status: 'active', inspectionExpiration: '2026-08-05',
        serviceSchedules: [{ serviceName: 'Tire rotation', nextDueMileage: 49000, nextDueDate: '2026-08-15' }],
      }],
      now,
    );
    assert.equal(facts.items.some((item) => /warranty/.test(item.label)), false, 'expired warranty is not a due item');
    assert.equal(facts.climateDue, true);
    assert.equal(facts.vehicleDue, true);
    assert.equal(facts.next?.label, 'Replace air filter');
    assert.equal(facts.next?.days, 0);
    assert.equal(facts.overdue, 0);
    assert.equal(facts.needsAttention, 1);
  });

  it('treats a pet as fed within 12 hours', () => {
    const facts = computePetFacts(
      [{ id: 'maple', name: 'Maple', type: 'Dog' }, { id: 'pixel', name: 'Pixel', type: 'Cat' }],
      { maple: new Date(now.getTime() - 2 * 3_600_000), pixel: new Date(now.getTime() - 20 * 3_600_000) },
      now,
    );
    assert.deepEqual(facts.pets.map((pet) => [pet.name, pet.fed]), [['Maple', true], ['Pixel', false]]);
    assert.equal(facts.hungry, 1);
    assert.equal(timeAgo(facts.pets[0].lastFedAt!, now), '2h ago');
  });
});

describe('buildMorningBrief', () => {
  it('builds one sentence from exact counts with links', () => {
    const facts = {
      chores: computeChoreFacts(chores, rooms, viewer, now),
      pets: computePetFacts([{ id: 'pixel', name: 'Pixel', type: 'Cat' }], {}, now),
      pantry: computePantryFacts([{ id: 'milk', name: 'Milk', location: 'Fridge', expiryDate: '2026-08-02' }], now),
    };
    const brief = buildMorningBrief(facts, { greeting: 'Good morning', name: 'Alex Owner' });
    assert.equal(brief.text, "Good morning, Alex. 1 chore today (1 overdue), Pixel's next meal is due, and the milk expires tomorrow.");
    assert.deepEqual(brief.segments.filter((segment) => segment.href).map((segment) => segment.href), ['/chores', '/pets/pixel', '/shopping']);
  });

  it('has a calm line when nothing needs attention', () => {
    const brief = buildMorningBrief({}, { greeting: 'Good evening' });
    assert.equal(brief.text, 'Good evening. Nothing needs you right now. Enjoy the quiet.');
  });
});

describe('Home Wrapped aggregation', () => {
  it('counts chores in the year and names the champion by first name only', () => {
    const summary = summarizeChores([
      { id: '1', isCompleted: true, completedAt: '2026-03-01T10:00:00Z', assignedToDisplayName: 'Sam Member' },
      { id: '2', isCompleted: true, completedAt: '2026-04-01T10:00:00Z', assignedToDisplayName: 'Sam Member' },
      { id: '3', isCompleted: true, completedAt: '2026-04-01T10:00:00Z', assignedToEmail: 'morgan.admin@example.test' },
      { id: '4', isCompleted: true, completedAt: '2025-12-30T10:00:00Z', assignedToDisplayName: 'Old Year' },
    ], 2026);
    assert.equal(summary.choresDone, 3);
    assert.deepEqual(summary.champion, { name: 'Sam', count: 2 });
    assert.equal(firstNameOnly('morgan.admin@example.test'), 'Morgan');
  });

  it('merges purchased items case-insensitively and sums upkeep spend', () => {
    assert.deepEqual(topPurchasedItem([
      { id: 'a', name: 'Milk', status: 'purchased', quantity: 2 },
      { id: 'b', name: 'milk', status: 'purchased' },
      { id: 'c', name: 'Eggs', status: 'purchased', quantity: 2 },
      { id: 'd', name: 'Bread', status: 'needed', quantity: 9 },
    ]), { name: 'Milk', count: 3 });
    assert.deepEqual(maintenanceSpend([
      { id: '1', date: '2026-02-01', cost: 120.5 },
      { id: '2', date: '2026-05-01', cost: 'n/a' },
      { id: '3', date: '2025-05-01', cost: 900 },
    ], 2026), { spend: 120.5, logs: 2 });
  });
});
