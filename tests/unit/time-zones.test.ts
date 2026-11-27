import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { timeZoneLabel, timeZoneOptions } from '../../src/lib/time-zones';
import { describeAuditAction } from '../../src/components/household/household-model';

describe('household time zone setting (HO-19)', () => {
  test('offers the runtime list, sorted, always including the stored zone', () => {
    const options = timeZoneOptions('America/Chicago');
    assert.ok(options.includes('America/Chicago'));
    assert.deepEqual(options, [...options].sort((a, b) => a.localeCompare(b)));
    const fake = { supportedValuesOf: () => ['Europe/Paris', 'America/Chicago'] } as unknown as typeof Intl;
    assert.deepEqual(timeZoneOptions('US/Central', fake), ['America/Chicago', 'Europe/Paris', 'US/Central']);
  });

  test('falls back to a short list on runtimes without supportedValuesOf', () => {
    const old = {} as unknown as typeof Intl;
    const options = timeZoneOptions(null, old);
    assert.ok(options.includes('America/New_York') && options.includes('UTC'));
  });

  test('labels carry the offset at a given moment', () => {
    assert.equal(timeZoneLabel('America/Chicago', new Date('2026-01-15T12:00:00Z')), 'America / Chicago (UTC-06:00)');
    assert.equal(timeZoneLabel('America/Chicago', new Date('2026-07-15T12:00:00Z')), 'America / Chicago (UTC-05:00)');
    assert.equal(timeZoneLabel('Not/AZone'), 'Not / AZone');
  });

  test('the activity log says from and to', () => {
    assert.equal(describeAuditAction({ action: 'household.time_zone_changed', details: { timeZone: 'America/New_York', previousTimeZone: 'America/Chicago' } }),
      'Changed the time zone from America/Chicago to America/New_York');
    assert.equal(describeAuditAction({ action: 'household.time_zone_changed', details: { timeZone: 'UTC', previousTimeZone: null } }), 'Set the time zone to UTC');
  });
});
