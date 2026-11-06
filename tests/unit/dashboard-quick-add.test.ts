import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assignableMembers, describeRepeat, findDate, findList, parseQuickAdd, quickAddRetryMessage, resolveChoreAssignee, shoppingAddOutcome, splitItems, type QuickAddContext } from '../../src/lib/dashboard/quick-add';
import { matchShortcut, isTypingTarget, konamiStep, KONAMI } from '../../src/lib/dashboard/shortcuts';
import { dayKey } from '../../src/lib/dashboard/dates';

// Saturday, 1 August 2026, local noon.
const now = new Date(2026, 7, 1, 12, 0, 0);

const context: QuickAddContext = {
  now,
  viewer: { uid: 'owner', email: 'alex@example.test' },
  members: [
    { uid: 'owner', email: 'alex@example.test', name: 'Alex Owner' },
    { uid: 'sam', email: 'sam.member@example.test', name: 'Sam Member' },
    { uid: 'morgan', email: 'morgan.admin@example.test', name: 'Morgan Admin' },
  ],
  pets: [{ id: 'maple', name: 'Maple' }, { id: 'pixel', name: 'Pixel' }],
  lists: [
    { id: 'weekly-groceries', name: 'Weekly Groceries', type: 'Grocery' },
    { id: 'hardware-run', name: 'Hardware Run', type: 'Hardware' },
  ],
};

describe('parseQuickAdd: shopping', () => {
  it('adds bare items to the grocery list as an implicit suggestion', () => {
    const intent = parseQuickAdd('milk and eggs', context);
    assert.equal(intent?.kind, 'shopping');
    if (intent?.kind !== 'shopping') return;
    assert.deepEqual(intent.items, [{ name: 'Milk', quantity: 1 }, { name: 'Eggs', quantity: 1 }]);
    assert.equal(intent.list?.id, 'weekly-groceries');
    assert.equal(intent.explicit, false);
  });

  it('honors verbs, quantities and a named list', () => {
    const intent = parseQuickAdd('add 2 furnace filters, duct tape to the hardware list', context);
    assert.equal(intent?.kind, 'shopping');
    if (intent?.kind !== 'shopping') return;
    assert.equal(intent.explicit, true);
    assert.equal(intent.list?.id, 'hardware-run');
    assert.deepEqual(intent.items, [{ name: 'Furnace filters', quantity: 2 }, { name: 'Duct tape', quantity: 1 }]);
  });

  it('matches list types by keyword', () => {
    const intent = parseQuickAdd('buy bananas to groceries', context);
    assert.equal(intent?.kind === 'shopping' && intent.list?.id, 'weekly-groceries');
  });

  it('splits with the Shopping parser: counts, casing and repeated names', () => {
    assert.deepEqual(splitItems('3 apples & bread x2'), [{ name: 'Apples', quantity: 3 }, { name: 'Bread', quantity: 2 }]);
    assert.deepEqual(splitItems('milk and Milk x2'), [{ name: 'Milk', quantity: 3 }]);
    // "and" splits only as a whole word.
    assert.deepEqual(splitItems('candles'), [{ name: 'Candles', quantity: 1 }]);
  });

  it('matches list names by whole tokens only', () => {
    assert.equal(findList('hardware', context.lists)?.id, 'hardware-run');
    assert.equal(findList('run', context.lists)?.id, 'hardware-run');
    assert.equal(findList('hard', context.lists), null);
    assert.equal(findList('week', context.lists), null);
  });
});

describe('parseQuickAdd: feedings', () => {
  it('logs a feeding for a known pet', () => {
    const intent = parseQuickAdd('fed Maple', context);
    assert.deepEqual(intent, { kind: 'feeding', pet: { id: 'maple', name: 'Maple' }, amount: null, unit: null });
  });

  it('reads an amount and unit', () => {
    const intent = parseQuickAdd('Pixel ate 1 can', context);
    assert.equal(intent?.kind, 'feeding');
    if (intent?.kind !== 'feeding') return;
    assert.equal(intent.pet.id, 'pixel');
    assert.equal(intent.amount, 1);
    assert.equal(intent.unit, 'Cans');
  });

  it('reads whole portions: leading-dot decimals, fractions and mixed numbers', () => {
    const amount = (text: string) => {
      const intent = parseQuickAdd(text, context);
      return intent?.kind === 'feeding' ? [intent.amount, intent.unit] : intent;
    };
    assert.deepEqual(amount('fed Maple .5 cups'), [0.5, 'Cups']);
    assert.deepEqual(amount('fed Maple 1/2 cup'), [0.5, 'Cups']);
    assert.deepEqual(amount('fed Maple 1 1/2 cups'), [1.5, 'Cups']);
    assert.deepEqual(amount('fed Maple 1.5 cups'), [1.5, 'Cups']);
    assert.deepEqual(amount('fed Pixel one can'), [1, 'Cans']);
    // An amount that cannot be read is rejected, never misread.
    assert.equal(amount('fed Maple 3/0 cups'), null);
    assert.equal(amount('fed Maple 99 cups'), null);
  });

  it('matches pet names as whole words', () => {
    assert.equal(parseQuickAdd('fed Mapleton', context), null);
  });

  it('does not invent pets', () => {
    assert.notEqual(parseQuickAdd('fed Rex', context)?.kind, 'feeding');
  });
});

describe('parseQuickAdd: chores', () => {
  it('reads a repeat and an assignee', () => {
    const intent = parseQuickAdd('trash every Tuesday for Sam', context);
    assert.equal(intent?.kind, 'chore');
    if (intent?.kind !== 'chore') return;
    assert.equal(intent.task, 'Trash');
    assert.equal(intent.assignee?.uid, 'sam');
    assert.deepEqual(intent.repeat, { frequency: 'weekly', dayOfWeek: 2 });
    assert.equal(intent.dueDate, '2026-08-04');
    assert.equal(describeRepeat(intent.repeat!), 'every Tuesday');
  });

  it('reads relative dates', () => {
    const tomorrow = parseQuickAdd('vacuum the stairs tomorrow', context);
    assert.equal(tomorrow?.kind === 'chore' && tomorrow.dueDate, '2026-08-02');
    const friday = parseQuickAdd('chore clean the garage friday', context);
    assert.equal(friday?.kind === 'chore' && friday.task, 'Clean the garage');
    assert.equal(friday?.kind === 'chore' && friday.dueDate, '2026-08-07');
    const nextSaturday = findDate('mow next saturday', now);
    assert.equal(nextSaturday && dayKey(nextSaturday.date), '2026-08-08');
    const inDays = findDate('in 3 days', now);
    assert.equal(inDays && dayKey(inDays.date), '2026-08-04');
    const monthDay = findDate('on Aug 20', now);
    assert.equal(monthDay && dayKey(monthDay.date), '2026-08-20');
    const pastMonth = findDate('by Jan 5', now);
    assert.equal(pastMonth && dayKey(pastMonth.date), '2027-01-05');
  });

  it('assigns to me and skips non-member "to" phrases', () => {
    const mine = parseQuickAdd('remind me to call the plumber tomorrow for me', context);
    assert.equal(mine?.kind === 'chore' && mine.assignee?.uid, 'owner');
    const curb = parseQuickAdd('take bins to curb today for Morgan', context);
    assert.equal(curb?.kind, 'chore');
    if (curb?.kind !== 'chore') return;
    assert.equal(curb.assignee?.uid, 'morgan');
    assert.equal(curb.task, 'Take bins to curb');
  });
});

describe('shopping quick-add outcomes', () => {
  it('reports per-item outcomes so a retry sends only the failed entries', () => {
    const entries = [{ name: 'Milk', quantity: 1 }, { name: 'Eggs', quantity: 2 }, { name: 'Bread', quantity: 1 }];
    const error = new Error('offline');
    const outcome = shoppingAddOutcome(entries, [
      { status: 'fulfilled', value: 'saved' },
      { status: 'rejected', reason: error },
      { status: 'fulfilled', value: 'queued' },
    ]);
    assert.deepEqual(outcome.saved.map((entry) => entry.name), ['Milk', 'Bread']);
    assert.deepEqual(outcome.failed, [{ name: 'Eggs', quantity: 2 }]);
    assert.equal(outcome.queued, true);
    assert.equal(outcome.firstError, error);
    assert.equal(quickAddRetryMessage(outcome.failed), "Couldn't add Eggs. It is still here; press Confirm to try again.");
    assert.equal(quickAddRetryMessage([]), null);
    const allSaved = shoppingAddOutcome(entries.slice(0, 1), [{ status: 'fulfilled', value: 'saved' }]);
    assert.deepEqual(allSaved, { saved: [entries[0]], failed: [], queued: false });
  });
});

describe('chore assignees and chores.assign', () => {
  const self = context.members[0];
  const sam = context.members[1];

  it('lets members with chores.assign pick anyone', () => {
    const assignable = assignableMembers(context.members, context.viewer, true);
    assert.equal(assignable.length, 3);
    assert.deepEqual(resolveChoreAssignee(sam, assignable, self), { assignee: sam, restricted: false });
  });

  it('restricts members without chores.assign to themselves', () => {
    const assignable = assignableMembers(context.members, context.viewer, false);
    assert.deepEqual(assignable, [self]);
    assert.deepEqual(resolveChoreAssignee(sam, assignable, self), { assignee: self, restricted: true });
    assert.deepEqual(resolveChoreAssignee(null, assignable, self), { assignee: self, restricted: false });
  });
});

describe('parseQuickAdd: maintenance and fallbacks', () => {
  it('recognizes a maintenance log with mileage', () => {
    assert.deepEqual(parseQuickAdd('oil change 48,200 miles', context), { kind: 'maintenance', title: 'Oil change', mileage: 48200 });
  });

  it('needs whole service words', () => {
    assert.equal(parseQuickAdd('log filters replaced', context)?.kind, 'maintenance');
    assert.notEqual(parseQuickAdd('log filtered water', context)?.kind, 'maintenance');
  });

  it('returns null for text it cannot read, so the palette searches instead', () => {
    assert.equal(parseQuickAdd('x', context), null);
    assert.equal(parseQuickAdd('milk', { ...context, lists: [] }), null);
  });
});

describe('keyboard shortcuts', () => {
  const all = () => true;
  const none = (permission?: string) => !permission;

  it('opens the palette with Ctrl/Cmd+K and "/"', () => {
    assert.deepEqual(matchShortcut({ key: 'k', ctrlKey: true }, false, all).action, { type: 'palette' });
    assert.deepEqual(matchShortcut({ key: 'K', metaKey: true }, false, all).action, { type: 'palette' });
    assert.deepEqual(matchShortcut({ key: '/' }, false, all).action, { type: 'palette' });
  });

  it('runs G sequences only for permitted modules', () => {
    const first = matchShortcut({ key: 'g' }, false, all);
    assert.equal(first.pendingGo, true);
    assert.deepEqual(matchShortcut({ key: 'c' }, true, all).action, { type: 'go', href: '/chores' });
    assert.equal(matchShortcut({ key: 'c' }, true, none).action, null);
    assert.deepEqual(matchShortcut({ key: 'h' }, true, none).action, { type: 'go', href: '/' });
  });

  it('maps N, A and F to quick add with permission checks', () => {
    assert.deepEqual(matchShortcut({ key: 'n' }, false, all).action, { type: 'quick-add', prefix: 'chore ' });
    assert.deepEqual(matchShortcut({ key: 'a' }, false, all).action, { type: 'quick-add', prefix: 'add ' });
    assert.equal(matchShortcut({ key: 'f' }, false, none).action, null);
    assert.deepEqual(matchShortcut({ key: '?', shiftKey: true }, false, all).action, { type: 'help' });
    assert.equal(matchShortcut({ key: 'n', altKey: true }, false, all).action, null);
  });

  it('ignores typing targets', () => {
    const input = { closest: (selector: string) => (selector.includes('input') ? {} : null), isContentEditable: false };
    assert.equal(isTypingTarget(input as unknown as EventTarget), true);
    assert.equal(isTypingTarget({ closest: () => null, isContentEditable: false } as unknown as EventTarget), false);
    assert.equal(isTypingTarget(null), false);
  });

  it('detects the Konami code', () => {
    let progress = 0;
    let done = false;
    for (const key of KONAMI) ({ progress, done } = konamiStep(progress, key));
    assert.equal(done, true);
    assert.equal(konamiStep(3, 'x').progress, 0);
  });
});
