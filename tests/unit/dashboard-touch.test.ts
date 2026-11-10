import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { computeChoreFacts, roomSummary, ROOM_CHORES } from '../../src/lib/dashboard/facts';
import { layoutHouse } from '../../src/lib/dashboard/house-layout';
import {
  attentionKey,
  choreLine,
  INLINE_CHORES,
  inlineRoomChores,
  onRoof,
  PEEK_ROOM_CHORES,
  pointInPolygon,
  registerTap,
  roomDetailRows,
  roomLinkName,
} from '../../src/lib/dashboard/touch';

const chore = (id: string, task: string, dueLabel: string, overdue = false) => ({ id, task, dueLabel, overdue });
const room = {
  name: 'Kitchen',
  chores: [
    chore('a', 'Wipe cabinets', 'due 5 days ago', true),
    chore('b', 'Mop floor', 'due yesterday', true),
    chore('c', 'Dishes', 'due today'),
    chore('d', 'Clean fridge', 'due in 3 days'),
    chore('e', 'Sort drawer', 'no date'),
  ],
};

describe('inline room chores (HP-13a)', () => {
  it('shows two lines on phones, three wider and five in the wide layout, in facts order', () => {
    assert.deepEqual(inlineRoomChores(room, INLINE_CHORES.narrow).map((entry) => entry.id), ['a', 'b']);
    assert.deepEqual(inlineRoomChores(room, INLINE_CHORES.regular).map((entry) => entry.id), ['a', 'b', 'c']);
    assert.deepEqual(inlineRoomChores(room, INLINE_CHORES.wide).map((entry) => entry.id), ['a', 'b', 'c', 'd', 'e']);
    assert.equal(INLINE_CHORES.wide, ROOM_CHORES, 'facts keep exactly what the widest layout shows');
    assert.equal(PEEK_ROOM_CHORES, 3);
  });

  it('shows nothing for a loading room, an empty room or a zero limit', () => {
    assert.deepEqual(inlineRoomChores(room, INLINE_CHORES.wide, true), []);
    assert.deepEqual(inlineRoomChores({ chores: [] }, INLINE_CHORES.wide), []);
    assert.deepEqual(inlineRoomChores(room, 0), []);
  });

  it('takes the overdue, today, soonest order from the room facts', () => {
    const rooms = [{ id: 'kitchen', name: 'Kitchen' }];
    const viewer = { uid: 'u1', email: 'me@example.test' };
    const facts = computeChoreFacts([
      { id: 'soon', task: 'Clean fridge', dueDate: '2026-08-04', isCompleted: false, roomIds: ['kitchen'] },
      { id: 'today', task: 'Dishes', dueDate: '2026-08-01', isCompleted: false, roomIds: ['kitchen'] },
      { id: 'late', task: 'Mop floor', dueDate: '2026-07-30', isCompleted: false, roomIds: ['kitchen'] },
    ], rooms, viewer, new Date(2026, 7, 1, 12, 0, 0));
    const kitchen = facts.rooms.find((entry) => entry.id === 'kitchen')!;
    assert.deepEqual(inlineRoomChores(kitchen, INLINE_CHORES.narrow).map((entry) => entry.task), ['Mop floor', 'Dishes']);
  });
});

describe('room details under the house on phones (HP-13a)', () => {
  const rooms = [
    { id: 'kitchen', ...room },
    { id: 'garage', name: 'Garage', chores: [] },
    { id: 'bath', name: 'Bathroom', chores: [chore('f', 'Scrub tub', 'due today')] },
  ];

  it('lists rooms with open chores in house order, two chores each', () => {
    assert.deepEqual(roomDetailRows(rooms).map((row) => [row.id, row.name, row.chores.map((entry) => entry.id)]), [
      ['kitchen', 'Kitchen', ['a', 'b']],
      ['bath', 'Bathroom', ['f']],
    ]);
    assert.equal(roomDetailRows(rooms, false, INLINE_CHORES.regular)[0].chores.length, 3);
  });

  it('lists nothing while the rooms are loading', () => {
    assert.deepEqual(roomDetailRows(rooms, true), []);
  });
});

describe('touch geometry in the stylesheet (HP-13a)', () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
  const css = read('src/components/dashboard/dashboard.module.css');
  const menu = read('src/components/dashboard/house-menu.tsx');

  it('shows an in-room chore line only when the room is tall enough for it', () => {
    assert.ok(css.includes('.roomChores {\n  container: room-chores / size;'));
    assert.ok(css.includes('.roomChores > * {\n  display: none;'));
    ['1.125rem', '2.25rem', '3.375rem'].forEach((height, index) => {
      assert.ok(css.includes(`@container room-chores (min-height: ${height}) {\n  .roomChores > :nth-child(${index + 1}) {\n    display: block;`), height);
    });
  });

  it('moves the chore lines under the house below 640 px', () => {
    assert.ok(css.includes('@media (max-width: 639.98px) {\n  :global(html) .roomChores {\n    display: none;'));
    assert.ok(css.includes('@media (min-width: 640px) {\n  :global(html) .roomDetails {\n    display: none;'));
  });

  it('beside the house, shows only the tile detail rows the screen height leaves room for (HP-12d)', () => {
    const wide = '@media (min-width: 1024px) and (orientation: landscape)';
    assert.ok(css.includes(`${wide} {\n  .tileGrid .tileDetails > :nth-child(n + 3) {\n    display: none;`));
    assert.ok(css.includes(`${wide} and (max-height: 53.99rem) {\n  .tileGrid .tileDetails > :nth-child(n + 2) {\n    display: none;`));
    assert.ok(css.includes(`${wide} and (max-height: 49.99rem) {\n  .tileGrid .tileDetails {\n    display: none;`));
  });

  it('caps the house menu at the width Radix says is available', () => {
    assert.match(menu, /max-w-\[min\(20rem,var\(--radix-dropdown-menu-content-available-width,100vw\)\)\]/);
    assert.match(menu, /min-w-\[min\(13rem,var\(--radix-dropdown-menu-content-available-width,100vw\)\)\]/);
  });
});

describe('room link name (HP-28b)', () => {
  it('names the room, its summary and the chore titles', () => {
    assert.equal(choreLine(room.chores[2]), 'Dishes, due today');
    assert.equal(
      roomLinkName({ name: 'Bath', chores: room.chores.slice(1, 3) }, '1 overdue, 1 due today'),
      'Bath: 1 overdue, 1 due today. Mop floor, due yesterday; Dishes, due today.',
    );
  });

  it('keeps the plain name for a room with no open chores and while loading', () => {
    const clear = { id: 'g', name: 'Garage', overdue: 0, dueToday: 0, upcoming: 0, doneToday: 0, status: 'clear' as const, chores: [] };
    assert.equal(roomLinkName(clear, roomSummary(clear)), 'Garage: All clear');
    assert.equal(roomLinkName(room, 'Loading…', true), 'Kitchen: Loading…');
  });
});

describe('roof taps (HP-19b)', () => {
  it('completes on the fifth tap within two seconds and starts over', () => {
    let taps: number[] = [];
    const results = [0, 300, 700, 1100, 1500].map((at) => {
      const step = registerTap(taps, at);
      taps = step.taps;
      return step.done;
    });
    assert.deepEqual(results, [false, false, false, false, true]);
    assert.deepEqual(taps, [], 'a completed run starts over');
  });

  it('drops taps older than the window', () => {
    let taps: number[] = [];
    for (const at of [0, 500, 1000, 1500]) taps = registerTap(taps, at).taps;
    // 2 s after the first tap: the first one has expired, so this is only the fourth.
    const late = registerTap(taps, 2000);
    assert.equal(late.done, false);
    assert.deepEqual(late.taps, [500, 1000, 1500, 2000]);
    assert.equal(registerTap(late.taps, 2400).done, true);
  });

  it('honours a custom count and window', () => {
    assert.equal(registerTap([0, 10], 20, { count: 3, windowMs: 100 }).done, true);
    assert.equal(registerTap([0, 10], 200, { count: 3, windowMs: 100 }).done, false);
  });

  it('locates a tap on the roof, not on the rooms or the sky beside it', () => {
    const layout = layoutHouse(['a', 'b', 'c', 'd']);
    const [eaveLeft, apex, eaveRight] = layout.roofFront;
    const roofMiddle = { x: apex.x, y: (apex.y + eaveLeft.y) / 2 + 4 };
    assert.equal(onRoof(roofMiddle, layout), true);
    assert.equal(onRoof({ x: layout.body.x + 20, y: layout.body.y + 20 }, layout), false, 'a room');
    assert.equal(onRoof({ x: eaveLeft.x + 2, y: apex.y + 2 }, layout), false, 'the sky above the left eave');
    assert.equal(onRoof({ x: eaveRight.x + 1, y: eaveRight.y + 30 }, layout), false);
  });

  it('point in polygon handles a square', () => {
    const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    assert.equal(pointInPolygon({ x: 5, y: 5 }, square), true);
    assert.equal(pointInPolygon({ x: 15, y: 5 }, square), false);
  });
});

describe('attention keys (HP-16a)', () => {
  it('changes with the state an animation reports, so it runs again', () => {
    assert.equal(attentionKey('glow', 1), 'glow|1');
    assert.notEqual(attentionKey('glow', 1), attentionKey('glow', 2));
    assert.equal(attentionKey('pet', 'wander', null, undefined), 'pet|wander||');
    assert.notEqual(attentionKey('pet', 'wander', '1 of 2 today'), attentionKey('pet', 'wander', '2 of 2 today'));
  });
});
