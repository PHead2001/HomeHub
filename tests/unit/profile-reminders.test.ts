import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hourLabel, reminderHourFrom, reminderTimeFor, reminderZoneNote, zoneCityLabel } from '../../src/lib/profile/reminders';

describe('reminder hour picker (PR-4)', () => {
  it('stores whole hours only', () => {
    assert.equal(reminderTimeFor(17), '17:00');
    assert.equal(reminderTimeFor(7), '07:00');
    assert.equal(reminderTimeFor(-3), '00:00');
    assert.equal(reminderTimeFor(30), '23:00');
  });

  it('reads an older minute choice as its hour, and anything unreadable as 5 PM', () => {
    assert.equal(reminderHourFrom('17:17'), 17);
    assert.equal(reminderHourFrom('7:45'), 7);
    assert.equal(reminderHourFrom('25:00'), 17);
    assert.equal(reminderHourFrom('noon'), 17);
    assert.equal(reminderHourFrom(undefined), 17);
  });

  it('labels hours in the reader\'s locale', () => {
    assert.equal(hourLabel(17, 'en-US'), '5 PM');
    assert.equal(hourLabel(0, 'en-US'), '12 AM');
    assert.equal(hourLabel(17, 'en-GB'), '17');
  });
});

describe('reminder time zone (PR-5, D-6)', () => {
  it('names the household zone by its city', () => {
    assert.equal(zoneCityLabel('America/Chicago'), 'Chicago');
    assert.equal(zoneCityLabel('America/Port_of_Spain'), 'Port of Spain');
    assert.equal(zoneCityLabel(''), null);
    assert.match(reminderZoneNote('America/Chicago'), /household's time zone \(Chicago time\)/);
    assert.match(reminderZoneNote(null), /household's time zone, wherever/);
  });
});
