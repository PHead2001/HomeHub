import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { clearedAssignees, ownListCleared, personDoneStorageKey, personDoneTitle } from '../../src/lib/chores/house-clean';
import type { ChoreRecord } from '../../src/lib/chores/dates';

// CH-22: a small "Your chores are done, Sam!" when one person's list clears.
const today = '2026-08-06';
const open = (uid: string, day = today) => ({ isCompleted: false, assignedToUid: uid, originalDueDate: day, dueDate: day }) as ChoreRecord;
const closed = (uid: string, day = today) => ({ ...open(uid, day), isCompleted: true }) as ChoreRecord;

describe('CH-22: your chores are done', () => {
  it('fires when your last open chore for today (or an overdue one) is done while others still have work', () => {
    assert.equal(ownListCleared([open('sam'), open('alex')], [closed('sam'), open('alex')], 'sam', today), true);
    assert.equal(ownListCleared([open('sam', '2026-08-04'), open('alex')], [closed('sam', '2026-08-04'), open('alex')], 'sam', today), true);
  });

  it('does not fire while you still have something, when you had nothing, or when the whole house is clean', () => {
    assert.equal(ownListCleared([open('sam'), open('sam'), open('alex')], [closed('sam'), open('sam'), open('alex')], 'sam', today), false);
    assert.equal(ownListCleared([open('alex')], [open('alex')], 'sam', today), false);
    assert.equal(ownListCleared([open('sam')], [closed('sam')], 'sam', today), false, '"House is clean" is the moment then');
    assert.equal(ownListCleared([open('sam', '2026-08-07'), open('alex')], [closed('sam', '2026-08-07'), open('alex')], 'sam', today), false, 'future chores are not today\'s list');
  });

  it('finds people whose chores all left the tablet list, never the unassigned', () => {
    const before = [{ assigneeKey: 'sam' }, { assigneeKey: 'alex' }, { assigneeKey: '' }];
    assert.deepEqual(clearedAssignees(before, [{ assigneeKey: 'alex' }, { assigneeKey: '' }]), ['sam']);
    assert.deepEqual(clearedAssignees(before, [{ assigneeKey: 'sam' }, { assigneeKey: 'alex' }]), []);
    assert.deepEqual(clearedAssignees(before, []), [], 'an empty list is the whole house');
  });

  it('names the first name only, keyed once per person per day', () => {
    assert.equal(personDoneTitle('Sam Smith'), 'Your chores are done, Sam!');
    assert.equal(personDoneTitle(''), 'Your chores are done!');
    assert.equal(personDoneStorageKey('h1', 'sam', today), 'homehub.personDone.h1.sam.2026-08-06');
  });

  it('is wired on the Chores page and the wall tablet, outside the toast stack', () => {
    const page = readFileSync('src/components/chore-chart-client.tsx', 'utf8');
    assert.match(page, /ownListCleared\(before, after, currentUser\.uid, today\)/);
    assert.match(page, /<PersonDoneMoment /);
    const tablet = readFileSync('src/components/devices/tablet-views.tsx', 'utf8');
    assert.match(tablet, /usePersonDoneOnTablet\(household\?\.kind === 'today' \? household\.work : null\)/, 'household-wide, even in a room view');
    const moment = readFileSync('src/components/chores/person-done-moment.tsx', 'utf8');
    assert.match(moment, /pointer-events-none/);
    assert.doesNotMatch(moment, /toast\(/);
  });
});
