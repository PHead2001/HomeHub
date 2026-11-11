import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { bareCommandVerb, parseQuickAdd, type QuickAddContext } from '../../src/lib/dashboard/quick-add';
import {
  MODE_COPY,
  MODE_PERMISSION,
  bareVerbOffer,
  choreModeIntent,
  feedingModeState,
  itemModeIntent,
  itemModeLists,
  itemModeState,
  modeBlocker,
  type PaletteMode,
} from '../../src/lib/dashboard/palette-mode';
import { SHORTCUTS, matchShortcut } from '../../src/lib/dashboard/shortcuts';

// Saturday, 1 August 2026, local noon.
const now = new Date(2026, 7, 1, 12, 0, 0);
const maple = { id: 'maple', name: 'Maple' };
const oreo = { id: 'oreo', name: 'Oreo', portion: { amount: 2, unit: 'Cans' as const } };

const context: QuickAddContext = {
  now,
  viewer: { uid: 'owner', email: 'alex@example.test' },
  members: [
    { uid: 'owner', email: 'alex@example.test', name: 'Alex Owner' },
    { uid: 'sam', email: 'sam.member@example.test', name: 'Sam Member' },
  ],
  pets: [maple, oreo],
  lists: [
    { id: 'groceries', name: 'Groceries', type: 'Grocery' },
    { id: 'costco', name: 'Costco', type: 'Grocery' },
    { id: 'hardware', name: 'Hardware Run', type: 'Hardware' },
  ],
  rooms: [{ id: 'kitchen', name: 'Kitchen' }],
};

const everything = () => true;
const nothing = () => false;

describe('QA-1: a bare command verb is never an entry', () => {
  const bare = ['fed', 'feed', 'Fed', 'FEED', 'fed ', ' feed  ', 'fed.', 'I fed', 'feeding', 'add', 'Add ', 'ADD', 'buy', 'get', 'need', 'we need', 'pick up', 'chore', 'Chore ', 'task', 'todo', 'remind me to'];
  for (const text of bare) {
    it(`"${text}" has no quick-add suggestion`, () => {
      assert.equal(parseQuickAdd(text, context), null);
      // Not even with only a grocery list and no pets (the old fallback path).
      assert.equal(parseQuickAdd(text, { ...context, pets: [], lists: [{ id: 'g', name: 'Groceries', type: 'Grocery' }] }), null);
    });
  }

  it('names the kind each bare verb asks for', () => {
    assert.equal(bareCommandVerb('fed '), 'feeding');
    assert.equal(bareCommandVerb('Feed'), 'feeding');
    assert.equal(bareCommandVerb('add '), 'item');
    assert.equal(bareCommandVerb('we need'), 'item');
    assert.equal(bareCommandVerb('chore '), 'chore');
    assert.equal(bareCommandVerb('fed maple'), null);
    assert.equal(bareCommandVerb('add milk'), null);
    assert.equal(bareCommandVerb('feeder'), null);
    assert.equal(bareCommandVerb('address book'), null);
    assert.equal(bareCommandVerb(''), null);
  });

  it('a verb followed by a real item, pet or chore still parses', () => {
    const feeding = parseQuickAdd('fed Maple', context);
    assert.equal(feeding?.kind, 'feeding');
    assert.equal(feeding?.kind === 'feeding' && feeding.pet.id, 'maple');
    const mixed = parseQuickAdd('FEED oreo', context);
    assert.equal(mixed?.kind === 'feeding' && mixed.pet.id, 'oreo');
    const shopping = parseQuickAdd('Add milk', context);
    assert.equal(shopping?.kind, 'shopping');
    assert.deepEqual(shopping?.kind === 'shopping' && shopping.items, [{ name: 'Milk', quantity: 1 }]);
    const chore = parseQuickAdd('chore vacuum', context);
    assert.equal(chore?.kind === 'chore' && chore.task, 'Vacuum');
    // Words that only start with a verb are ordinary items.
    const feeder = parseQuickAdd('add bird feeder', context);
    assert.deepEqual(feeder?.kind === 'shopping' && feeder.items, [{ name: 'Bird feeder', quantity: 1 }]);
  });
});

describe('QA-1: what a bare verb offers instead', () => {
  it('bare fed with one pet offers just that pet', () => {
    const offer = bareVerbOffer('fed ', [maple], everything);
    assert.equal(offer?.kind, 'feed');
    if (offer?.kind !== 'feed') return;
    assert.deepEqual(offer.intents, [{ kind: 'feeding', pet: maple, amount: null, unit: null }]);
  });

  it('bare feed with several pets offers each pet as a choice', () => {
    const offer = bareVerbOffer('Feed', [maple, oreo], everything);
    assert.equal(offer?.kind, 'feed');
    if (offer?.kind !== 'feed') return;
    assert.deepEqual(offer.intents.map((intent) => intent.pet.id), ['maple', 'oreo']);
  });

  it('offers nothing without pets or without permission to log feedings', () => {
    assert.deepEqual(bareVerbOffer('fed', [], everything), { kind: 'none' });
    assert.deepEqual(bareVerbOffer('fed', [maple], nothing), { kind: 'none' });
    assert.deepEqual(bareVerbOffer('fed', [maple], (mode) => mode !== 'feeding'), { kind: 'none' });
  });

  it('bare add and chore offer their modes, when permitted', () => {
    assert.deepEqual(bareVerbOffer('add ', [], everything), { kind: 'mode', mode: 'item' });
    assert.deepEqual(bareVerbOffer('Chore', [], everything), { kind: 'mode', mode: 'chore' });
    assert.deepEqual(bareVerbOffer('add', [], nothing), { kind: 'none' });
  });

  it('is null for anything more than a verb (the parser reads it)', () => {
    assert.equal(bareVerbOffer('fed Maple', [maple], everything), null);
    assert.equal(bareVerbOffer('add milk', [], everything), null);
    assert.equal(bareVerbOffer('', [], everything), null);
  });
});

describe('QA-15: modes replace typed prefixes', () => {
  it('N, A and F open Chore, Item and Feeding mode; no shortcut carries text', () => {
    assert.deepEqual(matchShortcut({ key: 'n' }, false, everything).action, { type: 'quick-add', mode: 'chore' });
    assert.deepEqual(matchShortcut({ key: 'a' }, false, everything).action, { type: 'quick-add', mode: 'item' });
    assert.deepEqual(matchShortcut({ key: 'f' }, false, everything).action, { type: 'quick-add', mode: 'feeding' });
    assert.equal(matchShortcut({ key: 'f' }, false, nothing).action, null);
    for (const shortcut of SHORTCUTS) assert.equal('prefix' in shortcut.action, false, shortcut.id);
  });

  it('each shortcut is gated by the permission its mode writes with', () => {
    for (const shortcut of SHORTCUTS) {
      if (shortcut.action.type !== 'quick-add') continue;
      assert.equal(shortcut.permission, MODE_PERMISSION[shortcut.action.mode], shortcut.id);
    }
  });

  it('no caller opens the palette with typed text any more', () => {
    const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
    for (const file of ['src/components/dashboard/bento-grid.tsx', 'src/components/mobile-tab-bar.tsx', 'src/components/command/command-center.tsx']) {
      assert.doesNotMatch(read(file), /openCommandPalette\(\{\s*text|openPalette\(\{\s*text|text: '(?:fed|add|chore) '/, file);
    }
    assert.match(read('src/components/command/events.ts'), /PaletteRequest = \{ mode\?: PaletteMode; voice\?: boolean \}/);
  });

  it('the Feeding buttons use the shared one-tap feed action, not a second writer', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/command/palette-modes.tsx'), 'utf8');
    assert.match(source, /useFeedAction\(/);
    assert.match(source, /<FeedAgainDialog/);
    assert.doesNotMatch(source, /feedPet\(|addDoc\(|<input[^>]*data-testid="palette-feed/);
    // Feeding mode renders no text field (no on-screen keyboard on the wall tablet).
    const feeding = source.slice(source.indexOf('export function FeedingMode'), source.indexOf('function FeedPetButton'));
    assert.doesNotMatch(feeding, /<input|autoFocus/);
  });
});

describe('QA-15: mode permissions and states', () => {
  const modes: PaletteMode[] = ['feeding', 'item', 'chore'];

  it('a mode without its permission explains why', () => {
    for (const mode of modes) {
      assert.equal(modeBlocker(mode, { [MODE_PERMISSION[mode]]: true }), null);
      assert.equal(modeBlocker(mode, {}), MODE_COPY[mode].denied);
      assert.match(MODE_COPY[mode].denied, /^You can't .+ admin/);
    }
  });

  it('Feeding: denied, loading, failed, empty and ready', () => {
    const base = { canFeed: true, canViewPets: true, loading: false, failed: false, pets: [maple, oreo] };
    assert.deepEqual(feedingModeState({ ...base, canFeed: false }), { status: 'denied', message: MODE_COPY.feeding.denied });
    assert.equal(feedingModeState({ ...base, canViewPets: false }).status, 'denied');
    assert.deepEqual(feedingModeState({ ...base, loading: true }), { status: 'loading' });
    assert.equal(feedingModeState({ ...base, failed: true }).status, 'failed');
    assert.equal(feedingModeState({ ...base, pets: [] }).status, 'empty');
    assert.deepEqual(feedingModeState(base), { status: 'ready', pets: [maple, oreo] });
    assert.deepEqual(feedingModeState({ ...base, pets: [maple] }), { status: 'ready', pets: [maple] });
  });

  it('Item: denied, loading, failed, empty and ready with the Grocery lists to pick from', () => {
    const base = { canAdd: true, canViewLists: true, loading: false, failed: false, lists: context.lists };
    assert.deepEqual(itemModeState({ ...base, canAdd: false }), { status: 'denied', message: MODE_COPY.item.denied });
    assert.equal(itemModeState({ ...base, canViewLists: false }).status, 'denied');
    assert.deepEqual(itemModeState({ ...base, loading: true }), { status: 'loading' });
    assert.equal(itemModeState({ ...base, failed: true }).status, 'failed');
    assert.equal(itemModeState({ ...base, lists: [] }).status, 'empty');
    const ready = itemModeState(base);
    assert.equal(ready.status, 'ready');
    if (ready.status !== 'ready') return;
    assert.deepEqual(ready.choices.map((list) => list.id), ['groceries', 'costco']);
    assert.equal(ready.initial?.id, 'groceries');
  });

  it('Item lists: every list when there is no Grocery list; none when there are no lists', () => {
    const hardware = { id: 'hardware', name: 'Hardware Run', type: 'Hardware' };
    assert.deepEqual(itemModeLists([hardware]), { choices: [hardware], initial: hardware });
    assert.deepEqual(itemModeLists([]), { choices: [], initial: null });
  });
});

describe('QA-15: Item and Chore mode entries', () => {
  const groceries = context.lists[0];
  const costco = context.lists[1];

  it('Item mode adds the typed items to the chosen list', () => {
    assert.deepEqual(itemModeIntent('milk, 2 eggs and bread', costco), {
      kind: 'shopping',
      items: [{ name: 'Milk', quantity: 1 }, { name: 'Eggs', quantity: 2 }, { name: 'Bread', quantity: 1 }],
      list: costco,
      explicit: true,
    });
    // A leading verb is dropped, any case.
    assert.deepEqual(itemModeIntent('ADD milk', groceries)?.items, [{ name: 'Milk', quantity: 1 }]);
  });

  it('Item mode refuses a bare verb, nothing typed, or no list', () => {
    assert.equal(itemModeIntent('add', groceries), null);
    assert.equal(itemModeIntent('Add ', groceries), null);
    assert.equal(itemModeIntent('fed', groceries), null);
    assert.equal(itemModeIntent('   ', groceries), null);
    assert.equal(itemModeIntent('milk', null), null);
  });

  it('Chore mode reads the text as a chore without a chore word', () => {
    const chore = choreModeIntent('vacuum Friday for Sam', context);
    assert.equal(chore?.kind, 'chore');
    assert.equal(chore?.task, 'Vacuum');
    assert.equal(chore?.assignee?.uid, 'sam');
    assert.equal(chore?.dueDate, '2026-08-07');
    assert.equal(choreModeIntent('wipe counters', context)?.dueDate, '2026-08-01');
    // Typing the chore word too does not double it.
    assert.equal(choreModeIntent('chore take out trash', context)?.task, 'Take out trash');
  });

  it('Chore mode refuses a bare verb or nothing typed', () => {
    assert.equal(choreModeIntent('chore', context), null);
    assert.equal(choreModeIntent('add ', context), null);
    assert.equal(choreModeIntent('  ', context), null);
  });
});
