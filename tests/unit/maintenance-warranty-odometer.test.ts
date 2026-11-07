import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { warrantyCountdown, warrantyCountdownText, warrantyRingLabel, WARRANTY_FALLBACK_DAYS } from '../../src/lib/maintenance/warranty';
import { mileageText, odometerDigits, wheelOffset } from '../../src/lib/maintenance/odometer';

describe('warranty countdown', () => {
  it('counts days left out of the term from the purchase date', () => {
    // The e2e seed's HVAC: bought 2022-05-12, warranty to 2026-08-10, today 2026-08-01.
    const countdown = warrantyCountdown({ purchaseDate: '2022-05-12', warrantyExpiration: '2026-08-10' }, '2026-08-01')!;
    assert.equal(countdown.daysLeft, 9);
    assert.equal(countdown.termDays, 1551);
    assert.equal(countdown.source, 'purchase');
    assert.ok(Math.abs(countdown.fraction - 9 / 1551) < 1e-9);
    assert.equal(warrantyCountdownText(countdown), 'Warranty: 9 days left of 1,551');
    assert.equal(warrantyRingLabel(countdown), '9d');
  });

  it('falls back to a one-year term without a usable purchase date', () => {
    const none = warrantyCountdown({ warrantyExpiration: '2027-08-01' }, '2026-08-01')!;
    assert.equal(none.source, 'fallback');
    assert.equal(none.termDays, WARRANTY_FALLBACK_DAYS);
    assert.equal(none.daysLeft, 365);
    assert.equal(none.fraction, 1);
    // A purchase date after the expiration is not a start date.
    assert.equal(warrantyCountdown({ purchaseDate: '2028-01-01', warrantyExpiration: '2027-08-01' }, '2026-08-01')!.source, 'fallback');
  });

  it('handles the last day, expired and missing warranties', () => {
    const last = warrantyCountdown({ warrantyExpiration: '2026-08-01' }, '2026-08-01')!;
    assert.equal(last.daysLeft, 0);
    assert.equal(last.expired, false);
    assert.equal(warrantyCountdownText(last), 'Warranty ends today');
    const ended = warrantyCountdown({ warrantyExpiration: '2026-07-01', purchaseDate: '2025-07-01' }, '2026-08-01')!;
    assert.equal(ended.expired, true);
    assert.equal(ended.fraction, 0);
    assert.equal(warrantyCountdownText(ended), 'Warranty ended');
    assert.equal(warrantyCountdown({}, '2026-08-01'), null);
    assert.equal(warrantyCountdown({ warrantyExpiration: 'soon' }, '2026-08-01'), null);
    // ISO timestamps are read by their date part.
    assert.equal(warrantyCountdown({ warrantyExpiration: '2026-08-02T00:00:00.000Z' }, '2026-08-01')!.daysLeft, 1);
  });

  it('labels long countdowns in years', () => {
    const long = warrantyCountdown({ warrantyExpiration: '2031-08-01', purchaseDate: '2026-01-01' }, '2026-08-01')!;
    assert.equal(warrantyRingLabel(long), '5y');
    assert.equal(warrantyCountdownText({ ...long, daysLeft: 1 }), `Warranty: 1 day left of ${long.termDays.toLocaleString('en-US')}`);
  });
});

describe('odometer digits', () => {
  it('pads to six wheels and grows past them', () => {
    assert.deepEqual(odometerDigits(48750), [0, 4, 8, 7, 5, 0]);
    assert.deepEqual(odometerDigits(1234567), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(odometerDigits(0), [0, 0, 0, 0, 0, 0]);
  });

  it('rounds down and never goes negative', () => {
    assert.deepEqual(odometerDigits(99.9), [0, 0, 0, 0, 9, 9]);
    assert.deepEqual(odometerDigits(-5), [0, 0, 0, 0, 0, 0]);
    assert.deepEqual(odometerDigits(Number.NaN), [0, 0, 0, 0, 0, 0]);
  });

  it('offsets each wheel to its digit', () => {
    assert.equal(wheelOffset(0), 0);
    assert.equal(wheelOffset(7), -70);
    assert.equal(wheelOffset(12), -90);
  });

  it('gives screen readers the plain value', () => {
    assert.equal(mileageText(48750), '48,750 miles');
    assert.equal(mileageText(1), '1 mile');
  });
});
