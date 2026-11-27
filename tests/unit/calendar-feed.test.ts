import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChoreRecord } from '../../src/lib/chores/dates';
import { buildIcs, escapeText, foldLine, icsDate, icsUid, nextDay } from '../../src/lib/calendar/ics';
import { feedEvents, type FeedSources } from '../../src/lib/calendar/feed-events';

// The household's phone calendar feed (audit CA-25): iCalendar text and what it lists.
const chore = (overrides: Partial<ChoreRecord>): ChoreRecord => ({
  id: 'c1', task: 'Empty dishwasher', assignedToUid: 'sam', dueDate: '2026-08-01', originalDueDate: '2026-08-01', isCompleted: false, ...overrides,
});

describe('phone calendar feed text (CA-25)', () => {
  it('escapes text, folds at 75 octets without splitting characters, uses CRLF', () => {
    assert.equal(escapeText('a;b,c\\d\ne'), 'a\\;b\\,c\\\\d\\ne');
    const long = `SUMMARY:${'é'.repeat(60)}`;
    const folded = foldLine(long);
    const parts = folded.split('\r\n');
    assert.ok(parts.length > 1);
    for (const part of parts) assert.ok(new TextEncoder().encode(part).length <= 75);
    assert.ok(parts.slice(1).every(part => part.startsWith(' ')));
    assert.equal(parts.map((part, i) => (i === 0 ? part : part.slice(1))).join(''), long);
    assert.equal(foldLine('short'), 'short');
  });

  it('writes all-day events with an exclusive end, across month and year ends', () => {
    assert.equal(icsDate('2026-08-01'), '20260801');
    assert.equal(nextDay('2026-12-31'), '2027-01-01');
    assert.equal(nextDay('2028-02-28'), '2028-02-29');
    const text = buildIcs([
      { uid: 'chore:a/b', day: '2026-12-31', summary: 'Trash, bins', url: '/chores?room=general', categories: ['Chores'] },
      { uid: 'chore:a/b', day: '2026-12-31', summary: 'duplicate' },
      { uid: 'bad', day: 'not-a-day', summary: 'skipped' },
    ], { name: 'Home', now: new Date('2026-08-01T12:00:00Z'), baseUrl: 'https://homehub.example/' });
    assert.ok(text.endsWith('END:VCALENDAR\r\n'));
    assert.equal(text.split('\r\n').filter(line => line === 'BEGIN:VEVENT').length, 1);
    assert.match(text, /DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101/);
    assert.match(text, /SUMMARY:Trash\\, bins/);
    assert.match(text, /UID:chore:a_b@homehub/);
    assert.match(text, /URL:https:\/\/homehub\.example\/chores\?room=general/);
    assert.match(text, /DTSTAMP:20260801T120000Z/);
    assert.doesNotMatch(text.replace(/\r\n/g, ''), /\n/);
    assert.equal(icsUid('x y'), 'x_y@homehub');
  });

  it('lists open and planned chores, maintenance and pantry; never done chores or emails', () => {
    const sources: FeedSources = {
      timeZone: 'America/Chicago',
      members: [{ uid: 'sam', name: 'Sam' }],
      chores: [
        chore({ id: 'open', task: 'Dishes', originalDueDate: '2026-08-01', assignedToEmail: 'sam@example.test' }),
        chore({ id: 'done', task: 'Laundry', isCompleted: true }),
        // An older chore with only an instant: 03:00 UTC Aug 2 is Aug 1 in Chicago.
        chore({ id: 'legacy', task: 'Legacy', originalDueDate: undefined as unknown as string, dueDate: '2026-08-02T03:00:00.000Z' }),
      ],
      templates: [{ id: 'trash', task: 'Trash', assignedToUid: 'sam', recurrence: { frequency: 'weekly', weeklyOptions: { daysOfWeek: [4] } } }],
      assets: [], vehicles: [], medication: [], courses: [],
      pantry: [{ id: 'milk', name: 'Milk', expiryDate: '2026-08-04', packages: 1 }],
    };
    const events = feedEvents(sources, new Date('2026-08-01T15:00:00Z'));
    const summaries = events.map(e => e.summary);
    assert.ok(summaries.includes('Dishes (Sam)'));
    assert.ok(summaries.includes('Milk expires'));
    assert.ok(summaries.includes('Trash (Sam)'));
    assert.equal(summaries.includes('Laundry (Sam)'), false);
    assert.equal(events.find(e => e.summary.startsWith('Legacy'))!.day, '2026-08-01');
    assert.ok(events.every(e => !JSON.stringify(e).includes('@')));
    assert.ok(events.every(e => e.day <= '2026-10-30'), 'at most 90 days ahead');
  });
});
