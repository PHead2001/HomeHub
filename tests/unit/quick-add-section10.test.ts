import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseQuickAdd, splitItems, looksLikeItems, type QuickAddContext } from '../../src/lib/dashboard/quick-add';
import { mileageInText, portionInText, readMileage } from '../../src/lib/dashboard/quick-add-numbers';
import { householdWallClock } from '../../src/lib/household-zone';
import { recognitionLanguage, voiceAutoPreview, voiceErrorMessage } from '../../src/lib/dashboard/voice';

// Saturday, 1 August 2026, local noon.
const now = new Date(2026, 7, 1, 12, 0, 0);
const context: QuickAddContext = {
  now,
  viewer: { uid: 'owner', email: 'alex@example.test' },
  members: [
    { uid: 'owner', name: 'Alex Owner' },
    { uid: 'sam', name: 'Sam Member' },
    { uid: 'phillip', name: 'Phillip Head' },
  ],
  pets: [{ id: 'rex', name: 'Audit Rex' }, { id: 'maple', name: 'Maple' }, { id: 'oreo', name: 'Oreo' }],
  lists: [{ id: 'groceries', name: 'Groceries', type: 'Grocery' }, { id: 'hardware', name: 'Hardware Run', type: 'Hardware' }],
  rooms: [{ id: 'garage', name: 'Garage' }, { id: 'kitchen', name: 'Kitchen' }],
  vehicles: [{ id: 'civic', name: 'Civic' }],
  assets: [],
};
const parse = (text: string) => parseQuickAdd(text, context);

describe('section 10.1: the sentences that already worked stay right', () => {
  it('shopping', () => {
    for (const [text, names] of [
      ['milk', ['Milk']], ['milk and eggs', ['Milk', 'Eggs']], ['milk, eggs and bread', ['Milk', 'Eggs', 'Bread']],
    ] as const) {
      const intent = parse(text);
      assert.equal(intent?.kind, 'shopping', text);
      if (intent?.kind === 'shopping') assert.deepEqual(intent.items.map((item) => item.name), names);
    }
    const x2 = parse('milk x2');
    assert.deepEqual(x2?.kind === 'shopping' && x2.items, [{ name: 'Milk', quantity: 2 }]);
  });
  it('chores, feedings and maintenance', () => {
    const trash = parse('trash every Tuesday for Phillip');
    assert.ok(trash?.kind === 'chore' && trash.repeat?.frequency === 'weekly' && trash.assignee?.uid === 'phillip');
    const vacuum = parse('vacuum the stairs tomorrow');
    assert.ok(vacuum?.kind === 'chore' && vacuum.dueDate === '2026-08-02' && vacuum.task === 'Vacuum the stairs');
    const mow = parse('mow the lawn every other Saturday');
    assert.ok(mow?.kind === 'chore' && mow.repeat?.frequency === 'biweekly');
    for (const text of ['fed audit rex', 'audit rex ate']) {
      const fed = parse(text);
      assert.ok(fed?.kind === 'feeding' && fed.pet.id === 'rex', text);
    }
    const oil = parse('oil change 48,200 miles');
    assert.ok(oil?.kind === 'maintenance' && oil.mileage === 48_200 && oil.title === 'Oil change');
  });
});

describe('QA-2: no silent grocery fallback', () => {
  it('never guesses a sentence, a room or a member as a grocery item', () => {
    for (const text of ['gave Rex his pill', 'replaced furnace filter', 'need to call the dentist', 'garage', 'xyzzy nothing matches', 'sam']) {
      assert.equal(parse(text), null, text);
    }
  });
  it('keeps short noun phrases as a guess', () => {
    assert.equal(looksLikeItems('paper towels', [{ name: 'Paper towels' }]), true);
    assert.equal(looksLikeItems('we are out of the big blue paper towels', [{ name: 'We are out of the big blue paper towels' }]), false);
    assert.equal(looksLikeItems('one two three four five', [{ name: 'One two three four five' }]), false);
  });
});

describe('QA-3: misparses that wrote wrong data', () => {
  it('reads "k" mileages as thousands', () => {
    const big = parse('oil change 120k miles');
    assert.ok(big?.kind === 'maintenance' && big.mileage === 120_000);
    const bare = parse('oil change 48k');
    assert.ok(bare?.kind === 'maintenance' && bare.mileage === 48_000);
    assert.equal(readMileage('replace 2 filters at 5'), null);
    assert.equal(readMileage('48.2k mi')?.value, 48_200);
  });
  it('turns future-dated maintenance into a chore, never a log done today', () => {
    const intent = parse('oil change tomorrow');
    assert.equal(intent?.kind, 'chore');
    assert.ok(intent?.kind === 'chore' && intent.dueDate === '2026-08-02' && intent.task === 'Oil change');
  });
  it('reads fractions and words that start like months as text, not dates', () => {
    const half = parse('1/2 gallon milk');
    assert.ok(half?.kind === 'shopping' && half.items[0].name === '1/2 gallon milk');
    for (const text of ['decorate 2 cakes', 'marshmallows 2']) assert.notEqual(parse(text)?.kind, 'chore', text);
    const march = parse('vacuum on march 3');
    assert.ok(march?.kind === 'chore' && march.dueDate === '2027-03-03');
  });
  it('lets a date, repeat or person make a shopping verb a chore', () => {
    const intent = parse('pick up dry cleaning for Sam tomorrow');
    assert.ok(intent?.kind === 'chore' && intent.task === 'Pick up dry cleaning' && intent.assignee?.uid === 'sam' && intent.dueDate === '2026-08-02');
    const listed = parse('add milk to the hardware list');
    assert.ok(listed?.kind === 'shopping' && listed.list?.id === 'hardware');
  });
  it('drops "to the list" from the name', () => {
    for (const text of ['add milk to the list', 'add milk to my shopping list']) {
      const intent = parse(text);
      assert.ok(intent?.kind === 'shopping' && intent.items.length === 1 && intent.items[0].name === 'Milk' && intent.list?.id === 'groceries', text);
    }
  });
  it('splits on "and" only between single words or with commas, keeping compound names', () => {
    assert.deepEqual(splitItems('mac and cheese'), [{ name: 'Mac and cheese', quantity: 1 }]);
    assert.deepEqual(splitItems('half and half'), [{ name: 'Half and half', quantity: 1 }]);
    assert.deepEqual(splitItems('mac and cheese, milk and eggs').map((item) => item.name), ['Mac and cheese', 'Milk', 'Eggs']);
    assert.deepEqual(splitItems('dry cleaning and milk').map((item) => item.name), ['Dry cleaning and milk']);
    assert.deepEqual(splitItems('2 milk and eggs'), [{ name: 'Milk', quantity: 2 }, { name: 'Eggs', quantity: 1 }]);
    const add = parse('add mac and cheese');
    assert.ok(add?.kind === 'shopping' && add.items.length === 1);
  });
});

describe('shared numbers for the parser and the AI check (QA-3, QA-7)', () => {
  it('finds mileages the sentence states', () => {
    assert.equal(mileageInText(48_000, 'oil change 48k'), true);
    assert.equal(mileageInText(48_200, 'oil change 48,200 miles'), true);
    assert.equal(mileageInText(120, 'oil change 120k miles'), false);
    assert.equal(mileageInText(50_000, 'oil change'), false);
  });
  it('finds portions the sentence states', () => {
    assert.equal(portionInText(0.5, 'fed rex 1/2 cup'), true);
    assert.equal(portionInText(0.5, 'fed rex 0.5 cups'), true);
    assert.equal(portionInText(1, 'fed rex one can'), true);
    assert.equal(portionInText(2, 'fed rex'), false);
    assert.equal(portionInText(5, 'fed rex 0.5 cups'), false);
  });
});

describe('D-6: the parser reads the household day', () => {
  it('gives the household wall clock, not the device one', () => {
    // 03:30 UTC on 2 August is still 1 August in Los Angeles and already 2 August in Tokyo.
    const instant = new Date(Date.UTC(2026, 7, 2, 3, 30));
    const la = householdWallClock('America/Los_Angeles', instant);
    const tokyo = householdWallClock('Asia/Tokyo', instant);
    assert.deepEqual([la.getMonth(), la.getDate(), la.getHours()], [7, 1, 20]);
    assert.deepEqual([tokyo.getMonth(), tokyo.getDate(), tokyo.getHours()], [7, 2, 12]);
  });
});

describe('QA-16, QA-22: voice', () => {
  it('asks recognition for English, the language the parser reads', () => {
    assert.equal(recognitionLanguage('en-GB'), 'en-GB');
    assert.equal(recognitionLanguage('en'), 'en');
    assert.equal(recognitionLanguage('de-DE'), 'en-US');
    assert.equal(recognitionLanguage(undefined), 'en-US');
  });
  it('explains errors plainly', () => {
    assert.match(voiceErrorMessage('not-allowed'), /blocked/);
    assert.match(voiceErrorMessage('no-speech'), /Did not catch/);
  });
  it('opens the preview at once only for an explicit intent', () => {
    assert.equal(voiceAutoPreview(parse('vacuum the stairs tomorrow')), true);
    assert.equal(voiceAutoPreview(parse('fed audit rex')), true);
    assert.equal(voiceAutoPreview(parse('add milk')), true);
    assert.equal(voiceAutoPreview(parse('milk and eggs')), false);
    assert.equal(voiceAutoPreview(null), false);
  });
});
