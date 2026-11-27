import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MORNING_PUSH_MINUTES, inLocalWindow, nextLocalTime, pushHoldUntil, readLocalWindow, releaseHeld,
} from '../../functions/src/shared/push-hold';
import { releasedUids } from '../../functions/src/push-policy';
import { buildMedicationReminders } from '../../functions/src/shared/medication-reminders';

// NO-3 (no midnight pushes) and household quiet hours (16.3): when a push may be sent.
const CHI = 'America/Chicago';
// Chicago is UTC-6 in November.
const chi = (day: string, hh: number, mm = 0) => new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), hh + 6, mm));
const base = { timeZone: CHI, householdWide: true, morningHold: false, householdQuiet: null };

describe('push hold (NO-3, 16.3)', () => {
  test('a day-based reminder created after midnight waits for 07:00 household time', () => {
    const now = chi('2026-11-12', 0, 5);
    const until = pushHoldUntil({ ...base, now, morningHold: true });
    assert.equal(until?.toISOString(), chi('2026-11-12', 7).toISOString());
    assert.equal(MORNING_PUSH_MINUTES, 420);
  });

  test('after 07:00, or for a reminder with a set time, it is sent at once', () => {
    assert.equal(pushHoldUntil({ ...base, now: chi('2026-11-12', 7), morningHold: true }), null);
    assert.equal(pushHoldUntil({ ...base, now: chi('2026-11-12', 0, 5), morningHold: false }), null);
  });

  test('household quiet hours hold household-wide pushes only, until they end', () => {
    const quiet = { start: '22:00', end: '06:30' };
    const now = chi('2026-11-12', 23);
    assert.equal(pushHoldUntil({ ...base, now, householdQuiet: quiet })?.toISOString(), chi('2026-11-13', 6, 30).toISOString());
    assert.equal(pushHoldUntil({ ...base, now, householdQuiet: quiet, householdWide: false }), null, 'a targeted notice is not a household push');
    assert.equal(pushHoldUntil({ ...base, now: chi('2026-11-12', 12), householdQuiet: quiet }), null);
  });

  test('holds that follow one another: quiet hours end at 06:30, the morning hour is 07:00', () => {
    const until = pushHoldUntil({ ...base, now: chi('2026-11-13', 1), householdQuiet: { start: '22:00', end: '06:30' }, morningHold: true });
    assert.equal(until?.toISOString(), chi('2026-11-13', 7).toISOString());
  });

  test("a member's own quiet hours hold their push, whatever the audience", () => {
    const until = pushHoldUntil({ ...base, householdWide: false, now: chi('2026-11-12', 21), memberQuiet: { start: '20:00', end: '08:00' } });
    assert.equal(until?.toISOString(), chi('2026-11-13', 8).toISOString());
  });

  test('windows: crossing midnight, start inside and end outside, malformed values', () => {
    const w = { start: '22:00', end: '07:00' };
    assert.equal(inLocalWindow(w, CHI, chi('2026-11-12', 22)), true);
    assert.equal(inLocalWindow(w, CHI, chi('2026-11-12', 6, 59)), true);
    assert.equal(inLocalWindow(w, CHI, chi('2026-11-12', 7)), false);
    assert.equal(inLocalWindow({ start: '09:00', end: '17:00' }, CHI, chi('2026-11-12', 12)), true);
    assert.equal(readLocalWindow({ start: '9:00', end: '17:00' }), null);
    assert.equal(readLocalWindow({ start: '09:00', end: '09:00' }), null);
    assert.deepEqual(readLocalWindow({ start: '09:00', end: '17:30', extra: 1 }), { start: '09:00', end: '17:30' });
  });

  test('the next 07:00 across the spring-forward night', () => {
    // US DST starts 2027-03-14 at 02:00 local: 07:00 that day is 12:00Z (UTC-5).
    const now = new Date('2027-03-14T07:30:00Z');
    assert.equal(nextLocalTime(now, CHI, 420).toISOString(), '2027-03-14T12:00:00.000Z');
  });
});

describe('releasing held pushes', () => {
  const at = (h: number) => Date.UTC(2026, 10, 13, h);
  test('due entries are released; later ones stay with the earliest as next', () => {
    const split = releaseHeld({ b: at(13), a: at(12), c: at(20) }, at(13), { closed: false, seenBy: new Set() });
    assert.deepEqual(split.release, ['a', 'b']);
    assert.deepEqual(split.remaining, { c: at(20) });
    assert.equal(split.next, at(20));
  });

  test('nobody who read or dismissed it, and nothing for a resolved or expired notification', () => {
    assert.deepEqual(releaseHeld({ a: at(12), b: at(12) }, at(13), { closed: false, seenBy: new Set(['a']) }).release, ['b']);
    const closed = releaseHeld({ a: at(12), b: at(20) }, at(13), { closed: true, seenBy: new Set() });
    assert.deepEqual(closed, { release: [], remaining: {}, next: null });
  });

  test('the update trigger sends only when pushRelease moves', () => {
    const t1 = { seconds: 1, nanoseconds: 0 };
    const t2 = { seconds: 2, nanoseconds: 0 };
    assert.deepEqual(releasedUids({}, { pushRelease: { at: t1, uids: ['a'] } }), ['a']);
    assert.deepEqual(releasedUids({ pushRelease: { at: t1, uids: ['a'] } }, { pushRelease: { at: t1, uids: ['a'] } }), []);
    assert.deepEqual(releasedUids({ pushRelease: { at: t1, uids: ['a'] } }, { pushRelease: { at: t2, uids: ['b', 3] } }), ['b']);
    assert.deepEqual(releasedUids({}, { pushRelease: { at: t2, uids: ['a'] }, resolvedAt: t2 }), [], 'never for a resolved notification');
    assert.deepEqual(releasedUids({ readBy: {} }, { readBy: { a: {} } }), [], 'a read is not a release');
  });
});

describe('which reminders wait for the morning', () => {
  test('a legacy medication due on a day waits; it is flagged untimed', () => {
    const reminders = buildMedicationReminders([{
      id: 'maple', name: 'Maple',
      logs: [{ id: 'l1', medication: 'Flea', date: '2026-10-12T12:00:00Z', nextDueDate: '2026-11-12' }],
    }], '2026-11-12');
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0].timed, false);
  });
});
