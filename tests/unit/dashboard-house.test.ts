import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { floorPoint, houseColumns, layoutHouse, MAX_HOUSE_ROOMS, placePets, roomNeighbor } from '../../src/lib/dashboard/house-layout';
import { choresRoomHref, MAINTENANCE_OVERVIEW_HREF, roomMorphName } from '../../src/lib/dashboard/links';
import { GENERAL_ROOM_ID, UNKNOWN_ROOM_ID } from '../../src/lib/dashboard/facts';
import { sharedId } from '../../src/lib/motion';
import { tiltFor, TILT_DEG } from '../../src/lib/dashboard/tilt';
import { FINAL_STAGE, LANDING_STEPS, landingStage, moduleVisible, pieceVisible, SAMPLE_ROOMS } from '../../src/lib/dashboard/landing-scene';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `room-${i}`);

describe('living house placement', () => {
  it('uses one floor up to three rooms, 2x2 for four and three wide after that', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(houseColumns), [1, 2, 3, 2, 3, 3]);
    assert.equal(houseColumns(0), 3);
    assert.equal(MAX_HOUSE_ROOMS, 6);
  });

  it('places every room on the grid, row by row from the top floor, inside the viewBox', () => {
    for (let n = 0; n <= MAX_HOUSE_ROOMS; n += 1) {
      const layout = layoutHouse(ids(n));
      assert.equal(layout.rooms.length, n);
      assert.equal(layout.rooms.length + layout.emptyCells.length, layout.cols * layout.floors);
      layout.rooms.forEach((room, index) => {
        assert.equal(room.index, index);
        assert.equal(room.col, index % layout.cols);
        assert.equal(room.floor, Math.floor(index / layout.cols));
        assert.ok(room.x >= 0 && room.x + room.w <= layout.width, 'inside horizontally');
        assert.ok(room.y >= 0 && room.y + room.h <= layout.groundY, 'above the ground');
        assert.ok(room.box.left >= 0 && room.box.left + room.box.width <= 100.01);
        assert.ok(room.box.top >= 0 && room.box.top + room.box.height <= 100.01);
      });
      for (const point of [...layout.roofFront, ...layout.roofSide, ...layout.sideWall]) {
        assert.ok(point.x >= 0 && point.x <= layout.width && point.y >= 0 && point.y <= layout.height, `${n} rooms: ${JSON.stringify(point)}`);
      }
    }
  });

  it('room overlays tile the front face without overlapping', () => {
    const layout = layoutHouse(ids(6));
    for (const a of layout.rooms) {
      for (const b of layout.rooms) {
        if (a === b) continue;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        assert.equal(overlap, false, `${a.id} and ${b.id}`);
      }
    }
  });

  it('moves focus room by room with the arrow keys and stops at the edges', () => {
    const layout = layoutHouse(ids(5)); // 3 on top, 2 below
    assert.equal(roomNeighbor(layout, 'room-0', 'ArrowRight'), 'room-1');
    assert.equal(roomNeighbor(layout, 'room-0', 'ArrowLeft'), null);
    assert.equal(roomNeighbor(layout, 'room-1', 'ArrowDown'), 'room-4');
    // No room below the third column: the last room of the floor below.
    assert.equal(roomNeighbor(layout, 'room-2', 'ArrowDown'), 'room-4');
    assert.equal(roomNeighbor(layout, 'room-3', 'ArrowUp'), 'room-0');
    assert.equal(roomNeighbor(layout, 'room-0', 'ArrowUp'), null);
    assert.equal(roomNeighbor(layout, 'room-2', 'Home'), 'room-0');
    assert.equal(roomNeighbor(layout, 'room-0', 'End'), 'room-4');
    assert.equal(roomNeighbor(layout, 'room-4', 'ArrowRight'), null);
    assert.equal(roomNeighbor(layout, 'missing', 'ArrowRight'), null);
  });
});

describe('pets in the house', () => {
  const layout = layoutHouse(['bath', 'kitchen', 'living']);
  const names = { bath: 'Bathroom', kitchen: 'Kitchen', living: 'Living Room' };

  it('fed pets wander between rooms; hungry pets sit by the kitchen bowl; unknown pets rest', () => {
    const [maple, pixel, ghost] = placePets([
      { id: 'maple', fed: true },
      { id: 'pixel', fed: false },
      { id: 'ghost', fed: null },
    ], layout, names);

    assert.equal(maple.mode, 'wander');
    assert.equal(maple.path.length, 3);
    const roomOf = (x: number) => layout.rooms.find((room) => x >= room.x && x <= room.x + room.w)?.id;
    assert.ok(new Set(maple.path.map((p) => roomOf(p.x))).size >= 2, 'visits more than one room');

    const kitchen = layout.rooms.find((room) => room.id === 'kitchen')!;
    assert.equal(pixel.mode, 'bowl');
    assert.deepEqual(pixel.bowl, floorPoint(kitchen, 0.86));
    assert.equal(pixel.roomId, 'kitchen');
    assert.ok(Math.abs(pixel.at.x - pixel.bowl!.x) <= 30, 'sits next to the bowl');

    assert.equal(ghost.mode, 'idle');
    assert.equal(ghost.bowl, null);
    assert.equal(ghost.path.length, 1);
  });

  it('two hungry pets do not sit on top of each other', () => {
    const [a, b] = placePets([{ id: 'a', fed: false }, { id: 'b', fed: false }], layout, names);
    assert.notEqual(a.at.x, b.at.x);
    assert.deepEqual(a.bowl, b.bowl);
  });

  it('without a kitchen the bowl is in a ground-floor room; without rooms pets stand in the yard', () => {
    const twoFloors = layoutHouse(ids(4));
    const [hungry] = placePets([{ id: 'p', fed: false }], twoFloors, {});
    const room = twoFloors.rooms.find((r) => r.id === hungry.roomId)!;
    assert.equal(room.floor, twoFloors.floors - 1);

    const empty = layoutHouse([]);
    const [fed, hungryYard] = placePets([{ id: 'x', fed: true }, { id: 'y', fed: false }], empty, {});
    assert.equal(fed.mode, 'idle');
    assert.ok(fed.at.y > empty.groundY);
    assert.ok(hungryYard.at.y > empty.groundY);
  });

  it('a single room still wanders within that room', () => {
    const single = layoutHouse(['only']);
    const [pet] = placePets([{ id: 'p', fed: true }], single, {});
    assert.equal(pet.mode, 'wander');
    assert.ok(pet.path.every((p) => p.x >= single.rooms[0].x && p.x <= single.rooms[0].x + single.rooms[0].w));
  });
});

describe('room links and the shared-element name', () => {
  it('rooms open Chores filtered to that room (`general` included); only the unknown bucket opens the full list', () => {
    assert.equal(choresRoomHref('kitchen'), '/chores?room=kitchen');
    assert.equal(choresRoomHref('a b/c'), '/chores?room=a%20b%2Fc');
    assert.equal(choresRoomHref(GENERAL_ROOM_ID), '/chores?room=general');
    assert.equal(choresRoomHref(UNKNOWN_ROOM_ID), '/chores');
    assert.equal(MAINTENANCE_OVERVIEW_HREF, '/maintenance?tab=overview');
  });

  it('pins the room morph name shared with the Chores page (room-<id>, sharedId sanitizing, no suffix)', () => {
    assert.equal(roomMorphName('kitchen'), 'room-kitchen');
    assert.equal(roomMorphName('living-room'), 'room-living-room');
    assert.equal(roomMorphName('general'), 'room-general');
    assert.equal(roomMorphName('Kid’s room #2'), 'room-Kid_s_room__2');
    assert.equal(roomMorphName('a b/c.d'), 'room-a_b_c_d');
    for (const id of ['kitchen', 'a b/c.d', 'Kid’s room #2']) {
      assert.equal(`${roomMorphName(id)}-card`, sharedId('room', id), 'same sanitizing as sharedId');
    }
  });
});

describe('bento tilt', () => {
  it('tilts at most a few degrees, toward the pointer, and is flat at the center', () => {
    assert.deepEqual(tiltFor(50, 50, 100, 100), { x: 0, y: 0 });
    assert.deepEqual(tiltFor(100, 0, 100, 100), { x: TILT_DEG, y: TILT_DEG });
    assert.deepEqual(tiltFor(0, 100, 100, 100), { x: -TILT_DEG, y: -TILT_DEG });
    assert.deepEqual(tiltFor(500, -500, 100, 100), { x: TILT_DEG, y: TILT_DEG }, 'clamped');
    assert.deepEqual(tiltFor(10, 10, 0, 0), { x: 0, y: 0 });
  });
});

describe('landing assembly', () => {
  it('adds one layer per step and never goes back', () => {
    assert.equal(FINAL_STAGE, LANDING_STEPS.length);
    assert.equal(landingStage(0, false), 0);
    assert.equal(landingStage(2, false), 2);
    assert.equal(landingStage(99, false), FINAL_STAGE);
    assert.equal(landingStage(-1, false), 0);
    assert.ok(pieceVisible('foundation', 0));
    assert.ok(!pieceVisible('roof', 1));
    assert.ok(pieceVisible('roof', 2));
    assert.ok(pieceVisible('details', FINAL_STAGE));
  });

  it('flies each module into its own room in step order', () => {
    const roomIds = new Set<string>(SAMPLE_ROOMS.map((room) => room.id));
    LANDING_STEPS.forEach((step, index) => {
      assert.ok(roomIds.has(step.roomId));
      assert.equal(moduleVisible(step.module, index), false);
      assert.equal(moduleVisible(step.module, index + 1), true);
    });
    assert.equal(new Set(LANDING_STEPS.map((step) => step.roomId)).size, LANDING_STEPS.length);
  });

  it('shows the finished house at once under reduced motion', () => {
    assert.equal(landingStage(0, true), FINAL_STAGE);
  });
});

describe('session hint for the landing gate', () => {
  it('writes a bare flag when signed in, removes it when signed out, and survives blocked storage', async () => {
    const { SESSION_GATE_SCRIPT, SESSION_HINT_KEY, writeSessionHint } = await import('../../src/lib/dashboard/session-hint');
    const map = new Map<string, string>();
    const storage = { setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
    writeSessionHint(true, storage);
    assert.equal(map.get(SESSION_HINT_KEY), '1');
    writeSessionHint(false, storage);
    assert.equal(map.has(SESSION_HINT_KEY), false);
    assert.doesNotThrow(() => writeSessionHint(true, { setItem: () => { throw new Error('blocked'); }, removeItem: () => undefined }));
    assert.doesNotThrow(() => writeSessionHint(true, null));
    assert.match(SESSION_GATE_SCRIPT, /^try\{/);
    assert.ok(SESSION_GATE_SCRIPT.includes(`"${SESSION_HINT_KEY}"`));
  });
});
