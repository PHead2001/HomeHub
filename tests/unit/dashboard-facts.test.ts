import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeChoreFacts,
  computeMaintenanceFacts,
  computePantryFacts,
  computePetFacts,
  computeShoppingFacts,
  recurringTemplateIdsFrom,
} from '../../src/lib/dashboard/facts';

const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
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
      localZone,
    );
    assert.equal(facts.items.some((item) => /warranty/.test(item.label)), false, 'expired warranty is not a due item');
    assert.equal(facts.climateDue, true);
    assert.equal(facts.vehicleDue, true);
    assert.equal(facts.next?.label, 'Replace air filter');
    assert.equal(facts.next?.days, 0);
    assert.equal(facts.overdue, 0);
    assert.equal(facts.needsAttention, 1);
    assert.equal(facts.next?.href, '/maintenance?asset=hvac&schedule=hvac%3Alegacy-0-replace-air-filter');
  });

  it('keeps the mileage trigger: overdue by miles with a future date never reads as negative days', () => {
    const facts = computeMaintenanceFacts([], [{
      id: 'suv', nickname: 'Family SUV', status: 'active', currentMileage: 50_200,
      serviceSchedules: [{ id: 'tires', serviceName: 'Tire rotation', nextDueMileage: 49_000, nextDueDate: '2026-08-31' }],
    }], now, localZone);
    const item = facts.next!;
    assert.equal(item.status, 'overdue');
    assert.equal(item.trigger, 'mileage');
    assert.equal(item.statusLabel, 'Overdue');
    assert.match(item.detail, /At 49,000 mi · 1,200 mi over/);
    assert.equal(item.days, 30, 'the date is still in the future');
    assert.doesNotMatch(`${item.statusLabel} ${item.detail}`, /-\d/);
    // A date-driven reminder keeps the date trigger and Maintenance's own wording.
    const byDate = computeMaintenanceFacts([{ id: 'hvac', name: 'HVAC', category: 'HVAC', status: 'active', schedules: [{ scheduleName: 'Filter', nextDueDate: '2026-07-20' }] }], [], now, localZone).next!;
    assert.equal(byDate.trigger, 'date');
    assert.equal(byDate.statusLabel, 'Overdue');
    assert.match(byDate.detail, /^Due Jul 20, 2026 · 12 days ago$/);
  });

  it('leaves out retired assets and retired or sold vehicles, as Maintenance does', () => {
    const facts = computeMaintenanceFacts(
      [{ id: 'old-ac', name: 'Old AC', category: 'HVAC', status: 'retired', schedules: [{ scheduleName: 'Service', nextDueDate: '2026-07-01' }] }],
      [
        { id: 'sold', nickname: 'Sold car', status: 'sold', registrationExpiration: '2026-07-01', serviceSchedules: [{ serviceName: 'Oil', nextDueDate: '2026-07-01' }] },
        { id: 'retired', nickname: 'Retired van', status: 'retired', currentMileage: 99000, serviceSchedules: [{ serviceName: 'Tires', nextDueMileage: 1000 }] },
      ],
      now,
      localZone,
    );
    assert.deepEqual(facts.items, []);
    assert.equal(facts.next, null);
    assert.equal(facts.overdue, 0);
    assert.equal(facts.vehicleDue, false);
    assert.equal(facts.climateDue, false);
    assert.equal(facts.vehicles, 0);
  });

  it('uses the Pets feeding model: the daily target from the schedule, both date shapes', () => {
    const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
    const facts = computePetFacts(
      [
        { id: 'maple', name: 'Maple', type: 'Dog', foodSchedule: '1.5 cups twice daily' },
        { id: 'pixel', name: 'Pixel', type: 'Cat', foodSchedule: 'One can morning and evening' },
        { id: 'rex', name: 'Rex', type: 'Dog', feedingsPerDay: 1 },
      ],
      {
        // A Timestamp-like entry and a legacy ISO-string entry both count.
        maple: [{ date: { toDate: () => hoursAgo(2) }, loggedByName: 'Sam' }, { date: hoursAgo(4).toISOString() }],
        pixel: [{ date: hoursAgo(1) }],
        rex: [{ date: hoursAgo(26) }],
      },
      now,
    );
    assert.deepEqual(facts.pets.map((pet) => [pet.name, pet.fed, pet.countLabel]), [
      ['Maple', true, '2 of 2 today'],
      ['Pixel', false, '1 of 2 today'],
      ['Rex', false, '0 of 1 today'],
    ]);
    assert.equal(facts.pets[0].headline, 'Fed 2 h ago by Sam');
    assert.equal(facts.hungry, 2);
  });
});

describe('chore folding', () => {
  it('counts a missed recurring series once, as the Chores page does', () => {
    const series = (id: string, day: string) => ({
      id, task: 'Water plants', templateId: 'water', assignedToEmail: viewer.email, dueDate: day, originalDueDate: day, isCompleted: false, roomIds: ['kitchen'],
    });
    const records = [series('w1', '2026-07-30'), series('w2', '2026-07-31'), series('w3', '2026-08-01')];
    const recurring = recurringTemplateIdsFrom([{ id: 'water', recurrence: { frequency: 'daily', interval: 1, assignedToEmail: viewer.email } }], '2026-08-01');
    const folded = computeChoreFacts(records, rooms, viewer, now, recurring);
    assert.equal(folded.mineOverdue, 0);
    assert.equal(folded.mineDueToday, 1);
    assert.equal(folded.rooms.find((room) => room.id === 'kitchen')?.overdue, 0);
    // Without a repeating template nothing folds.
    const unfolded = computeChoreFacts(records, rooms, viewer, now);
    assert.equal(unfolded.mineOverdue, 2);
  });

  it('reads completion from the server stamp when present', () => {
    const facts = computeChoreFacts([{
      id: 'k', task: 'Reset', assignedToEmail: viewer.email, originalDueDate: '2026-08-01', dueDate: '2026-08-01', isCompleted: true,
      completedAt: '2026-07-01T10:00:00.000Z', completedAtServer: { toDate: () => new Date(2026, 7, 1, 9) }, roomIds: ['kitchen'],
    }], rooms, viewer, now);
    assert.equal(facts.todayDone, 1);
    assert.equal(facts.rooms.find((room) => room.id === 'kitchen')?.doneToday, 1);
  });
});

describe('buildMorningBrief', () => {
  it('builds one sentence from exact counts with links', () => {
    const facts = {
      chores: computeChoreFacts(chores, rooms, viewer, now),
      pets: computePetFacts([{ id: 'pixel', name: 'Pixel', type: 'Cat', foodSchedule: 'twice daily' }], {}, now),
      pantry: computePantryFacts([{ id: 'milk', name: 'Milk', location: 'Fridge', expiryDate: '2026-08-02' }], now),
    };
    const brief = buildMorningBrief(facts, { greeting: 'Good morning', name: 'Alex Owner' });
    assert.equal(brief.text, "Good morning, Alex. 1 chore today (1 overdue), Pixel's next meal is due, and the milk expires tomorrow.");
    assert.deepEqual(brief.segments.filter((segment) => segment.href).map((segment) => segment.href), ['/chores', '/pets/pixel?tab=feeding', '/shopping?tab=pantry']);
  });

  it('has a calm line when nothing needs attention', () => {
    const brief = buildMorningBrief({}, { greeting: 'Good evening' });
    assert.equal(brief.text, 'Good evening. Nothing needs you right now. Enjoy the quiet.');
  });
});

describe('Home Wrapped aggregation', () => {
  it('counts chores in the year and names the champion by first name only', () => {
    const summary = summarizeChores([
      { id: '1', isCompleted: true, completedAt: '2026-03-01T10:00:00Z', assignedToEmail: 'sam@example.test', assignedToDisplayName: 'Sam Member' },
      { id: '2', isCompleted: true, completedAt: '2026-04-01T10:00:00Z', assignedToEmail: 'sam@example.test', assignedToDisplayName: 'Sam Member' },
      { id: '3', isCompleted: true, completedAt: '2026-04-01T10:00:00Z', assignedToEmail: 'morgan.admin@example.test' },
      { id: '4', isCompleted: true, completedAt: '2025-12-30T10:00:00Z', assignedToEmail: 'old@example.test', assignedToDisplayName: 'Old Year' },
    ], 2026);
    assert.equal(summary.choresDone, 3);
    assert.deepEqual(summary.champion, { name: 'Sam', count: 2 });
    assert.equal(firstNameOnly('morgan.admin@example.test'), 'Morgan');
  });

  it('scores members by identity, so two people with one first name never pool chores', () => {
    const done = (id: string, email: string, name: string) => ({ id, isCompleted: true, completedAt: '2026-05-01T10:00:00Z', assignedToEmail: email, assignedToDisplayName: name });
    const summary = summarizeChores([
      ...['a', 'b', 'c'].map((id) => done(`s1${id}`, 'sam.one@example.test', 'Sam One')),
      ...['a', 'b', 'c'].map((id) => done(`s2${id}`, 'sam.two@example.test', 'Sam Two')),
      ...['a', 'b', 'c', 'd', 'e'].map((id) => done(`al${id}`, 'alex@example.test', 'Alex')),
    ], 2026, new Map([['alex@example.test', 'Alex Owner']]));
    assert.deepEqual(summary.champion, { name: 'Alex', count: 5 });
    // A renamed member keeps one score.
    const renamed = summarizeChores([done('1', 'jo@example.test', 'Jo'), done('2', 'jo@example.test', 'Joanna')], 2026);
    assert.deepEqual(renamed.champion, { name: 'Jo', count: 2 });
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
