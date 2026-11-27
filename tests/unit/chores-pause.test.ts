import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { MAX_PAUSE_DAYS, checkPauseRange, pauseFits, pauseKeys, pauseMessage, rangeDays, withoutSkippedOccurrences } from '../../src/lib/chores/pause';
import { MAX_SKIPPED_OCCURRENCES } from '../../functions/src/shared/skips';

const TODAY = '2026-11-27'; // a Friday

describe('away / sick pause (CH-32)', () => {
  it('checks the range on the household day', () => {
    assert.deepEqual(checkPauseRange({ from: '2026-11-28', to: '2026-11-30' }, TODAY), { ok: true, range: { from: '2026-11-28', to: '2026-11-30' } });
    // A range that started earlier keeps only today on.
    assert.deepEqual(checkPauseRange({ from: '2026-11-20', to: '2026-11-28' }, TODAY), { ok: true, range: { from: TODAY, to: '2026-11-28' } });
    assert.deepEqual(checkPauseRange({ from: '2026-11-20', to: '2026-11-21' }, TODAY), { ok: false, reason: 'past' });
    assert.deepEqual(checkPauseRange({ from: '2026-11-30', to: '2026-11-28' }, TODAY), { ok: false, reason: 'invalid' });
    assert.deepEqual(checkPauseRange({ from: 'x', to: '2026-11-28' }, TODAY), { ok: false, reason: 'invalid' });
    assert.equal(checkPauseRange({ from: TODAY, to: '2026-12-27' }, TODAY).ok, true, '31 days');
    assert.deepEqual(checkPauseRange({ from: TODAY, to: '2026-12-28' }, TODAY), { ok: false, reason: 'too-long' });
    assert.equal(rangeDays({ from: TODAY, to: '2026-12-27' }).length, MAX_PAUSE_DAYS);
  });

  it('skips only the member\'s repeating chores, on the days they repeat, in every room', () => {
    const templates = [
      { id: 'trash', recurrence: { frequency: 'weekly', weeklyOptions: { daysOfWeek: [1, 4] } }, roomIds: ['kitchen', 'garage'], assignedToUid: 'sam' },
      { id: 'dishes', recurrence: { frequency: 'daily' }, roomIds: [], assignedToUid: 'sam' },
      { id: 'mow', recurrence: { frequency: 'daily' }, assignedToUid: 'olive' },
      { id: 'stopped', recurrence: null, assignedToUid: 'sam' },
    ];
    const keys = pauseKeys(templates, 'sam', [{ uid: 'sam' }, { uid: 'olive' }], { from: '2026-11-29', to: '2026-12-03' }, TODAY);
    assert.deepEqual([...keys.keys()], ['trash', 'dishes']);
    // Mon Nov 30 and Thu Dec 3, in both rooms.
    assert.deepEqual(keys.get('trash'), ['trash|kitchen|2026-11-30', 'trash|garage|2026-11-30', 'trash|kitchen|2026-12-03', 'trash|garage|2026-12-03']);
    assert.deepEqual(keys.get('dishes'), ['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03'].map(day => `dishes|general|${day}`));
  });

  it('pauses only the member\'s own turns of a rotating chore (CH-28)', () => {
    const rotating = [{ id: 'bins', recurrence: { frequency: 'daily' }, roomIds: [], rotation: ['sam', 'olive'], rotationStart: '2026-11-28' }];
    const days = (keys: Map<string, string[]>) => (keys.get('bins') ?? []).map(key => key.slice(-10));
    // From Nov 28: Sam, Olive, Sam, Olive...
    assert.deepEqual(days(pauseKeys(rotating, 'sam', [], { from: '2026-11-28', to: '2026-12-01' }, TODAY)), ['2026-11-28', '2026-11-30']);
    assert.deepEqual(days(pauseKeys(rotating, 'olive', [], { from: '2026-11-28', to: '2026-12-01' }, TODAY)), ['2026-11-29', '2026-12-01']);
    // Someone who cannot take a turn passes it on, as upkeep does.
    assert.deepEqual(days(pauseKeys(rotating, 'sam', [], { from: '2026-11-28', to: '2026-12-01' }, TODAY, uid => uid === 'sam')), ['2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01']);
    assert.equal(pauseKeys(rotating, 'max', [], { from: '2026-11-28', to: '2026-12-01' }, TODAY).size, 0);
  });

  it('refuses a pause that would push keys out of the capped list, and resumes exactly', () => {
    const full = Array.from({ length: MAX_SKIPPED_OCCURRENCES }, (_, i) => `t|r${i}|2026-12-01`);
    assert.equal(pauseFits(full, ['t|x|2026-12-02'], TODAY), false);
    assert.equal(pauseFits(full.slice(1), ['t|x|2026-12-02'], TODAY), true);
    // Past keys do not count: they are dropped on the next write.
    assert.equal(pauseFits(['t|r|2026-11-01', ...full.slice(1)], ['t|x|2026-12-02'], TODAY), true);
    assert.deepEqual(withoutSkippedOccurrences(['a|g|2026-12-01', 'a|g|2026-12-02'], ['a|g|2026-12-01']), ['a|g|2026-12-02']);
  });

  it('explains every answer in plain words', () => {
    assert.equal(pauseMessage({ status: 'paused', templates: 2, removed: 3, days: 4 }, 'Sam').description, "Sam's repeating chores are skipped on 4 days.");
    assert.equal(pauseMessage({ status: 'paused', templates: 0, removed: 0, days: 0 }, 'Sam').title, 'Nothing to pause');
    assert.equal(pauseMessage({ status: 'refused', reason: 'forbidden' }, 'Sam').failed, true);
  });

  it('mutes celebration sounds during household quiet hours', () => {
    const page = readFileSync(resolve(process.cwd(), 'src/components/chore-chart-client.tsx'), 'utf8');
    assert.match(page, /if \(isQuietAt\(readQuietHours\(quietHours\), household\?\.timeZone, new Date\(\)\)\) return;/);
    assert.doesNotMatch(page, /playFeedback\('complete'\)|playFeedback\('celebrate'\)/);
  });
});
