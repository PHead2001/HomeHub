import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { chosenRoomIds, oneTimeChoreRooms } from '../../src/lib/chores/add-chore';

describe('Add Chore with several rooms (CH-25)', () => {
  const rooms = [{ id: 'kitchen' }, { id: 'bath' }, { id: 'garage' }];

  it('keeps the chosen rooms that exist, in room order, once each', () => {
    assert.deepEqual(chosenRoomIds(['garage', 'gone', 'kitchen', 'garage'], rooms), ['kitchen', 'garage']);
    assert.deepEqual(chosenRoomIds(['gone'], rooms), []);
  });

  it('writes one one-time chore per room, or one Around the house', () => {
    assert.deepEqual(oneTimeChoreRooms([]), [[]]);
    assert.deepEqual(oneTimeChoreRooms(['kitchen', 'bath']), [['kitchen'], ['bath']]);
  });

  it('keeps the dialogs\' footers on screen above the keyboard', () => {
    const dialogs = readFileSync(resolve(process.cwd(), 'src/components/chores/chore-dialogs.tsx'), 'utf8');
    assert.doesNotMatch(dialogs, /max-h-\[(55|60|65)vh\]/);
    assert.doesNotMatch(dialogs, /<ScrollArea/);
    assert.match(dialogs, /const SHEET_BODY = 'min-h-0 flex-1 overflow-y-auto overscroll-contain'/);
    assert.match(dialogs, /data-testid="add-chore-rooms"/);
  });
});
