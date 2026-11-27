import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { SWAP_REFUSED, isUpForGrabs, maySwapAway, readSwapOffer, swapTargets } from '../../src/lib/chores/swap';
import type { ChoreRecord } from '../../src/lib/chores/dates';
import { earnsPoints } from '../../functions/src/shared/chore-points';

const chore = (id: string, fields: Partial<ChoreRecord> = {}) => ({ id, task: id, dueDate: '', originalDueDate: '2026-11-27', isCompleted: false, ...fields } as ChoreRecord);

describe('up for grabs and swaps (CH-31)', () => {
  it('a chore with no assignee is up for grabs', () => {
    assert.equal(isUpForGrabs(chore('a', { assignedToUid: '' })), true);
    assert.equal(isUpForGrabs(chore('a', {})), true);
    assert.equal(isUpForGrabs(chore('a', { assignedToUid: 'u1' })), false);
    assert.equal(isUpForGrabs(chore('a', { assignedToEmail: 'old@example.test' })), false);
  });

  it('offers only your own open chores, for housemates\' open chores (no kid profiles), soonest first', () => {
    assert.equal(maySwapAway(chore('a', { assignedToUid: 'me' }), 'me'), true);
    assert.equal(maySwapAway(chore('a', { assignedToUid: 'me', isCompleted: true }), 'me'), false);
    assert.equal(maySwapAway(chore('a', { assignedToUid: 'you' }), 'me'), false);
    const targets = swapTargets([
      chore('later', { assignedToUid: 'you', originalDueDate: '2026-11-29' }),
      chore('soon', { assignedToUid: 'you', originalDueDate: '2026-11-28' }),
      chore('mine', { assignedToUid: 'me' }),
      chore('kid', { assignedToUid: 'kid_abcdefghijklmnopqrst' }),
      chore('grabs', { assignedToUid: '' }),
      chore('done', { assignedToUid: 'you', isCompleted: true }),
    ], 'me');
    assert.deepEqual(targets.map(target => target.id), ['soon', 'later']);
  });

  it('an Anyone chore earns points for whoever does it, except the person who added it (CH-20)', () => {
    const grabs = { sourceType: 'temporary', createdByUid: 'me', assignedToUid: '' };
    assert.equal(earnsPoints(grabs as never, 'you'), true);
    assert.equal(earnsPoints(grabs as never, 'me'), false);
  });

  it('reads a stored offer and explains every refusal', () => {
    const stored = { fromUid: 'a', toUid: 'b', fromChoreId: 'x', toChoreId: 'y', status: 'pending', createdAt: '2026-11-27T00:00:00.000Z', expiresAt: '2026-11-30T00:00:00.000Z', fromTask: 'Dishes', toTask: 'Bins' };
    assert.equal(readSwapOffer(stored)?.status, 'pending');
    assert.equal(readSwapOffer({ ...stored, status: 'weird' }), null);
    assert.equal(readSwapOffer({ ...stored, toUid: undefined }), null);
    for (const reason of ['missing', 'not-yours', 'not-theirs', 'same-person', 'kid-profile', 'done', 'not-member', 'too-many', 'not-for-you', 'answered', 'expired', 'changed']) {
      assert.ok(SWAP_REFUSED[reason], reason);
    }
  });

  it('keeps the swap rules server-only and the deep link a plain link', () => {
    const rules = readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8');
    assert.match(rules, /match \/chore-swaps\/\{offerId\} \{[\s\S]*?allow write: if false;/);
    const server = readFileSync(resolve(process.cwd(), 'src/lib/server/chore-swap.ts'), 'utf8');
    assert.match(server, /deepLink: `\/chores\?swap=\$\{offerId\}`/);
  });
});
