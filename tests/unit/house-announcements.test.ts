import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { pinnedAnnouncement, validateHouseAnnouncement } from '../../src/lib/house-announcements';
import { parseDeviceNotice } from '../../src/lib/devices/device-session';

// NO-25 "Message the house": input rules and the tablet's pinned message.
describe('house message input', () => {
  test('trimmed plain text up to 200 characters, a listed duration, a push choice', () => {
    assert.deepEqual(validateHouseAnnouncement({ message: '  Dinner at 6 ', hours: 12, push: true }), { ok: true, value: { message: 'Dinner at 6', hours: 12, push: true } });
    assert.equal(validateHouseAnnouncement({ message: 'Line one\r\nline two', hours: 2, push: false }).ok, true);
    assert.equal(validateHouseAnnouncement({ message: '', hours: 12, push: false }).ok, false);
    assert.equal(validateHouseAnnouncement({ message: 'x'.repeat(201), hours: 12, push: false }).ok, false);
    assert.equal(validateHouseAnnouncement({ message: 'bell\x07', hours: 12, push: false }).ok, false);
    assert.equal(validateHouseAnnouncement({ message: 'x', hours: 5, push: false }).ok, false);
    assert.equal(validateHouseAnnouncement({ message: 'x', hours: 12 }).ok, false);
    assert.equal(validateHouseAnnouncement(null).ok, false);
  });
});

describe('the pinned message on a wall tablet', () => {
  const now = Date.parse('2026-11-13T18:00:00Z');
  const notice = (id: string, fields: Record<string, unknown>) => parseDeviceNotice(id, { category: 'general', title: 't', ...fields }, now)!;

  test('the newest house message still up; other notices never pin', () => {
    const list = [
      notice('old', { sourceType: 'house-announcement', message: 'Old', createdAt: '2026-11-13T10:00:00Z', expiresAt: '2026-11-14T00:00:00Z' }),
      notice('new', { sourceType: 'house-announcement', message: 'New', createdAt: '2026-11-13T17:00:00Z', expiresAt: '2026-11-13T19:00:00Z' }),
      notice('sys', { sourceType: 'household-ownership-transfer', createdAt: '2026-11-13T17:30:00Z' }),
    ];
    assert.equal(pinnedAnnouncement(list, now)?.id, 'new');
    assert.equal(pinnedAnnouncement(list, Date.parse('2026-11-13T19:30:00Z'))?.id, 'old', 'an expired one unpins while the screen stays on');
    assert.equal(pinnedAnnouncement([list[2]], now), null);
    // A member may create a household-wide pets or chores notice with any sourceType; it never pins.
    const spoof = notice('spoof', { category: 'pets', sourceType: 'house-announcement', message: 'Fake', createdAt: '2026-11-13T17:59:00Z' });
    assert.equal(pinnedAnnouncement([...list, spoof], now)?.id, 'new');
  });
});
