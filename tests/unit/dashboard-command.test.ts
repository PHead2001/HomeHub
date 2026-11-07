import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseQuickAdd, findRoom, findMaintenanceTarget, firstDateForRepeat, normalizeRepeat, MONTHLY_MAX_DAY, type QuickAddContext } from '../../src/lib/dashboard/quick-add';
import { defaultMaintenanceTarget, describeIntent, quickAddConfirmBlocker } from '../../src/lib/dashboard/quick-add-preview';
import { buildAiParseRequest, createRevisionGuard, intentFromAiParse, shouldOfferAiParse } from '../../src/lib/dashboard/quick-add-ai';
import { mileageNote, quickCreateId, quickMaintenanceLog, recurrenceFromRepeat, repeatingChoreTemplate } from '../../src/lib/dashboard/quick-add-writes';
import { dayKey } from '../../src/lib/dashboard/dates';
import { GO_TARGETS, SHORTCUTS, ariaKeyShortcuts, isShortcutSequence, shortcutById, shortcutText } from '../../src/lib/dashboard/shortcuts';
import { notificationDestination } from '../../src/lib/dashboard/notification-display';
import { buildMorningBrief } from '../../src/lib/dashboard/brief';
import type { DashboardFacts } from '../../src/lib/dashboard/facts';
import { ROUTE_TRANSITION, STAGGER, TAB_ENTER, morphProps, morphStyle, sharedId, staggerItemDelayMs, tabEnterChange } from '../../src/lib/motion';
import { routeKey } from '../../src/components/motion/route-transition';

// Saturday, 1 August 2026, local noon.
const now = new Date(2026, 7, 1, 12, 0, 0);

const context: QuickAddContext = {
  now,
  viewer: { uid: 'owner', email: 'alex@example.test' },
  members: [
    { uid: 'owner', email: 'alex@example.test', name: 'Alex Owner' },
    { uid: 'sam', email: 'sam.member@example.test', name: 'Sam Member' },
  ],
  pets: [{ id: 'maple', name: 'Maple' }],
  lists: [{ id: 'weekly-groceries', name: 'Weekly Groceries', type: 'Grocery' }],
  rooms: [{ id: 'kitchen', name: 'Kitchen' }, { id: 'living-room', name: 'Living Room' }],
  vehicles: [
    { id: 'civic', name: 'Family Civic', make: 'Honda', model: 'Civic', currentMileage: 48_000 },
    { id: 'truck', name: 'Work Truck', make: 'Ford', model: 'F-150', currentMileage: 90_000 },
  ],
  assets: [{ id: 'furnace', name: 'Furnace' }],
};

describe('quick add: the two sentences from the audit (H13)', () => {
  it('"trash every Tuesday for Sam" is a repeating chore for Sam, first due on the coming Tuesday', () => {
    const intent = parseQuickAdd('trash every Tuesday for Sam', context);
    assert.equal(intent?.kind, 'chore');
    if (intent?.kind !== 'chore') return;
    assert.equal(intent.task, 'Trash');
    assert.deepEqual(intent.repeat, { frequency: 'weekly', dayOfWeek: 2 });
    assert.equal(intent.assignee?.uid, 'sam');
    assert.equal(intent.room, null);
    assert.equal(intent.dueDate, '2026-08-04');
    const preview = describeIntent(intent, context.members[0]);
    assert.equal(preview.title, 'Repeating chore: Trash');
    assert.match(preview.detail, /^repeats every Tuesday, first Tue, Aug 4 · for Sam Member$/);
  });

  it('"oil change 48,200 miles" is a maintenance log with the odometer reading', () => {
    const intent = parseQuickAdd('oil change 48,200 miles', context);
    assert.deepEqual(intent, { kind: 'maintenance', title: 'Oil change', mileage: 48_200, target: null });
    if (intent?.kind !== 'maintenance') return;
    assert.equal(describeIntent(intent, null).detail, 'at 48,200 miles · General log · today');
    const withVehicle = { ...intent, target: { kind: 'vehicle' as const, vehicle: context.vehicles![0] } };
    assert.equal(describeIntent(withVehicle, null).detail, 'at 48,200 miles · Family Civic · today');
  });
});

describe('quick add: rooms, vehicles and assets', () => {
  it('reads a room and removes "in the <room>" from the task', () => {
    const intent = parseQuickAdd('wipe counters in the kitchen every Tuesday for Sam', context);
    assert.equal(intent?.kind, 'chore');
    if (intent?.kind !== 'chore') return;
    assert.equal(intent.task, 'Wipe counters');
    assert.equal(intent.room?.id, 'kitchen');
    assert.match(describeIntent(intent, null).detail, / · Kitchen$/);
  });

  it('keeps a bare room word in the task, matches whole words and the longest name', () => {
    assert.equal(findRoom('vacuum living room friday', context.rooms!)?.room.id, 'living-room');
    assert.equal(findRoom('vacuum living room friday', context.rooms!)?.consumed, null);
    assert.equal(findRoom('restock kitchenette', context.rooms!), null);
    const intent = parseQuickAdd('clean kitchen tomorrow', context);
    assert.equal(intent?.kind === 'chore' && intent.task, 'Clean kitchen');
    assert.equal(intent?.kind === 'chore' && intent.room?.id, 'kitchen');
  });

  it('names the vehicle by nickname, make or model, and only vehicles take a mileage', () => {
    const civic = parseQuickAdd('oil change on the Civic 48,200 miles', context);
    assert.equal(civic?.kind === 'maintenance' && civic.target?.kind === 'vehicle' && civic.target.vehicle.id, 'civic');
    assert.equal(civic?.kind === 'maintenance' && civic.title, 'Oil change');
    assert.equal(findMaintenanceTarget('tire rotation for the work truck', context.vehicles!, [])?.target.kind, 'vehicle');
    const furnace = parseQuickAdd('log replaced furnace filter', context);
    assert.equal(furnace?.kind === 'maintenance' && furnace.target?.kind, 'asset');
    // A mileage never lands on a home asset.
    assert.equal(findMaintenanceTarget('furnace 1200 miles', [], []), null);
  });

  it('works without rooms or vehicles in the context (older callers)', () => {
    const bare: QuickAddContext = { ...context, rooms: undefined, vehicles: undefined, assets: undefined };
    assert.equal(parseQuickAdd('trash every Tuesday for Sam', bare)?.kind, 'chore');
    assert.equal(parseQuickAdd('oil change 48,200 miles', bare)?.kind, 'maintenance');
  });
});

describe('quick add writes: same shapes as the module screens', () => {
  it('builds the Chores dialog recurrence for each repeat', () => {
    assert.deepEqual(recurrenceFromRepeat({ frequency: 'weekly', dayOfWeek: 2 }, '2026-08-04'), { frequency: 'weekly', interval: 1, weeklyOptions: { daysOfWeek: [2] } });
    assert.deepEqual(recurrenceFromRepeat({ frequency: 'biweekly', dayOfWeek: 5 }, '2026-08-07'), { frequency: 'biweekly', interval: 2, weeklyOptions: { daysOfWeek: [5] }, startDate: '2026-08-07' });
    assert.deepEqual(recurrenceFromRepeat({ frequency: 'daily' }, '2026-08-01'), { frequency: 'daily', interval: 1, dailyOptions: { excludeWeekends: false } });
    assert.deepEqual(recurrenceFromRepeat({ frequency: 'monthly', dayOfMonth: 28 }, '2026-08-28'), { frequency: 'monthly', interval: 1, monthlyOptions: { mode: 'dayOfMonth', dayOfMonth: 28 } });
    // A day the dialog cannot store is refused, never silently changed (intents are normalized before their preview).
    assert.throws(() => recurrenceFromRepeat({ frequency: 'monthly', dayOfMonth: 31 }, '2026-08-31'), /invalid-recurrence/);
  });

  it('builds the chore template with its room and assignee', () => {
    const template = repeatingChoreTemplate({ task: 'Trash', roomId: 'kitchen', recurrence: recurrenceFromRepeat({ frequency: 'weekly', dayOfWeek: 2 }, '2026-08-04'), assigneeEmail: 'sam.member@example.test' });
    assert.deepEqual(template, {
      task: 'Trash',
      notes: '',
      roomIds: ['kitchen'],
      subTasks: [],
      recurrence: { frequency: 'weekly', interval: 1, weeklyOptions: { daysOfWeek: [2] }, assignedToEmail: 'sam.member@example.test' },
      assignedToEmail: 'sam.member@example.test',
    });
    assert.deepEqual(repeatingChoreTemplate({ task: 'X', roomId: 'general', recurrence: { frequency: 'daily', interval: 1 }, assigneeEmail: 'a@b.c' }).roomIds, []);
  });

  it('logs maintenance like the Add log form: mileage only on a vehicle log', () => {
    const nowIso = '2026-08-01T12:00:00.000Z';
    const vehicle = { kind: 'vehicle' as const, vehicle: context.vehicles![0] };
    assert.deepEqual(quickMaintenanceLog({ householdId: 'h1', title: 'Oil change', date: '2026-08-01', mileage: 48_200, target: vehicle, nowIso }), {
      householdId: 'h1', targetType: 'vehicle', vehicleId: 'civic', title: 'Oil change', item: 'Oil change', date: '2026-08-01', type: 'routine', mileage: 48_200, createdAt: nowIso, updatedAt: nowIso,
    });
    const general = quickMaintenanceLog({ householdId: 'h1', title: 'Oil change', date: '2026-08-01', mileage: 48_200, target: null, nowIso });
    assert.equal(general.targetType, 'general');
    assert.equal(general.mileage, undefined);
    assert.equal(general.notes, 'Odometer: 48,200 mi');
    assert.equal('vehicleId' in general, false);
    const asset = quickMaintenanceLog({ householdId: 'h1', title: 'Filter', date: '2026-08-01', mileage: null, target: { kind: 'asset', asset: { id: 'furnace', name: 'Furnace' } }, nowIso });
    assert.equal(asset.targetType, 'home_asset');
    assert.equal(asset.assetId, 'furnace');
  });

  it('warns when a reading is below the recorded odometer', () => {
    const vehicle = { kind: 'vehicle' as const, vehicle: context.vehicles![0] };
    assert.match(mileageNote(40_000, vehicle) ?? '', /below the 48,000 mi/);
    assert.equal(mileageNote(48_200, vehicle), null);
    assert.equal(mileageNote(null, vehicle), null);
  });

  it('starts weekly repeats on the coming weekday, monthly ones on the coming day of the month, daily today', () => {
    assert.equal(dayKey(firstDateForRepeat({ frequency: 'weekly', dayOfWeek: 6 }, now)), '2026-08-01');
    assert.equal(dayKey(firstDateForRepeat({ frequency: 'weekly', dayOfWeek: 2 }, now)), '2026-08-04');
    assert.equal(dayKey(firstDateForRepeat({ frequency: 'monthly', dayOfMonth: 15 }, now)), '2026-08-15');
    assert.equal(dayKey(firstDateForRepeat({ frequency: 'monthly', dayOfMonth: 1 }, now)), '2026-08-01');
    assert.equal(dayKey(firstDateForRepeat({ frequency: 'daily' }, now)), '2026-08-01');
  });
});

describe('quick add AI fallback (client side)', () => {
  it('sends names with opaque references only, never emails or ids', () => {
    const { input, refs } = buildAiParseRequest('  sam   does the recycling on tuesdays ', context);
    assert.equal(input.text, 'sam does the recycling on tuesdays');
    assert.equal(input.today, '2026-08-01');
    assert.deepEqual(input.members, [{ ref: 'm1', name: 'Alex Owner' }, { ref: 'm2', name: 'Sam Member' }]);
    assert.deepEqual(input.vehicles.map((vehicle) => vehicle.ref), ['v1', 'v2']);
    assert.match(input.vehicles[0].name, /Family Civic · Honda Civic/);
    const serialized = JSON.stringify(input);
    assert.equal(serialized.includes('@'), false);
    assert.equal(serialized.includes('civic"'), false);
    assert.equal(refs.members.get('m2')?.uid, 'sam');
    assert.equal(refs.vehicles.get('v1')?.id, 'civic');
  });

  it('turns the reader\'s answer into the same intents (and previews) as the parser', () => {
    const { refs } = buildAiParseRequest('x y', context);
    const chore = intentFromAiParse({ kind: 'chore', chore: { task: 'recycling', repeat: { frequency: 'weekly', dayOfWeek: 2 }, assigneeRef: 'm2', roomRef: 'r1' } }, refs, context);
    assert.equal(chore?.kind, 'chore');
    if (chore?.kind === 'chore') {
      assert.equal(chore.task, 'Recycling');
      assert.equal(chore.dueDate, '2026-08-04');
      assert.equal(chore.assignee?.uid, 'sam');
      assert.equal(chore.room?.id, 'kitchen');
      assert.equal(describeIntent(chore, null).title, 'Repeating chore: Recycling');
    }
    const past = intentFromAiParse({ kind: 'chore', chore: { task: 'call', dueDate: '2020-01-01' } }, refs, context);
    assert.equal(past?.kind === 'chore' && past.dueDate, '2026-08-01');
    const log = intentFromAiParse({ kind: 'maintenance', maintenance: { title: 'oil change', mileage: 48_200, vehicleRef: 'v2' } }, refs, context);
    assert.equal(log?.kind === 'maintenance' && log.target?.kind === 'vehicle' && log.target.vehicle.id, 'truck');
    assert.equal(intentFromAiParse({ kind: 'feeding', feeding: { petRef: 'p9' } }, refs, context), null);
    assert.equal(intentFromAiParse({ kind: 'none' }, refs, context), null);
    const shopping = intentFromAiParse({ kind: 'shopping', shopping: { items: [{ name: 'oat milk', quantity: 2 }] } }, refs, context);
    assert.equal(shopping?.kind === 'shopping' && shopping.list?.id, 'weekly-groceries');
  });

  it('offers AI only for unread sentences or a bare-words guess', () => {
    assert.equal(shouldOfferAiParse('sam does the recycling on tuesdays', null), true);
    assert.equal(shouldOfferAiParse('milk', null), false);
    assert.equal(shouldOfferAiParse('trash every Tuesday for Sam', parseQuickAdd('trash every Tuesday for Sam', context)), false);
    assert.equal(shouldOfferAiParse('sam does recycling', { kind: 'shopping', items: [{ name: 'Sam does recycling', quantity: 1 }], list: null, explicit: false }), true);
  });
});

describe('shortcut hints come from the binding map (H28)', () => {
  it('every binding has a unique id and readable text', () => {
    const ids = SHORTCUTS.map((shortcut) => shortcut.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(shortcutText('new-chore'), 'N');
    assert.equal(shortcutText('add-item'), 'A');
    assert.equal(shortcutText('log-feeding'), 'F');
    assert.equal(shortcutText('palette'), 'Ctrl+K');
    assert.equal(shortcutText('go-chores'), 'G then C');
    for (const target of Object.values(GO_TARGETS)) assert.equal(shortcutById(target.id).action.type, 'go');
  });

  it('sets aria-keyshortcuts for chords and keys, not for sequences', () => {
    assert.equal(ariaKeyShortcuts('palette'), 'Control+K Meta+K');
    assert.equal(ariaKeyShortcuts('new-chore'), 'N');
    assert.equal(ariaKeyShortcuts('go-shopping'), undefined);
    assert.equal(isShortcutSequence(shortcutById('go-pets')), true);
    assert.equal(isShortcutSequence(shortcutById('palette')), false);
  });
});

describe('motion budgets (H12)', () => {
  it('stagger: first item at once, 30 ms steps, capped under 400 ms', () => {
    assert.equal(staggerItemDelayMs(0), 0);
    assert.equal(staggerItemDelayMs(1), 30);
    assert.equal(staggerItemDelayMs(11), 330);
    assert.equal(staggerItemDelayMs(500), 330);
    assert.ok(staggerItemDelayMs(500) <= STAGGER.maxTotal * 1000);
  });

  it('tabs and route transitions stay inside the UI budget', () => {
    assert.ok(TAB_ENTER.durationMs <= 150);
    assert.ok(ROUTE_TRANSITION.linkMaxWaitMs <= ROUTE_TRANSITION.morphMaxWaitMs);
    assert.ok(ROUTE_TRANSITION.morphMaxWaitMs <= 800);
    assert.equal(routeKey({ pathname: '/shopping', search: '?list=a' }), '/shopping?list=a');
  });

  it('morph names work for any element pair', () => {
    const name = sharedId('asset', 'water heater/1', 'card');
    assert.equal(name, 'asset-water_heater_1-card');
    assert.deepEqual(morphProps(name), { style: morphStyle(name), 'data-morph': name });
    assert.deepEqual(morphProps(null), {});
  });
});

describe('peeks (H26)', () => {
  it('names where a notification link goes', () => {
    assert.equal(notificationDestination('/chores?room=kitchen'), 'Chores');
    assert.equal(notificationDestination('/pets/maple?tab=feeding'), 'Pets');
    assert.equal(notificationDestination('#'), null);
    assert.equal(notificationDestination('/'), 'Home');
  });

  it('tags every linked brief phrase with what its peek shows', () => {
    const facts = {
      chores: { mineDueToday: 2, mineOverdue: 0 },
      pets: { pets: [{ id: 'maple', name: 'Maple', fed: false }], hungry: 1, unknown: 0 },
    } as unknown as DashboardFacts;
    const brief = buildMorningBrief(facts, { greeting: 'Morning', name: 'Alex' });
    const linked = brief.segments.filter((segment) => segment.href);
    assert.deepEqual(linked.map((segment) => segment.peek), [{ kind: 'chores' }, { kind: 'pet', id: 'maple' }]);
  });
});

describe('monthly repeats use the Chores 1-28 rule before the preview (review 4503881855)', () => {
  it('normalizes days 29-31 to the 28th with a note, and leaves 1-28 alone', () => {
    assert.equal(MONTHLY_MAX_DAY, 28);
    assert.deepEqual(normalizeRepeat({ frequency: 'monthly', dayOfMonth: 15 }), { repeat: { frequency: 'monthly', dayOfMonth: 15 }, note: null });
    const late = normalizeRepeat({ frequency: 'monthly', dayOfMonth: 31 });
    assert.deepEqual(late.repeat, { frequency: 'monthly', dayOfMonth: 28 });
    assert.match(late.note ?? '', /days 1-28.*28th instead of the 31st/);
    assert.equal(normalizeRepeat({ frequency: 'weekly', dayOfWeek: 2 }).note, null);
  });

  it('a "monthly" chore typed on the 31st previews and saves the 28th, first due next month', () => {
    const onThe31st: QuickAddContext = { ...context, now: new Date(2026, 6, 31, 12) };
    const intent = parseQuickAdd('chore water the plants monthly', onThe31st);
    assert.equal(intent?.kind, 'chore');
    if (intent?.kind !== 'chore') return;
    assert.deepEqual(intent.repeat, { frequency: 'monthly', dayOfMonth: 28 });
    assert.equal(intent.dueDate, '2026-08-28');
    assert.match(intent.repeatNote ?? '', /28th/);
    assert.match(describeIntent(intent, null).detail, /monthly on day 28, first Fri, Aug 28/);
    // What the preview shows is exactly what is stored.
    assert.deepEqual(recurrenceFromRepeat(intent.repeat!, intent.dueDate).monthlyOptions, { mode: 'dayOfMonth', dayOfMonth: 28 });
  });

  it('the AI reader monthly day is normalized the same way', () => {
    const { refs } = buildAiParseRequest('x y', context);
    const chore = intentFromAiParse({ kind: 'chore', chore: { task: 'pay rent', repeat: { frequency: 'monthly', dayOfMonth: 30 } } }, refs, context);
    assert.equal(chore?.kind === 'chore' && chore.repeat?.frequency === 'monthly' && chore.repeat.dayOfMonth, 28);
    assert.equal(chore?.kind === 'chore' && chore.dueDate, '2026-08-28');
    assert.match(chore?.kind === 'chore' ? chore.repeatNote ?? '' : '', /30th/);
    const early = intentFromAiParse({ kind: 'chore', chore: { task: 'pay rent', repeat: { frequency: 'monthly', dayOfMonth: 1 } } }, refs, context);
    assert.equal(early?.kind === 'chore' && early.dueDate, '2026-08-01');
    assert.equal(early?.kind === 'chore' && early.repeatNote, null);
  });
});

describe('stale AI reads are ignored (review 4503881859)', () => {
  it('only the latest request, until the input or preview changes, may update the palette', () => {
    const guard = createRevisionGuard();
    const first = guard.next();
    const second = guard.next();
    assert.equal(guard.isCurrent(first), false, 'an older read is stale once a newer one starts');
    assert.equal(guard.isCurrent(second), true);
    guard.invalidate(); // the member edits the sentence or opens another preview
    assert.equal(guard.isCurrent(second), false, 'its answer, error and status are all ignored');
    const third = guard.next();
    assert.equal(guard.isCurrent(third), true);
  });
});

describe('tab entrance follows activation (review 4503881852)', () => {
  it('plays only on inactive to active, never for the first active panel, and clears when hidden', () => {
    assert.equal(tabEnterChange('active', 'active'), 'keep');
    assert.equal(tabEnterChange(null, 'active'), 'keep');
    assert.equal(tabEnterChange('inactive', 'active'), 'add');
    assert.equal(tabEnterChange('active', 'inactive'), 'remove');
    assert.equal(tabEnterChange('inactive', 'inactive'), 'keep');
  });
});

describe('quick add never overwrites on create (review 4503943542)', () => {
  it('ids are a readable slug plus a Firestore auto-id, never the bare slug an existing template may have', () => {
    const a = quickCreateId('Trash', 'Ab3dE5gH7jK9mN1pQ2rS', 'chore');
    const b = quickCreateId('Trash', 'Zz9yX8wV7uT6sR5qP4oN', 'chore');
    assert.equal(a, 'trash-Ab3dE5gH7jK9mN1pQ2rS');
    assert.notEqual(a, b);
    // Chores' own readable ids ("trash", "trash-2") can never be produced.
    assert.notEqual(a, 'trash');
    assert.doesNotMatch(a, /^trash(-\d+)?$/);
    assert.equal(quickCreateId('!!!', 'Ab3dE5gH7jK9mN1pQ2rS', 'chore'), 'chore-Ab3dE5gH7jK9mN1pQ2rS');
    assert.equal(quickCreateId('x'.repeat(200), 'Ab3dE5gH7jK9mN1pQ2rS').length, 60 + 1 + 20);
    // No auto-id, no id: a create must not fall back to a guessable one.
    assert.throws(() => quickCreateId('Trash', ''), /auto-id/);
    assert.throws(() => quickCreateId('Trash', 'abc'), /auto-id/);
  });
});

describe('Confirm waits for the palette index (review 4503943546)', () => {
  const oil = parseQuickAdd('oil change 48,200 miles', context)!;
  const chore = parseQuickAdd('trash every Tuesday for Sam', context)!;
  const shopping = parseQuickAdd('add milk', context)!;
  const suv = { kind: 'vehicle' as const, vehicle: context.vehicles![0] };

  it('every preview kind is blocked while vehicles, members, rooms and lists load', () => {
    for (const intent of [oil, chore, shopping]) {
      assert.match(quickAddConfirmBlocker({ intent, indexLoading: true, vehicleCount: 0, chosenTarget: null }) ?? '', /Loading/, intent.kind);
    }
  });

  it('once loaded, a mileage needs a vehicle when the household has any; otherwise it can save', () => {
    assert.match(quickAddConfirmBlocker({ intent: oil, indexLoading: false, vehicleCount: 2, chosenTarget: null }) ?? '', /vehicle/);
    assert.equal(quickAddConfirmBlocker({ intent: oil, indexLoading: false, vehicleCount: 2, chosenTarget: suv }), null);
    assert.equal(quickAddConfirmBlocker({ intent: oil, indexLoading: false, vehicleCount: 0, chosenTarget: null }), null);
    assert.equal(quickAddConfirmBlocker({ intent: chore, indexLoading: false, vehicleCount: 0, chosenTarget: null }), null);
    assert.equal(quickAddConfirmBlocker({ intent: shopping, indexLoading: false, vehicleCount: 0, chosenTarget: null }), null);
  });
});

describe('"for <member>" resolves and leaves the title (E2E finding 1)', () => {
  it('a trailing "for Sam" is Sam, case-insensitively, and is removed from the task', () => {
    for (const text of ['trash every Tuesday for Sam', 'trash every Tuesday for SAM', 'Trash every tuesday for sam.']) {
      const intent = parseQuickAdd(text, context);
      assert.equal(intent?.kind, 'chore', text);
      if (intent?.kind !== 'chore') continue;
      assert.equal(intent.task, 'Trash', text);
      assert.equal(intent.assignee?.uid, 'sam', text);
      assert.equal(intent.assigneeQuery, null, text);
    }
  });

  it('a name that fits two members leaves the assignee to pick and blocks Confirm until chosen', () => {
    const twoSams: QuickAddContext = {
      ...context,
      members: [...context.members, { uid: 'sam2', email: 'sam.other@example.test', name: 'Sam Other' }],
    };
    const intent = parseQuickAdd('trash every Tuesday for Sam', twoSams);
    assert.equal(intent?.kind, 'chore');
    if (intent?.kind !== 'chore') return;
    assert.equal(intent.task, 'Trash', 'the name is still removed from the title');
    assert.equal(intent.assignee, null);
    assert.equal(intent.assigneeQuery, 'Sam');
    assert.match(describeIntent(intent, twoSams.members[0]).detail, /for which Sam\?/);
    assert.match(quickAddConfirmBlocker({ intent, indexLoading: false, vehicleCount: 0, chosenTarget: null }) ?? '', /Choose who/);
    assert.equal(quickAddConfirmBlocker({ intent, indexLoading: false, vehicleCount: 0, chosenTarget: null, chosenAssignee: twoSams.members[2] }), null);
  });
});

describe('the only vehicle is preselected from the loaded records (E2E finding 2)', () => {
  const oil = parseQuickAdd('oil change 48,200 miles', context)!;
  it('one vehicle: preselected; several: none until chosen; a named one wins', () => {
    const suv = { id: 'family-suv', name: 'Family SUV', currentMileage: 48_750 };
    assert.deepEqual(defaultMaintenanceTarget(oil, [suv]), { kind: 'vehicle', vehicle: suv });
    assert.equal(defaultMaintenanceTarget(oil, []), null);
    assert.equal(defaultMaintenanceTarget(oil, context.vehicles!), null);
    const named = parseQuickAdd('oil change on the Civic 48,200 miles', context)!;
    assert.equal(defaultMaintenanceTarget(named, context.vehicles!)?.kind === 'vehicle' && (defaultMaintenanceTarget(named, context.vehicles!) as { vehicle: { id: string } }).vehicle.id, 'civic');
    // Without a reading nothing is assumed: the log can be general.
    assert.equal(defaultMaintenanceTarget(parseQuickAdd('log replaced filters', context)!, [suv]), null);
    // Preselected, Confirm is free.
    assert.equal(quickAddConfirmBlocker({ intent: oil, indexLoading: false, vehicleCount: 1, chosenTarget: defaultMaintenanceTarget(oil, [suv]) }), null);
  });
});
