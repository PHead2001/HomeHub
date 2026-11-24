import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addDays, diffDays } from '../../functions/src/shared/calendar';
import {
  cleanReadings,
  fitMilesPerDay,
  predictDueDate,
  predictionText,
  vehicleReadings,
  type MileageReading,
} from '../../src/lib/maintenance/mileage-prediction';

const TODAY = '2026-11-24';
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Readings every `step` days back from today at `rate` miles a day. */
const steady = (count: number, step: number, rate: number, endMiles = 40000): MileageReading[] =>
  Array.from({ length: count }, (_, index) => {
    const back = (count - 1 - index) * step;
    return { day: addDays(TODAY, -back), miles: endMiles - back * rate };
  });

const estimate = (prediction: ReturnType<typeof predictDueDate>) => {
  assert.ok(!('insufficient' in prediction), JSON.stringify(prediction));
  return prediction as Exclude<typeof prediction, { insufficient: unknown }>;
};

describe('mileage prediction (MA-29)', () => {
  it('estimates the day a steady driver reaches the due mileage', () => {
    const result = estimate(predictDueDate(41000, steady(6, 20, 25), TODAY));
    assert.equal(result.milesPerDay, 25);
    assert.equal(result.date, addDays(TODAY, 40));
    assert.equal(result.low, result.date);
    assert.equal(result.high, result.date);
    assert.equal(result.basis, 6);
    assert.equal(predictionText(result, TODAY), 'Estimated around Jan 3, 2027, based on 6 readings');
    assert.equal(predictionText(estimate(predictDueDate(40500, steady(6, 20, 25), TODAY)), TODAY), 'Estimated around Dec 14, based on 6 readings');
  });

  it('needs three readings over at least 30 days, counted after cleaning', () => {
    assert.deepEqual(predictDueDate(41000, steady(2, 40, 25), TODAY), { insufficient: 'too-few-readings' });
    assert.deepEqual(predictDueDate(41000, steady(4, 9, 25), TODAY), { insufficient: 'too-short-span' });
    assert.deepEqual(predictDueDate(41000, steady(4, 10, 25), TODAY).hasOwnProperty('date'), true);
    // Three readings, but one is a typo: only two remain.
    const typo = [...steady(2, 40, 25), { day: addDays(TODAY, -60), miles: 90000 }];
    assert.deepEqual(predictDueDate(41000, typo, TODAY), { insufficient: 'too-few-readings' });
    // Old readings (more than a year ago) do not count.
    const old = steady(5, 100, 10);
    assert.equal(cleanReadings(old, TODAY).length, 4);
    assert.deepEqual(predictDueDate(undefined, steady(6, 20, 25), TODAY), { insufficient: 'no-due-mileage' });
  });

  it('handles parked cars, past-due mileage and far-off estimates', () => {
    assert.deepEqual(predictDueDate(41000, steady(5, 20, 0), TODAY), { insufficient: 'no-increase' });
    assert.deepEqual(predictDueDate(39000, steady(5, 20, 25), TODAY), { insufficient: 'already-reached' });
    assert.deepEqual(predictDueDate(40000, steady(5, 20, 25), TODAY), { insufficient: 'already-reached' });
    assert.deepEqual(predictDueDate(60000, steady(5, 20, 5), TODAY), { insufficient: 'too-far' });
  });

  it('drops backdated readings and typos in either direction', () => {
    const base = steady(6, 30, 30);
    const highEarly = [...base, { day: addDays(TODAY, -140), miles: 99999 }];
    const lowLate = [...base, { day: addDays(TODAY, -10), miles: 1200 }];
    const lowEarly = [...base, { day: addDays(TODAY, -160), miles: 0 }];
    const highLate = [...base, { day: addDays(TODAY, -5), miles: 75000 }];
    for (const readings of [highEarly, lowLate, lowEarly, highLate]) {
      const clean = cleanReadings(readings, TODAY);
      assert.deepEqual(clean, base, JSON.stringify(readings));
      assert.equal(estimate(predictDueDate(41000, readings, TODAY)).milesPerDay, 30);
    }
    // With the minimum of readings, one typo still cannot skew the rate.
    const few = steady(3, 30, 40);
    for (const typo of [{ day: addDays(TODAY, -70), miles: 0 }, { day: addDays(TODAY, -45), miles: 41000 }, { day: addDays(TODAY, -15), miles: 30000 }]) {
      const result = estimate(predictDueDate(41000, [...few, typo], TODAY));
      assert.equal(result.milesPerDay, 40, JSON.stringify(typo));
      assert.equal(result.basis, 3);
    }
    // Readings after today are not readings yet.
    assert.deepEqual(cleanReadings([...base, { day: addDays(TODAY, 3), miles: 40100 }], TODAY), base);
  });

  it('is robust to changing usage and noise (property)', () => {
    const random = rng(29);
    let estimates = 0;
    for (let run = 0; run < 300; run += 1) {
      const count = 3 + Math.floor(random() * 12);
      const rate = 5 + random() * 80;
      let miles = 10000 + Math.floor(random() * 50000);
      let day = addDays(TODAY, -Math.floor(random() * 300) - 60);
      const readings: MileageReading[] = [];
      for (let index = 0; index < count; index += 1) {
        readings.push({ day, miles: Math.round(miles) });
        const gap = 5 + Math.floor(random() * 25);
        // Usage changes from reading to reading (half to double the base rate).
        miles += gap * rate * (0.5 + random() * 1.5);
        const next = addDays(day, gap);
        if (next > TODAY) break;
        day = next;
      }
      if (random() < 0.5) readings.push({ day: readings[0].day, miles: readings[0].miles + 200000 });
      const shuffled = readings.map((reading) => ({ reading, key: random() })).sort((a, b) => a.key - b.key).map(({ reading }) => reading);
      const due = readings[readings.length - 1].miles + 100 + Math.floor(random() * 5000);
      const prediction = predictDueDate(due, shuffled, TODAY);
      if ('insufficient' in prediction) {
        assert.ok(['too-few-readings', 'too-short-span', 'too-far'].includes(prediction.insufficient), prediction.insufficient);
        continue;
      }
      estimates += 1;
      assert.ok(prediction.low <= prediction.date && prediction.date <= prediction.high, JSON.stringify(prediction));
      assert.ok(prediction.date >= TODAY);
      assert.ok(prediction.basis >= 3 && prediction.basis <= readings.length);
      // The fitted rate stays within the range the driving actually had.
      assert.ok(prediction.milesPerDay >= rate * 0.5 - 1e-9 && prediction.milesPerDay <= rate * 2 + 1e-9, `${prediction.milesPerDay} vs ${rate}`);
      assert.ok(diffDays(prediction.date, TODAY) <= 730);
      // Order of the input never matters.
      assert.deepEqual(predictDueDate(due, [...shuffled].reverse(), TODAY), prediction);
    }
    assert.ok(estimates > 100, `only ${estimates} runs gave an estimate`);
  });

  it('reads readings from linked logs and a dated current mileage', () => {
    const logs = [
      { id: 'a', targetType: 'vehicle' as const, vehicleId: 'car', date: '2026-10-01', mileage: 39000 },
      { id: 'b', vehicleId: 'car', date: '2026-09-01T02:00:00.000Z', mileage: 38000 },
      { id: 'c', targetType: 'vehicle' as const, vehicleId: 'car', date: '2026-10-05' },
      { id: 'd', targetType: 'vehicle' as const, vehicleId: 'other', date: '2026-10-05', mileage: 1 },
      { id: 'e', targetType: 'general' as const, date: '2026-10-05', mileage: 2 },
    ];
    assert.deepEqual(vehicleReadings({ id: 'car', currentMileage: 40000, mileageUpdatedAt: '2026-11-20T15:00:00.000Z' }, logs, 'America/Chicago'), [
      { day: '2026-10-01', miles: 39000 },
      { day: '2026-08-31', miles: 38000 },
      { day: '2026-11-20', miles: 40000 },
    ]);
    // Without mileageUpdatedAt the current mileage is not a dated reading.
    assert.equal(vehicleReadings({ id: 'car', currentMileage: 40000 }, logs, 'America/Chicago').length, 2);
    const fit = fitMilesPerDay(vehicleReadings({ id: 'car', currentMileage: 40000, mileageUpdatedAt: '2026-11-20' }, logs, 'America/Chicago'), TODAY);
    assert.ok('milesPerDay' in fit && fit.basis === 3 && fit.milesPerDay > 0);
  });
});
