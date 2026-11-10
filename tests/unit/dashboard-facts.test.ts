import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeChoreFacts,
  computeMaintenanceFacts,
  computePantryFacts,
  computePetFacts,
  computeShoppingFacts,
  recurringTemplateIdsFrom,
  UNKNOWN_ROOM_ID,
} from '../../src/lib/dashboard/facts';

const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
import { buildMorningBrief } from '../../src/lib/dashboard/brief';
import { countInYear, maintenanceSpend, readConsistentChoreTotals, statsSignature, summarizeChores, topPurchasedItem, firstNameOnly, yearBounds, yearIn } from '../../src/lib/dashboard/wrapped';
import { choreStatsAssigneeKey } from '../../functions/src/shared/ids';
import { addPurgedChores, choreStatsDocId, completionYear, readChoreStats } from '../../functions/src/shared/chore-stats';
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
  // A generated occurrence weeks away: not "open for you" today and not "coming up" this week.
  { id: 'far', task: 'Deep clean oven', assignedToEmail: viewer.email, dueDate: '2026-09-15', isCompleted: false },
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

  it('counts the viewer’s open (overdue + due today), overdue and due-today chores', () => {
    assert.equal(facts.mineOpen, 2);
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

  it("'Your chores' lists only the viewer's own open work within the week (HP-11a)", () => {
    assert.deepEqual(facts.mineNext.map((chore) => chore.id), ['late', 'kitchen', 'nowhere']);
    assert.ok(facts.mineNext.every((chore) => chore.mine));
    assert.ok(facts.nextUp.some((chore) => !chore.mine), 'the household list still has everyone');
  });

  it("a room lists overdue, then today's, then the soonest, and drops far-future repeats (HP-10)", () => {
    const kitchen = [
      { id: 'far1', task: 'Descale kettle', dueDate: '2026-09-20', isCompleted: false, roomIds: ['kitchen'] },
      { id: 'soon', task: 'Clean fridge', dueDate: '2026-08-04', isCompleted: false, roomIds: ['kitchen'] },
      { id: 'far2', task: 'Defrost freezer', dueDate: '2026-10-01', isCompleted: false, roomIds: ['kitchen'] },
      { id: 'today', task: 'Dishes', dueDate: '2026-08-01', originalDueDate: '2026-08-01', isCompleted: false, roomIds: ['kitchen'] },
      { id: 'undated', task: 'Sort drawer', isCompleted: false, roomIds: ['kitchen'] },
      { id: 'late2', task: 'Mop floor', dueDate: '2026-07-31', isCompleted: false, roomIds: ['kitchen'] },
      { id: 'late5', task: 'Wipe cabinets', dueDate: '2026-07-27', isCompleted: false, roomIds: ['kitchen'] },
    ];
    const room = computeChoreFacts(kitchen, rooms, viewer, now).rooms.find((entry) => entry.id === 'kitchen')!;
    assert.deepEqual(room.chores.map((chore) => chore.id), ['late5', 'late2', 'today']);
    const later = computeChoreFacts(kitchen.filter((chore) => chore.id.startsWith('far') || chore.id === 'soon' || chore.id === 'undated'), rooms, viewer, now)
      .rooms.find((entry) => entry.id === 'kitchen')!;
    assert.deepEqual(later.chores.map((chore) => chore.id), ['soon', 'undated'], 'beyond the upcoming window is left out');
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
    assert.equal(facts.nearest[0].label, 'expiring in 3 days');
    assert.equal(facts.total, 3, 'the house pantry counts every item, wherever it is kept (HP-9)');
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
    assert.equal(facts.climateAssets, 1);
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

describe('records whose group was deleted are never dropped', () => {
  it('keeps chores of a deleted room in an "Unknown Room" bucket, counted once', () => {
    const facts = computeChoreFacts([
      { id: 'gone', task: 'Paint shed', assignedToEmail: viewer.email, dueDate: '2026-07-29', originalDueDate: '2026-07-29', isCompleted: false, roomIds: ['shed', 'attic'] },
      { id: 'mixed', task: 'Dust', assignedToEmail: viewer.email, dueDate: '2026-08-01', originalDueDate: '2026-08-01', isCompleted: false, roomIds: ['kitchen', 'shed'] },
    ], rooms, viewer, now);
    const unknown = facts.rooms.find((room) => room.id === UNKNOWN_ROOM_ID);
    assert.equal(unknown?.name, 'Unknown Room');
    assert.equal(unknown?.overdue, 1, 'two missing rooms on one chore count once');
    assert.equal(unknown?.dueToday, 1);
    assert.equal(unknown?.status, 'overdue');
    assert.equal(facts.rooms.find((room) => room.id === 'kitchen')?.dueToday, 1);
    assert.equal(facts.overdueTotal, 1);
  });

  it('counts chores of an assignee who is no longer a member in household totals', () => {
    const facts = computeChoreFacts([
      { id: 'left', task: 'Mow', assignedToEmail: 'former@example.test', dueDate: '2026-07-30', originalDueDate: '2026-07-30', isCompleted: false, roomIds: ['garage'] },
    ], rooms, viewer, now);
    assert.equal(facts.overdueTotal, 1);
    assert.equal(facts.rooms.find((room) => room.id === 'garage')?.overdue, 1);
    assert.equal(facts.mineOpen, 0);
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
      pets: computePetFacts([{ id: 'pixel', name: 'Pixel', type: 'Cat', foodSchedule: 'twice daily' }], { pixel: [] }, now),
      pantry: computePantryFacts([{ id: 'milk', name: 'Milk', location: 'Fridge', expiryDate: '2026-08-02' }], now),
    };
    const brief = buildMorningBrief(facts, { greeting: 'Good morning', name: 'Alex Owner' });
    assert.equal(brief.text, "Good morning, Alex. 1 chore today (1 overdue), Pixel's next meal is due, and the Milk expiring tomorrow.");
    assert.deepEqual(brief.segments.filter((segment) => segment.href).map((segment) => segment.href), ['/chores', '/pets/pixel?tab=feeding', '/shopping?tab=pantry']);
  });

  it('has a calm line when nothing needs attention', () => {
    const brief = buildMorningBrief({}, { greeting: 'Good evening' });
    assert.equal(brief.text, 'Good evening. Nothing needs you right now. Enjoy the quiet.');
  });

  it('keeps the item name as written, with no verb to agree (HP-22a)', () => {
    const pantry = computePantryFacts([{ id: 'eggs', name: 'Eggs', expiryDate: '2026-08-02' }], now);
    assert.equal(buildMorningBrief({ pantry }, { greeting: 'Hi' }).text, 'Hi. The Eggs expiring tomorrow.');
    const brand = computePantryFacts([{ id: 'y', name: 'Chobani yogurt', expiryDate: '2026-08-01' }], now);
    assert.equal(buildMorningBrief({ pantry: brand }, { greeting: 'Hi' }).text, 'Hi. The Chobani yogurt expiring today.');
  });

  it('falls back to household totals when the reader has nothing of their own (HP-3a)', () => {
    const others = chores.map((chore) => ({ ...chore, assignedToEmail: 'sam@example.test' }));
    const facts = { chores: computeChoreFacts(others, rooms, viewer, now) };
    const brief = buildMorningBrief(facts, { greeting: 'Hi' });
    assert.equal(brief.text, 'Hi. 2 household chores today (1 overdue).');
    assert.deepEqual(brief.segments.find((segment) => segment.href)?.peek, { kind: 'chores', scope: 'household' });

    const overdueOnly = { chores: computeChoreFacts(others.filter((chore) => chore.id === 'late'), rooms, viewer, now) };
    const line = buildMorningBrief(overdueOnly, { greeting: 'Hi' }).text;
    assert.equal(line, 'Hi. 1 overdue household chore.');
    assert.doesNotMatch(line, /Nothing needs you/);
  });

  it("uses the reader's own counts when there are any", () => {
    const brief = buildMorningBrief({ chores: computeChoreFacts(chores, rooms, viewer, now) }, { greeting: 'Hi' });
    assert.deepEqual(brief.segments.find((segment) => segment.href)?.peek, { kind: 'chores', scope: 'mine' });
  });
});

describe('Home Wrapped aggregation', () => {
  it('counts chores in the year and names the champion by first name only', () => {
    const summary = summarizeChores([
      { id: '1', isCompleted: true, completedAt: '2026-03-01T10:00:00Z', assignedToEmail: 'sam@example.test', assignedToDisplayName: 'Sam Member' },
      { id: '2', isCompleted: true, completedAt: '2026-04-01T10:00:00Z', assignedToEmail: 'sam@example.test', assignedToDisplayName: 'Sam Member' },
      { id: '3', isCompleted: true, completedAt: '2026-04-01T10:00:00Z', assignedToEmail: 'morgan.admin@example.test' },
      { id: '4', isCompleted: true, completedAt: '2025-12-30T10:00:00Z', assignedToEmail: 'old@example.test', assignedToDisplayName: 'Old Year' },
    ], 2026, { timeZone: 'UTC' });
    assert.equal(summary.choresDone, 3);
    assert.equal(summary.choresWindow, 'last90days', 'no stats document: only retained chores');
    assert.deepEqual(summary.champion, { name: 'Sam', count: 2 });
    assert.equal(firstNameOnly('morgan.admin@example.test'), 'Morgan');
  });

  it('scores members by identity, so two people with one first name never pool chores', () => {
    const done = (id: string, email: string, name: string) => ({ id, isCompleted: true, completedAt: '2026-05-01T10:00:00Z', assignedToEmail: email, assignedToDisplayName: name });
    const summary = summarizeChores([
      ...['a', 'b', 'c'].map((id) => done(`s1${id}`, 'sam.one@example.test', 'Sam One')),
      ...['a', 'b', 'c'].map((id) => done(`s2${id}`, 'sam.two@example.test', 'Sam Two')),
      ...['a', 'b', 'c', 'd', 'e'].map((id) => done(`al${id}`, 'alex@example.test', 'Alex')),
    ], 2026, { names: new Map([['alex@example.test', 'Alex Owner']]), timeZone: 'UTC' });
    assert.deepEqual(summary.champion, { name: 'Alex', count: 5 });
    // A renamed member keeps one score.
    const renamed = summarizeChores([done('1', 'jo@example.test', 'Jo'), done('2', 'jo@example.test', 'Joanna')], 2026, { timeZone: 'UTC' });
    assert.deepEqual(renamed.champion, { name: 'Jo', count: 2 });
  });

  it('adds chores upkeep already removed (yearly stats) to the retained ones, with no double counting', () => {
    const sam = choreStatsAssigneeKey('sam@example.test');
    const alex = choreStatsAssigneeKey('alex@example.test');
    // Upkeep removed 40 of Sam's and 2 of Alex's completions earlier in the year.
    const stats = { year: 2026, completed: 42, byAssignee: { [sam]: 40, [alex]: 2 }, names: { [sam]: 'Sam Member', [alex]: 'Alex Owner' } };
    const retained = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, isCompleted: true, completedAt: '2026-10-01T10:00:00Z', assignedToEmail: 'alex@example.test', assignedToDisplayName: 'Alex Owner' })),
      { id: 's1', isCompleted: true, completedAt: '2026-10-02T10:00:00Z', assignedToEmail: 'Sam@Example.test', assignedToDisplayName: 'Sam Member' },
    ];
    const summary = summarizeChores(retained, 2026, { stats, timeZone: 'UTC' });
    assert.equal(summary.choresWindow, 'year');
    assert.equal(summary.choresDone, 48, '42 removed + 6 retained');
    assert.deepEqual(summary.champion, { name: 'Sam', count: 41 }, 'merged per assignee key, case-insensitive email');
  });

  it('counts a completion in the household’s year, like the stats', () => {
    // 03:00 UTC on Jan 1 is still Dec 31 in Chicago.
    const chore = { id: 'ny', isCompleted: true, completedAt: '2026-01-01T03:00:00Z', assignedToEmail: 'sam@example.test' };
    assert.equal(summarizeChores([chore], 2025, { timeZone: 'America/Chicago' }).choresDone, 1);
    assert.equal(summarizeChores([chore], 2026, { timeZone: 'America/Chicago' }).choresDone, 0);
  });

  it('upkeep stats helpers: stable keys, merging and defensive reads', () => {
    assert.equal(choreStatsAssigneeKey('Sam.Member@Example.test'), choreStatsAssigneeKey(' sam.member@example.test '));
    assert.doesNotMatch(choreStatsAssigneeKey('sam.member@example.test'), /[.@/]/);
    assert.notEqual(choreStatsAssigneeKey('sam.one@example.test'), choreStatsAssigneeKey('sam.two@example.test'));
    assert.equal(choreStatsDocId(2026), 'chores-2026');
    assert.equal(completionYear({ isCompleted: true, completedAt: '2026-01-01T03:00:00.000Z' }, 'America/Chicago'), 2025);
    // The server stamp wins over the client-written string, as in Chores' completionInstant.
    assert.equal(completionYear({ isCompleted: true, completedAt: '2025-12-31T12:00:00.000Z', completedAtServer: { toDate: () => new Date('2026-01-02T12:00:00.000Z') } }, 'America/Chicago'), 2026);
    assert.equal(completionYear({ isCompleted: true, completedAt: '2025-12-31T12:00:00.000Z', completedAtServer: { seconds: Date.parse('2026-01-02T12:00:00.000Z') / 1000 } }, 'UTC'), 2026);
    const next = addPurgedChores(readChoreStats({ completed: 'x', byAssignee: { bad: -1 } }, 2026), [
      { assignedToEmail: 'sam@example.test', assignedToDisplayName: 'Sam', completedAt: '2026-02-01T00:00:00Z' },
      { completedAt: '2026-02-01T00:00:00Z' },
    ]);
    assert.deepEqual(next, { year: 2026, completed: 2, byAssignee: { [choreStatsAssigneeKey('sam@example.test')]: 1 }, names: { [choreStatsAssigneeKey('sam@example.test')]: 'Sam' } });
  });

  it('buckets feedings and upkeep by their own dates, in the household year, in either shape', () => {
    const zone = 'America/Chicago';
    // Feedings: Timestamp-like, Date and ISO string; 03:00 UTC Jan 1 is still Dec 31 in Chicago.
    const dates = [
      { toDate: () => new Date('2026-03-01T12:00:00Z') },
      new Date('2026-07-04T12:00:00Z'),
      '2026-01-01T03:00:00.000Z',
      '2026-12-31T12:00:00.000Z',
      '2027-01-01T08:00:00.000Z',
    ];
    assert.equal(countInYear(dates, 2026, zone), 3);
    assert.equal(countInYear(dates, 2025, zone), 1);
    const { start, end } = yearBounds(2026, zone);
    assert.equal(start.toISOString(), '2026-01-01T06:00:00.000Z');
    assert.equal(end.toISOString(), '2027-01-01T06:00:00.000Z');
    // Maintenance logs store a calendar day; it is that day's year in any zone.
    assert.equal(yearIn('2026-01-01', 'Pacific/Kiritimati'), 2026);
    assert.deepEqual(maintenanceSpend([
      { id: '1', date: '2026-01-01', cost: 50 },
      { id: '2', date: '2026-01-01T03:00:00.000Z', cost: 70 },
    ], 2026, zone), { spend: 50, logs: 1 });
  });

  it('reads yearly stats and retained chores as one snapshot, retrying when a purge lands in between', async () => {
    // A fake household: 3 retained completions this year, 10 already archived.
    const chore = (id: string) => ({ id, isCompleted: true, completedAt: '2026-10-01T10:00:00Z', assignedToEmail: 'sam@example.test' });
    let retained = [chore('a'), chore('b'), chore('c')];
    let stats: Record<string, unknown> = { year: 2026, completed: 10, byAssignee: { [choreStatsAssigneeKey('sam@example.test')]: 10 }, updatedAt: new Date('2026-11-01T00:00:00Z') };
    // Upkeep's purge: archive chore "a" into the stats and delete it, atomically.
    const purge = () => {
      retained = retained.filter((entry) => entry.id !== 'a');
      stats = { ...stats, completed: 11, byAssignee: { [choreStatsAssigneeKey('sam@example.test')]: 11 }, updatedAt: new Date('2026-11-06T00:00:00Z') };
    };
    let statsReads = 0;
    let purged = false;
    const reader = {
      readStats: async () => {
        statsReads += 1;
        return stats;
      },
      readRetained: async () => {
        const snapshot = [...retained];
        // The purge commits after the retained query but before the second stats read.
        if (!purged) {
          purged = true;
          purge();
        }
        return snapshot;
      },
    };
    const totals = await readConsistentChoreTotals(reader);
    assert.equal(totals.consistent, true);
    assert.equal(totals.attempts, 2, 'the first, torn snapshot was retried');
    assert.equal(statsReads, 4);
    const summary = summarizeChores(totals.retained, 2026, { stats: totals.consistent ? totals.stats : undefined, timeZone: 'UTC' });
    assert.equal(summary.choresDone, 13, 'chore "a" counted once: 11 archived + 2 retained, not 11 + 3');
    assert.equal(summary.champion?.count, 13);

    // A household where totals change on every read: gives up and returns the retained chores only.
    let tick = 0;
    const busy = await readConsistentChoreTotals({
      readStats: async () => ({ completed: tick++, updatedAt: new Date(tick) }),
      readRetained: async () => [chore('x')],
    });
    assert.equal(busy.consistent, false);
    assert.equal(busy.attempts, 3);
    assert.equal(summarizeChores(busy.retained, 2026, { timeZone: 'UTC' }).choresWindow, 'last90days');

    // Missing on both reads is consistent (no stats yet).
    const none = await readConsistentChoreTotals({ readStats: async () => undefined, readRetained: async () => [] });
    assert.equal(none.consistent, true);
    assert.equal(statsSignature(undefined), 'missing');
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

describe('Wrapped year', () => {
  it("is the household's current year, not the browser's, around New Year", () => {
    // 00:30 UTC on Jan 1 2027 is still Dec 31 2026 in Chicago.
    const instant = new Date('2027-01-01T00:30:00Z');
    assert.equal(yearIn(instant, 'America/Chicago'), 2026);
    assert.equal(yearIn(instant, 'UTC'), 2027);
  });
});
