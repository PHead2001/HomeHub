import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { aisleChips, aisleTargetIds, filterAisleGroups, findHint, findQuery, leftLabel } from '../../src/lib/shopping/trip-mode';
import { keyboardInset } from '../../src/lib/keyboard-inset';
import { createWakeLockController, wakeLockWanted, type WakeLockSentinelLike } from '../../src/lib/shopping/wake-lock';
import { LIST_TINT_LABELS } from '../../src/lib/shopping/list-style';
import { blend, contrastRatio, hslTokenToRgb } from '../../src/lib/theme/contrast';
import { PRESET_LIST } from '../../src/lib/theme/tokens';

const group = (category: string, ...names: string[]) => ({ category, items: names.map((name) => ({ name })) });

describe('trip mode: "n left" (SH-33d)', () => {
  test('counts what is still needed', () => {
    assert.equal(leftLabel(5, 8), '5 left');
    assert.equal(leftLabel(1, 1), '1 left');
  });
  test('says when everything is in the cart, and nothing for an empty list', () => {
    assert.equal(leftLabel(0, 3), 'All in the cart');
    assert.equal(leftLabel(0, 0), null);
  });
});

describe('trip mode: aisle chips (SH-18b)', () => {
  test('one chip per aisle in walk order, pointing at that aisle heading', () => {
    const groups = [group('Produce', 'Apples', 'Pears'), group('Dairy & Eggs', 'Milk')];
    assert.deepEqual(aisleChips(groups), [
      { key: 'aisle-produce', label: 'Produce', count: 2, targetId: 'aisle-produce' },
      { key: 'aisle-dairy-eggs', label: 'Dairy & Eggs', count: 1, targetId: 'aisle-dairy-eggs' },
    ]);
    assert.deepEqual(aisleChips(groups).map((chip) => chip.targetId), aisleTargetIds(groups));
  });
  test('no chips with fewer than two aisles, but headings still get ids', () => {
    assert.deepEqual(aisleChips([group('Produce', 'Apples')]), []);
    assert.deepEqual(aisleChips([]), []);
    assert.deepEqual(aisleTargetIds([group('Produce', 'Apples')]), ['aisle-produce']);
  });
  test('ids stay unique when names slug the same or have no letters', () => {
    const ids = aisleTargetIds([group('Snacks!', 'a'), group('snacks', 'b'), group('???', 'c'), group('Snacks ', 'd')]);
    assert.deepEqual(ids, ['aisle-snacks', 'aisle-snacks-2', 'aisle-aisle', 'aisle-snacks-3']);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('trip mode: find or add (SH-18c)', () => {
  test('one typed name filters; a quantity is ignored; case and spacing do not matter', () => {
    assert.equal(findQuery('milk'), 'milk');
    assert.equal(findQuery('  2  Oat  Milk '), 'oat milk');
    assert.equal(findQuery('bread x2'), 'bread');
  });
  test('nothing, or several items, never filters', () => {
    assert.equal(findQuery(''), null);
    assert.equal(findQuery('   '), null);
    assert.equal(findQuery('milk, eggs'), null);
  });
  test('filters by "contains" and drops aisles left empty', () => {
    const groups = [group('Dairy', 'Milk', 'Oat milk', 'Butter'), group('Bakery', 'Bread')];
    assert.deepEqual(filterAisleGroups(groups, 'milk'), [group('Dairy', 'Milk', 'Oat milk')]);
    assert.deepEqual(filterAisleGroups(groups, 'cheese'), []);
    assert.equal(filterAisleGroups(groups, null), groups);
  });
  test('the hint says how many match and that Enter adds what was typed', () => {
    assert.equal(findHint(null, 0, ''), null);
    assert.equal(findHint('milk', 2, 'milk'), '2 needed items match. Press Enter to add milk.');
    assert.equal(findHint('milk', 1, ' milk '), '1 needed item matches. Press Enter to add milk.');
    assert.equal(findHint('kale', 0, 'kale'), 'No needed item matches. Press Enter to add kale.');
  });
});

describe('phone bottom sheets: keyboard inset (SH-19b)', () => {
  test('the part of the layout viewport the visual viewport no longer shows', () => {
    assert.equal(keyboardInset(844, { height: 500, offsetTop: 0 }), 344);
    assert.equal(keyboardInset(844, { height: 500, offsetTop: 40 }), 304);
  });
  test('0 without a keyboard, without a visual viewport, or for rounding noise', () => {
    assert.equal(keyboardInset(844, { height: 844, offsetTop: 0 }), 0);
    assert.equal(keyboardInset(844, { height: 843.5, offsetTop: 0 }), 0);
    assert.equal(keyboardInset(844, null), 0);
    assert.equal(keyboardInset(844, { height: 900, offsetTop: 0 }), 0);
    assert.equal(keyboardInset(Number.NaN, { height: 500, offsetTop: 0 }), 0);
  });
});

describe('trip mode: wake lock (SH-33a)', () => {
  test('wanted only with a list open, the page visible, on a phone, where supported', () => {
    const all = { listOpen: true, visible: true, phone: true, supported: true };
    assert.equal(wakeLockWanted(all), true);
    for (const key of Object.keys(all) as Array<keyof typeof all>) {
      assert.equal(wakeLockWanted({ ...all, [key]: false }), false, key);
    }
  });

  const fakeApi = () => {
    const log: string[] = [];
    const pending: Array<(sentinel: WakeLockSentinelLike) => void> = [];
    const sentinels: Array<WakeLockSentinelLike & { fireRelease: () => void }> = [];
    const make = () => {
      let released = false;
      let onRelease: (() => void) | null = null;
      const sentinel = {
        get released() { return released; },
        release: async () => { if (!released) { released = true; log.push('release'); onRelease?.(); } },
        addEventListener: (_type: 'release', listener: () => void) => { onRelease = listener; },
        fireRelease: () => { released = true; onRelease?.(); },
      };
      sentinels.push(sentinel);
      return sentinel;
    };
    return {
      log,
      sentinels,
      grant: () => pending.shift()?.(make()),
      api: { request: () => { log.push('request'); return new Promise<WakeLockSentinelLike>((resolve) => pending.push(resolve)); } },
    };
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  test('requests on open, releases on leaving, requests again when shown again', async () => {
    const fake = fakeApi();
    const controller = createWakeLockController(fake.api);
    controller.set(true);
    fake.grant();
    await flush();
    assert.equal(controller.state(), 'held');
    controller.set(false); // page hidden or list closed
    await flush();
    assert.equal(controller.state(), 'idle');
    controller.set(true);
    assert.deepEqual(fake.log, ['request', 'release', 'request']);
  });

  test('one request at a time; a lock granted after it stopped being wanted is released at once', async () => {
    const fake = fakeApi();
    const controller = createWakeLockController(fake.api);
    controller.set(true);
    controller.set(true);
    assert.deepEqual(fake.log, ['request']);
    controller.set(false);
    fake.grant();
    await flush();
    assert.deepEqual(fake.log, ['request', 'release']);
    assert.equal(controller.state(), 'idle');
  });

  test('a system release is forgotten, so the next visible transition asks again', async () => {
    const fake = fakeApi();
    const controller = createWakeLockController(fake.api);
    controller.set(true);
    fake.grant();
    await flush();
    fake.sentinels[0].fireRelease();
    assert.equal(controller.state(), 'idle');
    controller.set(true);
    assert.deepEqual(fake.log, ['request', 'request']);
  });

  test('a refused request holds nothing and is retried on the next call', async () => {
    let calls = 0;
    const controller = createWakeLockController({ request: () => { calls += 1; return Promise.reject(new Error('NotAllowedError')); } });
    controller.set(true);
    await flush();
    assert.equal(controller.state(), 'idle');
    controller.set(true);
    assert.equal(calls, 2);
  });

  test('dispose releases and ignores later calls; no API does nothing', async () => {
    const fake = fakeApi();
    const controller = createWakeLockController(fake.api);
    controller.set(true);
    fake.grant();
    await flush();
    controller.dispose();
    controller.set(true);
    assert.deepEqual(fake.log, ['request', 'release']);
    const none = createWakeLockController(null);
    none.set(true);
    assert.equal(none.state(), 'idle');
  });
});

describe('accessibility details (SH-26c, SH-26f)', () => {
  test('list colour swatches are named by colour, each name distinct', () => {
    const names = Object.values(LIST_TINT_LABELS);
    assert.equal(names.length, 8);
    assert.equal(new Set(names).size, 8);
    for (const name of names) assert.doesNotMatch(name, /tint|\d/i);
  });
  test('the pantry expiry pills (12 px text on a 10% tint of the same colour) meet 4.5:1 in every theme', () => {
    for (const preset of PRESET_LIST) {
      for (const token of ['warning', 'destructive', 'primary'] as const) {
        const color = hslTokenToRgb(preset.colors[token]);
        const ratio = contrastRatio(color, blend(color, hslTokenToRgb(preset.colors.background), 0.1));
        assert.ok(ratio >= 4.5, `${preset.id}: ${token} pill ${ratio.toFixed(2)}:1`);
      }
    }
  });
});
