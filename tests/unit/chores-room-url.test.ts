import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALL_ROOMS, choresRoomHref, effectiveChoresRoom, parseChoresRoom, roomSharedId } from '../../src/lib/chores/url-state';
import { cleanHouseRooms, houseCleanStorageKey, HOUSE_CLEAN_MAX_ROOMS, HOUSE_CLEAN_MS, sparkleDelay } from '../../src/lib/chores/house-clean';

const params = (search: string) => new URLSearchParams(search);

describe('chores ?room= URL state', () => {
  it('parses the room id, defaulting to All Rooms', () => {
    assert.equal(parseChoresRoom(params('room=kitchen')), 'kitchen');
    assert.equal(parseChoresRoom(params('room=general')), 'general');
    assert.equal(parseChoresRoom(params('room=%20living-room%20')), 'living-room');
    assert.equal(parseChoresRoom(params('')), ALL_ROOMS);
    assert.equal(parseChoresRoom(params('room=')), ALL_ROOMS);
    assert.equal(parseChoresRoom(params('room=all')), ALL_ROOMS);
    assert.equal(parseChoresRoom(null), ALL_ROOMS);
  });

  it('keeps the request while rooms load and drops unknown rooms afterwards', () => {
    assert.equal(effectiveChoresRoom('kitchen', null), 'kitchen');
    assert.equal(effectiveChoresRoom('kitchen', new Set(['kitchen'])), 'kitchen');
    assert.equal(effectiveChoresRoom('deleted-room', new Set(['kitchen'])), ALL_ROOMS);
    assert.equal(effectiveChoresRoom('general', new Set()), 'general');
    assert.equal(effectiveChoresRoom(ALL_ROOMS, new Set()), ALL_ROOMS);
  });

  it('builds hrefs that set, replace and clear the room, keeping other params', () => {
    assert.equal(choresRoomHref('/chores', params(''), 'kitchen'), '/chores?room=kitchen');
    assert.equal(choresRoomHref('/chores', params('room=kitchen&x=1'), 'garage'), '/chores?room=garage&x=1');
    assert.equal(choresRoomHref('/chores', params('room=kitchen'), ALL_ROOMS), '/chores');
    assert.equal(choresRoomHref('/chores', params('x=1&room=kitchen'), ''), '/chores?x=1');
    assert.equal(choresRoomHref('/chores', null, 'a b'), '/chores?room=a+b');
  });

  it('names the shared element room-<roomId>, sanitized for view-transition-name', () => {
    assert.equal(roomSharedId('kitchen'), 'room-kitchen');
    assert.equal(roomSharedId('living room/2'), 'room-living_room_2');
  });
});

describe('house is clean', () => {
  it('shows every room, worked-in rooms first, capped', () => {
    const rooms = [
      { id: 'garage', name: 'Garage', icon: 'Warehouse' },
      { id: 'kitchen', name: 'Kitchen', icon: 'CookingPot' },
      { id: 'bath', name: 'Bathroom' },
    ];
    assert.deepEqual(cleanHouseRooms(rooms, new Set(['kitchen'])).map(room => [room.id, room.workedToday]), [
      ['kitchen', true], ['bath', false], ['garage', false],
    ]);
    assert.equal(cleanHouseRooms(rooms, new Set())[0].icon, 'Home');
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, name: `Room ${String(i).padStart(2, '0')}` }));
    assert.equal(cleanHouseRooms(many, new Set()).length, HOUSE_CLEAN_MAX_ROOMS);
    assert.deepEqual(cleanHouseRooms([], new Set()).map(room => room.name), ['Home']);
  });

  it('sparkles room by room inside the 1.5 s budget', () => {
    assert.equal(HOUSE_CLEAN_MS, 1500);
    for (const count of [1, 2, 5, HOUSE_CLEAN_MAX_ROOMS]) {
      const delays = Array.from({ length: count }, (_, i) => sparkleDelay(i, count));
      delays.slice(1).forEach((delay, i) => assert.ok(delay > delays[i], 'each room after the previous'));
      // The last sparkle (stars: 2 × 50 ms stagger + 300 ms) ends well before the moment leaves.
      assert.ok(delays[delays.length - 1] + 0.4 <= 1.2, `count ${count}`);
    }
  });

  it('uses one key per household per day', () => {
    assert.equal(houseCleanStorageKey('h1', '2026-08-01'), 'homehub.houseClean.h1.2026-08-01');
    assert.notEqual(houseCleanStorageKey('h1', '2026-08-01'), houseCleanStorageKey('h1', '2026-08-02'));
  });
});
