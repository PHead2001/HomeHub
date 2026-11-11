import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { computeShoppingFacts, SHOPPING_TILE_ITEMS } from '../../src/lib/dashboard/facts';
import {
  focusAfterTick,
  reconcileTickStates,
  shoppingRowKey,
  TICK_DONE_STATES,
  shoppingTileRows,
  wideTickRows,
  WIDE_TICK_ROW_STEPS,
  type TickRowState,
} from '../../src/lib/dashboard/shopping-tile';
import { emptyDoneTracking, setDoneState, settleDone, type DoneTracking } from '../../src/lib/dashboard/done-states';

const item = (id: string, listId = 'weekly', quantity = 1) => ({ id, name: id, listId, listName: listId, quantity });

describe('dashboard Shopping tile rows (HP-36a, HP-33c)', () => {
  test('the facts keep the first six needed items with their quantity, never a purchased one', () => {
    const needed = Array.from({ length: 9 }, (_, index) => ({ id: `n${index}`, name: `Item ${index}`, status: 'needed', quantity: index === 0 ? 6 : undefined, createdAt: new Date(2026, 6, index + 1) }));
    const facts = computeShoppingFacts([{ id: 'weekly', name: 'Weekly' }], { weekly: [...needed, { id: 'bought', name: 'Bought', status: 'purchased' }] });
    assert.equal(SHOPPING_TILE_ITEMS, 6);
    assert.equal(facts.neededItems, 9);
    assert.deepEqual(facts.firstItems.map((entry) => entry.id), ['n0', 'n1', 'n2', 'n3', 'n4', 'n5']);
    assert.equal(facts.firstItems[0].quantity, 6);
    assert.equal(facts.firstItems[1].quantity, 1);
  });

  test('rows, "+N more" and list names only when the rows span lists', () => {
    const one = shoppingTileRows([item('a'), item('b')], 5);
    assert.equal(one.rows.length, 2);
    assert.equal(one.more, 3);
    assert.equal(one.showLists, false);
    const two = shoppingTileRows([item('a'), item('b', 'hardware')], 2);
    assert.equal(two.more, 0);
    assert.equal(two.showLists, true);
    assert.notEqual(shoppingRowKey(item('a')), shoppingRowKey(item('a', 'hardware')));
  });

  test('beside the house: one tick row up to 60rem of screen height, two from 60rem, three from 66rem', () => {
    assert.equal(wideTickRows(768), 1);
    assert.equal(wideTickRows(800), 1);
    assert.equal(wideTickRows(864), 1);
    assert.equal(wideTickRows(959), 1);
    assert.equal(wideTickRows(960), 2);
    assert.equal(wideTickRows(1080), 3);
  });

  test('the CSS applies the same height steps', () => {
    const css = readFileSync(new URL('../../src/components/dashboard/dashboard.module.css', import.meta.url), 'utf8');
    assert.match(css, /\.tileGrid \.shoppingRows > :nth-child\(n \+ 2\) \{\s*display: none;/);
    for (const step of WIDE_TICK_ROW_STEPS.slice(1)) {
      const rule = new RegExp(`\\(min-height: ${step.minHeightRem}rem\\) \\{\\s*\\.tileGrid \\.shoppingRows > :nth-child\\(${step.rows}\\) \\{\\s*display: flex;`);
      assert.match(css, rule, `row ${step.rows} from ${step.minHeightRem}rem`);
    }
  });
});

describe('dashboard Shopping tick states follow the live list (HP-33d)', () => {
  const start = (states: Record<string, TickRowState>): DoneTracking<TickRowState> => ({ states, gone: new Set(), returned: new Set() });

  test('a row ticked here that already left the list (queued write shown at once) is remembered as gone', () => {
    const next = reconcileTickStates(start({ 'weekly/milk': 'done' }), ['weekly/eggs']);
    assert.equal(next.states['weekly/milk'], 'done');
    assert.ok(next.gone.has('weekly/milk'));
    // Running again (the effect also runs on state changes) settles: same tracking back.
    assert.equal(reconcileTickStates(next, ['weekly/eggs']), next);
  });

  test('an item un-ticked elsewhere (or restored by Undo) gets an enabled control again', () => {
    let tracking = reconcileTickStates(start({ 'weekly/milk': 'done' }), []);
    tracking = reconcileTickStates(tracking, ['weekly/milk']);
    assert.equal(tracking.states['weekly/milk'], undefined);
  });

  test('a failed tick keeps its Retry when the row comes back; a saving row keeps saving', () => {
    const tracking = reconcileTickStates(start({ 'weekly/milk': 'failed', 'weekly/eggs': 'saving' }), ['weekly/milk']);
    assert.equal(tracking.states['weekly/milk'], 'failed');
    assert.equal(tracking.states['weekly/eggs'], 'saving');
  });

  test('un-ticked elsewhere after the tick reached the server but before its answer: the tick works again (review finding on #150)', () => {
    const key = 'weekly/milk';
    let tracking = setDoneState(emptyDoneTracking<TickRowState>(), key, 'saving');
    tracking = reconcileTickStates(tracking, []); // the queued tick shows at once
    tracking = reconcileTickStates(tracking, [key]); // un-ticked on another device
    assert.equal(tracking.states[key], 'saving');
    tracking = settleDone(tracking, key, TICK_DONE_STATES); // the tick's answer (or the 4 s timeout)
    assert.equal(tracking.states[key], undefined, 'not left disabled as done');
  });

  test('the usual tick: the row leaves while saving, reads done, and an un-tick later re-enables it', () => {
    const key = 'weekly/milk';
    let tracking = setDoneState(emptyDoneTracking<TickRowState>(), key, 'saving');
    tracking = reconcileTickStates(tracking, ['weekly/eggs']);
    tracking = settleDone(tracking, key, TICK_DONE_STATES);
    assert.equal(tracking.states[key], 'done');
    tracking = reconcileTickStates(tracking, ['weekly/eggs', key]);
    assert.equal(tracking.states[key], undefined);
  });

  test('an Undo that finished before the tick was acknowledged is not overwritten by the late tick answer', () => {
    const key = 'weekly/milk';
    let tracking = setDoneState(emptyDoneTracking<TickRowState>(), key, 'saving');
    tracking = setDoneState(tracking, key, null); // Undo restored it
    tracking = settleDone(tracking, key, TICK_DONE_STATES);
    assert.equal(tracking.states[key], undefined);
  });

  test('focus after a tick: the next visible row, else the previous one, else the tile link', () => {
    assert.equal(focusAfterTick(['a', 'b', 'c'], 'b'), 'c');
    assert.equal(focusAfterTick(['a', 'b', 'c'], 'c'), 'b');
    assert.equal(focusAfterTick(['a'], 'a'), null);
    assert.equal(focusAfterTick(['a'], 'x'), null);
  });
});

describe('HP-33c: one tick operation, two callers', () => {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

  test('the dashboard tile ticks and undoes through the shared operation, never by writing itself', () => {
    const source = read('src/components/dashboard/shopping-tick.tsx');
    assert.match(source, /tickShoppingItem\(shoppingTickIO/);
    assert.match(source, /undoShoppingTick\(shoppingTickIO/);
    assert.match(source, /group: 'shopping-tick'/);
    assert.match(source, /duration: UNDO_WINDOW_MS/);
    assert.doesNotMatch(source, /firebase\/firestore|updateDoc\(|tickUpdate\(/, 'no second tick writer');
  });

  test('the Shopping page ticks and undoes through the same operation', () => {
    const source = read('src/components/shopping-list-client.tsx');
    assert.match(source, /tickShoppingItem\(shoppingTickIO/);
    assert.match(source, /undoShoppingTick\(shoppingTickIO/);
    assert.doesNotMatch(source, /\btickUpdate\(|\bundoTickUpdate\(/, 'no second tick writer');
  });
});
