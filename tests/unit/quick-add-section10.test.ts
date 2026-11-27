import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseQuickAdd, splitItems, looksLikeItems, namedPets, foodFromText, type QuickAddContext } from '../../src/lib/dashboard/quick-add';
import { canSplitChip, describeIntent, joinChips, removeChip, splitChip } from '../../src/lib/dashboard/quick-add-preview';
import { mileageInText, portionInText, readMileage } from '../../src/lib/dashboard/quick-add-numbers';
import { householdWallClock } from '../../src/lib/household-zone';
import { groupContiguous, resultsAnnouncement, indexCacheKey, recentUse, searchScore, withinOneEdit } from '../../src/lib/dashboard/command-search';
import { redactPersonal } from '../../src/ai/redact';
import { choreUndoPlan, itemUndoPlan, parseItemUndos, QUICK_ADD_UNDO_GRACE_MS } from '../../src/lib/dashboard/quick-add-undo';
import { intentFromAiParse, mentionsDay, buildAiParseRequest } from '../../src/lib/dashboard/quick-add-ai';
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
    { uid: 'jose', name: 'José Díaz' },
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

describe('QA-2: a sentence that names its list is never filtered as a guess', () => {
  it('keeps "milk to my groceries" and "milk on our groceries"', () => {
    for (const text of ['milk to my groceries', 'milk on our groceries']) {
      const intent = parse(text);
      assert.ok(intent?.kind === 'shopping' && intent.explicit && intent.list?.id === 'groceries' && intent.items[0].name === 'Milk', text);
    }
    // Without the list it is still a sentence, not a guess.
    assert.equal(parse('gave Rex his pill'), null);
  });
});

describe('QA-3: a date followed by a room keeps its day', () => {
  it('reads "on March 3 in the kitchen" and "8/20 in the kitchen" as dates', () => {
    const named = parse('chore vacuum on March 3 in the kitchen');
    assert.ok(named?.kind === 'chore' && named.dueDate === '2027-03-03' && named.task === 'Vacuum' && named.room?.id === 'kitchen');
    for (const text of ['chore vacuum 8/20 in the kitchen', 'chore vacuum 8/20 in kitchen', 'chore vacuum 8/20 in our garage']) {
      const numeric = parse(text);
      assert.ok(numeric?.kind === 'chore' && numeric.dueDate === '2026-08-20' && numeric.task.startsWith('Vacuum'), text);
    }
  });
  it('still reads inches and other units as fractions', () => {
    for (const text of ['1/2 in pipe', '1/2 gallon milk', '3/4 inch screws']) {
      const intent = parse(text);
      assert.ok(intent?.kind === 'shopping', text);
    }
  });
});
describe('QA-4: repeats, pets and names', () => {
  it('reads the day in "every week on Saturday" and "every month on the 15th"', () => {
    const weekly = parse('clean the gutters every week on Saturday');
    assert.ok(weekly?.kind === 'chore' && weekly.repeat?.frequency === 'weekly' && weekly.repeat.dayOfWeek === 6 && weekly.task === 'Clean the gutters');
    const monthly = parse('pay rent every month on the 15th');
    assert.ok(monthly?.kind === 'chore' && monthly.repeat?.frequency === 'monthly' && monthly.repeat.dayOfMonth === 15 && monthly.dueDate === '2026-08-15' && monthly.task === 'Pay rent');
    const late = parse('pay rent on the 31st of every month');
    assert.ok(late?.kind === 'chore' && late.repeat?.frequency === 'monthly' && late.repeat.dayOfMonth === 28 && Boolean(late.repeatNote));
  });
  it('repeats "every weekend" and plural weekdays', () => {
    const weekend = parse('vacuum every weekend');
    assert.ok(weekend?.kind === 'chore' && weekend.repeat?.frequency === 'weekly' && weekend.repeat.dayOfWeek === 6 && weekend.task === 'Vacuum');
    const tuesdays = parse('water plants on Tuesdays');
    assert.ok(tuesdays?.kind === 'chore' && tuesdays.repeat?.frequency === 'weekly' && tuesdays.repeat.dayOfWeek === 2 && tuesdays.task === 'Water plants');
  });
  it('removes exactly the repeat it matched', () => {
    const intent = parse('rake every bit of the yard every Tuesday');
    assert.ok(intent?.kind === 'chore' && intent.task === 'Rake every bit of the yard' && intent.repeat?.frequency === 'weekly');
    const other = parse('mop every other Friday');
    assert.ok(other?.kind === 'chore' && other.task === 'Mop' && other.repeat?.frequency === 'biweekly');
  });
  it('matches part of a pet name, every named pet, and the food', () => {
    const rex = parse('fed Rex');
    assert.ok(rex?.kind === 'feeding' && rex.pet.id === 'rex');
    const both = parse('fed Maple and Oreo');
    assert.ok(both?.kind === 'feeding' && both.pet.id === 'maple' && both.alsoPets?.[0]?.id === 'oreo');
    assert.deepEqual(namedPets('rex', [{ id: 'a', name: 'Audit Rex' }, { id: 'b', name: 'Rex Junior' }]), []);
    const wet = parse('fed audit rex wet food');
    assert.ok(wet?.kind === 'feeding' && wet.food === 'Wet');
    assert.equal(foodFromText('kibble'), 'Dry');
    assert.equal(foodFromText('wet and dry'), 'Mix');
    assert.match(describeIntent(wet!, null).detail, /wet food/);
  });
  it('assigns accented names, typed with or without accents', () => {
    for (const text of ['vacuum tomorrow for José', 'vacuum tomorrow for jose']) {
      const intent = parse(text);
      assert.ok(intent?.kind === 'chore' && intent.assignee?.uid === 'jose', text);
    }
  });
});

describe('QA-19: editable preview chips', () => {
  const items = [{ name: 'Dry cleaning and milk', quantity: 1 }, { name: 'Eggs', quantity: 2 }];
  it('splits, removes and joins', () => {
    assert.equal(canSplitChip(items[0]), true);
    assert.deepEqual(splitChip(items, 0).map((item) => item.name), ['Dry cleaning', 'Milk', 'Eggs']);
    assert.deepEqual(removeChip(items, 1), [items[0]]);
    assert.deepEqual(removeChip([items[1]], 0), [items[1]]);
    assert.deepEqual(joinChips([{ name: 'Mac', quantity: 1 }, { name: 'Cheese', quantity: 1 }]), [{ name: 'Mac and cheese', quantity: 1 }]);
  });
});

describe('QA-11: matching', () => {
  it('scores every word across label, detail and keywords', () => {
    assert.ok(searchScore({ label: 'Take out trash', detail: 'Sam Member · Kitchen' }, 'sam') > 0);
    assert.ok(searchScore({ label: 'Take out trash', detail: 'Sam Member · Kitchen' }, 'trash kitchen') > 0);
    assert.equal(searchScore({ label: 'Take out trash', detail: 'Sam Member' }, 'trash garage'), 0);
    assert.ok(searchScore({ label: 'Civic', detail: '2019 Honda Civic', keywords: 'vehicle car' }, 'honda') > 0);
    assert.ok(searchScore({ label: 'Appearance', keywords: 'dark mode theme' }, 'dark mode') > 0);
  });
  it('allows one typo in longer words, and ranks label and prefix matches higher', () => {
    assert.equal(withinOneEdit('mlik', 'milk'), true);
    assert.equal(withinOneEdit('dishwaser', 'dishwasher'), true);
    assert.equal(withinOneEdit('milk', 'mint'), false);
    assert.ok(searchScore({ label: 'Dishwasher' }, 'dishwaser') > 0);
    assert.equal(searchScore({ label: 'Mint' }, 'milk'), 0);
    assert.ok(searchScore({ label: 'Milk' }, 'milk') > searchScore({ label: 'Oat milk' }, 'milk'));
    assert.ok(searchScore({ label: 'Milk' }, 'mil') > searchScore({ label: 'Chips', detail: 'Milk run' }, 'mil'));
  });
  it('boosts what is used often and lately', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    const uses = recentUse(storage, 'k');
    const now = Date.UTC(2026, 7, 1);
    uses.record(['milk'], now - 30 * 86_400_000);
    uses.record(['eggs'], now);
    uses.record(['eggs'], now);
    assert.deepEqual(uses.top(2, now), ['eggs', 'milk']);
    assert.ok(uses.boost('eggs', now) > uses.boost('milk', now));
    assert.equal(uses.boost('bread', now), 0);
    assert.deepEqual(recentUse({ getItem: () => 'not json', setItem: () => undefined }, 'k').top(3), []);
  });
});

describe('QA-5 and QA-12: grouping and the index cache key', () => {
  it('keeps each group together, in order of its best option', () => {
    const options = [{ id: 'a', group: 'Chores' }, { id: 'b', group: 'Shopping' }, { id: 'c', group: 'Chores' }, { id: 'd', group: 'Go to' }];
    assert.deepEqual(groupContiguous(options).map((option) => option.id), ['a', 'c', 'b', 'd']);
  });
  it('keys the cache by household, person and permissions', () => {
    const one = indexCacheKey('h1', 'u1', { 'chores.view': true, 'pets.view': false });
    assert.equal(one, indexCacheKey('h1', 'u1', { 'pets.view': false, 'chores.view': true }));
    assert.notEqual(one, indexCacheKey('h1', 'u2', { 'chores.view': true }));
    assert.notEqual(one, indexCacheKey('h1', 'u1', { 'chores.view': true, 'pets.view': true }));
  });
});

describe('QA-4: the e2e AI-fallback sentence stays with the AI reader', () => {
  it('reads "on tuesdays" itself, and leaves the e2e sentence unread', () => {
    // tests/e2e/shell-wave4.spec.ts used this sentence to reach "Read with AI"; the parser now reads it.
    assert.equal(parse('could sam deal with the recycling on tuesdays')?.kind, 'chore');
    // The spec's sentence: no whole weekday word, a pronoun-free verb phrase the guess filter rejects.
    assert.equal(parse('could sam deal with the recycling, a tuesdayish job'), null);
  });
});

describe('QA-7: redaction and refusing unstated days', () => {
  it('redacts phones and street addresses, never odometer readings', () => {
    assert.equal(redactPersonal('call 555-123-4567 about it'), 'call a phone number about it');
    assert.equal(redactPersonal('ring (555) 123 4567'), 'ring a phone number');
    assert.equal(redactPersonal('ring +15551234567 now'), 'ring a phone number now');
    assert.equal(redactPersonal('pick up at 12 Oak Street tomorrow'), 'pick up at an address tomorrow');
    assert.equal(redactPersonal('mail sam@example.test'), 'mail a member');
    assert.equal(redactPersonal('oil change 48200 miles at 1234567'), 'oil change 48200 miles at 1234567');
    assert.equal(buildAiParseRequest('call 555-123-4567 tomorrow', context).input.text, 'call a phone number tomorrow');
  });
  it('refuses an AI chore with no date when the sentence talked about a day', () => {
    assert.equal(mentionsDay('could someone call the vet next week'), true);
    assert.equal(mentionsDay('could someone call the vet'), false);
    const refs = buildAiParseRequest('x', context).refs;
    assert.equal(intentFromAiParse({ kind: 'chore', chore: { task: 'Call the vet' } }, refs, context, 'call the vet sometime next week'), null);
    assert.equal(intentFromAiParse({ kind: 'chore', chore: { task: 'Call the vet' } }, refs, context, 'call the vet')?.kind, 'chore');
  });
});

describe('QA-20: announcements', () => {
  it('announces the top quick add and the count', () => {
    assert.equal(resultsAnnouncement([{ group: 'Quick add', label: 'Add Milk', detail: 'to Groceries' }, { group: 'Go to', label: 'Shopping' }]), 'Quick add: Add Milk, to Groceries. 2 results.');
    assert.equal(resultsAnnouncement([{ group: 'Go to', label: 'Home' }]), '1 result.');
    assert.equal(resultsAnnouncement([]), 'No results.');
  });
});

describe('QA-9: what quick-add Undo may take back', () => {
  const now = 1_000_000_000;
  const fresh = now - 5_000;
  it('deletes a fresh item the member added, or takes off only their quantity', () => {
    const item = { exists: true, addedByUid: 'sam', status: 'needed', quantity: 1, createdMs: fresh };
    assert.deepEqual(itemUndoPlan(item, { itemId: 'i', merged: false, quantity: 1 }, 'sam', now), { action: 'delete' });
    assert.deepEqual(itemUndoPlan({ ...item, quantity: 3 }, { itemId: 'i', merged: false, quantity: 1 }, 'sam', now), { action: 'decrement', by: 1 });
  });
  it('keeps what is not theirs, too old, bought, gone or changed', () => {
    const item = { exists: true, addedByUid: 'sam', status: 'needed', quantity: 1, createdMs: fresh };
    const ask = { itemId: 'i', merged: false, quantity: 1 };
    assert.equal(itemUndoPlan({ ...item, addedByUid: 'alex' }, ask, 'sam', now).action, 'keep');
    assert.equal(itemUndoPlan({ ...item, createdMs: now - QUICK_ADD_UNDO_GRACE_MS - 1 }, ask, 'sam', now).action, 'keep');
    assert.equal(itemUndoPlan({ ...item, createdMs: null }, ask, 'sam', now).action, 'keep');
    assert.equal(itemUndoPlan({ ...item, status: 'purchased' }, ask, 'sam', now).action, 'keep');
    assert.equal(itemUndoPlan({ exists: false }, ask, 'sam', now).action, 'keep');
    assert.equal(itemUndoPlan({ ...item, quantity: 1 }, { ...ask, quantity: 2 }, 'sam', now).action, 'keep');
  });
  it('takes a merge back off while more than that remains', () => {
    const merged = { exists: true, addedByUid: 'alex', status: 'needed', quantity: 3, createdMs: now - 86_400_000 };
    assert.deepEqual(itemUndoPlan(merged, { itemId: 'i', merged: true, quantity: 2 }, 'sam', now), { action: 'decrement', by: 2 });
    assert.equal(itemUndoPlan({ ...merged, quantity: 2 }, { itemId: 'i', merged: true, quantity: 2 }, 'sam', now).action, 'keep');
  });
  it('removes only a fresh, open, quick one-time chore the member added', () => {
    const chore = { exists: true, createdByUid: 'sam', sourceType: 'temporary', isCompleted: false, createdMs: fresh };
    assert.deepEqual(choreUndoPlan(chore, 'sam', now), { action: 'delete' });
    assert.equal(choreUndoPlan({ ...chore, isCompleted: true }, 'sam', now).action, 'keep');
    assert.equal(choreUndoPlan({ ...chore, createdByUid: 'alex' }, 'sam', now).action, 'keep');
    assert.equal(choreUndoPlan({ ...chore, sourceType: 'template' }, 'sam', now).action, 'keep');
    assert.equal(choreUndoPlan({ ...chore, createdMs: now - QUICK_ADD_UNDO_GRACE_MS - 1 }, 'sam', now).action, 'keep');
  });
  it('validates the request', () => {
    assert.deepEqual(parseItemUndos([{ itemId: 'a', merged: false, quantity: 2 }]), [{ itemId: 'a', merged: false, quantity: 2 }]);
    for (const bad of [[], [{ itemId: 'a/b', merged: false, quantity: 1 }], [{ itemId: 'a', merged: 'no', quantity: 1 }], [{ itemId: 'a', merged: false, quantity: 0 }], 'x', Array.from({ length: 21 }, () => ({ itemId: 'a', merged: false, quantity: 1 }))]) {
      assert.equal(parseItemUndos(bad), null);
    }
  });
});
