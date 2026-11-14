import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  calendarDaysBetween,
  currentMedications,
  feedingCountLabel,
  feedingHeadline,
  feedingPlan,
  feedingStatus,
  formatAgo,
  petDay,
  petTabFromParam,
  readableLogDate,
  speciesHintFor,
  UNIT_LABELS,
} from '../../src/lib/pets/care';
import { buildMedicationReminders } from '../../functions/src/shared/medication-reminders';
import { computePetFacts } from '../../src/lib/dashboard/facts';
import { createMinuteClock, type ClockEnvironment } from '../../src/lib/pets/minute-clock';

const CHI = 'America/Chicago';
const at = (iso: string) => new Date(iso);

describe('Pets "today" is the household day, not the device day (PE-7a-c)', () => {
  // 00:30 on Nov 11 in Chicago; 06:30 UTC.
  const now = at('2026-11-11T06:30:00Z');
  // 23:00 on Nov 10 in Chicago.
  const lateFeed = { date: at('2026-11-11T05:00:00Z'), loggedByName: 'Sam' };

  it('the ring and "n of N today" count the household day across midnight', () => {
    const chicago = feedingStatus([lateFeed], { perDay: 2 }, now, CHI);
    assert.equal(chicago.fedToday, 0, 'fed yesterday evening in Chicago');
    assert.equal(feedingCountLabel(chicago), '0 of 2 today');
    // The same instant on a household in London is the same morning.
    assert.equal(feedingStatus([lateFeed], { perDay: 2 }, now, 'Europe/London').fedToday, 1);
  });

  it('relative time is right across midnight: 23:00 reads "1 h ago" at 00:30, not "yesterday" (PE-8h)', () => {
    assert.equal(formatAgo(lateFeed.date, now, CHI), '1 h ago');
    assert.equal(feedingHeadline(feedingStatus([lateFeed], { perDay: 2 }, now, CHI), now, CHI), 'Fed 1 h ago by Sam');
    // Later the next day it is "yesterday", by household days.
    assert.equal(formatAgo(lateFeed.date, at('2026-11-11T20:00:00Z'), CHI), 'yesterday');
    assert.equal(formatAgo(at('2026-11-08T15:00:00Z'), now, CHI), '3 days ago');
    // A time ahead of now (another device's clock) is "just now".
    assert.equal(formatAgo(at('2026-11-11T06:35:00Z'), now, CHI), 'just now');
  });

  it('daylight-saving days count once: fall back (25 h) and spring forward (23 h)', () => {
    // 2026-11-01: Chicago falls back at 02:00. 00:30 and 23:30 that day are 24 h apart but one day.
    const morning = at('2026-11-01T05:30:00Z'); // 00:30 CDT
    const night = at('2026-11-02T05:30:00Z'); // 23:30 CST
    assert.equal(petDay(morning, CHI), '2026-11-01');
    assert.equal(petDay(night, CHI), '2026-11-01');
    assert.equal(feedingStatus([{ date: morning }], { perDay: 3 }, night, CHI).fedToday, 1);
    assert.equal(calendarDaysBetween(morning, night, CHI), 0);
    // 2026-03-08: Chicago springs forward. Noon to noon over it is still one day.
    assert.equal(calendarDaysBetween(at('2026-03-07T18:00:00Z'), at('2026-03-08T17:00:00Z'), CHI), 1);
    assert.equal(calendarDaysBetween(at('2026-03-07T18:00:00Z'), at('2026-03-09T17:00:00Z'), CHI), 2);
  });

  it('medication "Due today" uses the household day and agrees with the server reminder (PE-7b)', () => {
    const logs = [{ date: '2026-11-01T15:00:00.000Z', medication: 'Heartworm', dosage: '1 chew', nextDueDate: '2026-11-11' }];
    // 23:30 on Nov 10 in Chicago (05:30 UTC on Nov 11).
    const lateNight = at('2026-11-11T05:30:00Z');
    assert.equal(currentMedications(logs, lateNight, CHI)[0].label, 'Due tomorrow');
    assert.equal(currentMedications(logs, lateNight, 'UTC')[0].label, 'Due today');
    // The server reminder for the same household day: nothing due yet; then due at household midnight.
    assert.deepEqual(buildMedicationReminders([{ id: 'rex', name: 'Rex', logs }], petDay(lateNight, CHI)), []);
    const afterMidnight = at('2026-11-11T06:05:00Z');
    assert.equal(currentMedications(logs, afterMidnight, CHI)[0].state, 'due');
    assert.equal(buildMedicationReminders([{ id: 'rex', name: 'Rex', logs }], petDay(afterMidnight, CHI))[0].state, 'due');
  });

  it('the dashboard pet facts use the household day too', () => {
    const facts = computePetFacts([{ id: 'rex', name: 'Rex', feedingsPerDay: 1 }], { rex: [lateFeed] }, now, CHI);
    assert.equal(facts.pets[0].countLabel, '0 of 1 today');
    assert.equal(facts.pets[0].fed, false);
    assert.equal(facts.pets[0].headline, 'Fed 1 h ago by Sam');
  });

  it('every Pets day consumer takes the household zone', () => {
    const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
    assert.match(read('src/components/pets/pet-care-summary.tsx'), /feedingStatus\(feedings\.logs, plan, now, timeZone\)/);
    assert.match(read('src/components/pets/pet-care-summary.tsx'), /currentMedications\(medications\.logs, now, timeZone\)/);
    assert.match(read('src/components/medication-log.tsx'), /currentMedications\(pending\.logs, now, timeZone\)/);
    assert.match(read('src/lib/dashboard/facts.ts'), /feedingStatus\(logs, plan, now, timeZone\)/);
    // No device-local day helper is left in the Pets model.
    assert.doesNotMatch(read('src/lib/pets/care.ts'), /isSameLocalDay|getFullYear\(\)/);
  });
});

describe('one shared minute clock (PE-21c, PE-7d)', () => {
  function fakeEnvironment(start: Date) {
    let time = start.getTime();
    const timers: { at: number; callback: () => void; id: number }[] = [];
    let nextId = 1;
    const listeners = new Map<string, Set<() => void>>();
    const target = {
      addEventListener: (type: string, fn: () => void) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(fn); },
      removeEventListener: (type: string, fn: () => void) => { listeners.get(type)?.delete(fn); },
    };
    const environment: ClockEnvironment = {
      now: () => new Date(time),
      setTimeout: (callback, ms) => { const id = nextId++; timers.push({ at: time + ms, callback, id }); return id; },
      clearTimeout: (handle) => { const index = timers.findIndex((timer) => timer.id === handle); if (index >= 0) timers.splice(index, 1); },
      window: target as unknown as ClockEnvironment['window'],
      document: Object.assign(target, { visibilityState: 'visible' }) as unknown as ClockEnvironment['document'],
    };
    const advance = (ms: number) => {
      const end = time + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const due = timers[0];
        if (!due || due.at > end) break;
        timers.shift();
        time = due.at;
        due.callback();
      }
      time = end;
    };
    return { environment, advance, timers, fire: (type: string) => listeners.get(type)?.forEach((fn) => fn()), setTime: (t: Date) => { time = t.getTime(); } };
  }

  it('one timer for every subscriber, ticking on the minute boundary, rolling over at household midnight', () => {
    // 23:59:30 on Nov 10 in Chicago.
    const fake = fakeEnvironment(at('2026-11-11T05:59:30Z'));
    const clock = createMinuteClock(fake.environment);
    const seen: string[] = [];
    const stops = [1, 2, 3].map(() => clock.subscribe(() => seen.push(petDay(clock.now(), CHI))));
    assert.equal(fake.timers.length, 1, 'one timer, not one per card');
    const before = clock.now();
    assert.equal(clock.now(), before, 'a stable snapshot within the minute');
    assert.equal(petDay(before, CHI), '2026-11-10');
    fake.advance(31_000);
    assert.equal(petDay(clock.now(), CHI), '2026-11-11', 'the new household day without a reload');
    assert.deepEqual(seen, ['2026-11-11', '2026-11-11', '2026-11-11']);
    stops.forEach((stop) => stop());
    assert.equal(fake.timers.length, 0, 'no timer once nobody listens');
  });

  it('wake events (online, pageshow, visible) replace the pending timer instead of adding a chain', () => {
    const fake = fakeEnvironment(at('2026-11-10T12:00:10Z'));
    const clock = createMinuteClock(fake.environment);
    const stop = clock.subscribe(() => undefined);
    assert.equal(fake.timers.length, 1);
    for (const event of ['online', 'pageshow', 'visibilitychange', 'online', 'pageshow', 'visibilitychange']) {
      fake.fire(event);
      assert.equal(fake.timers.length, 1, `still one pending timer after ${event}`);
    }
    // A wake within the same minute and one after it both keep a single timer.
    fake.setTime(at('2026-11-10T12:03:00Z'));
    fake.fire('online');
    assert.equal(fake.timers.length, 1);
    fake.advance(120_000);
    assert.equal(fake.timers.length, 1);
    stop();
    assert.equal(fake.timers.length, 0, 'nothing left after the last unsubscribe');
  });

  it('catches up at once when the page becomes visible again (timers stall while hidden)', () => {
    const fake = fakeEnvironment(at('2026-11-10T12:00:10Z'));
    const clock = createMinuteClock(fake.environment);
    let ticks = 0;
    const stop = clock.subscribe(() => { ticks += 1; });
    fake.setTime(at('2026-11-10T15:00:10Z'));
    fake.fire('visibilitychange');
    assert.equal(ticks, 1);
    assert.equal(clock.now().toISOString(), '2026-11-10T15:00:10.000Z');
    stop();
  });
});

describe('Pets copy and small fixes (PE-8, PE-18)', () => {
  it('editing a legacy "Other" pet keeps its species art (PE-8a)', () => {
    assert.equal(speciesHintFor('Other', { type: 'Other', dataAiHint: 'rabbit' }), 'rabbit');
    assert.equal(speciesHintFor('Cat', { type: 'Other', dataAiHint: 'rabbit' }), 'cat');
    assert.equal(speciesHintFor('Dog', null), 'dog');
    assert.equal(speciesHintFor('Other', { type: 'Other' }), 'other');
  });

  it('a blank or unreadable log date is unknown, never a crash (PE-8b, PE-8c)', () => {
    assert.equal(readableLogDate(''), null);
    assert.equal(readableLogDate('not a date'), null);
    assert.equal(readableLogDate(undefined), null);
    assert.equal(readableLogDate(new Date(0)), null);
    assert.equal(readableLogDate('2026-11-10T15:00:00.000Z')?.toISOString(), '2026-11-10T15:00:00.000Z');
    // The history renderers use it instead of `new Date(log.date)`.
    const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
    for (const file of ['src/components/medication-log.tsx', 'src/components/care-log.tsx']) {
      assert.match(read(file), /readableLogDate\(log\.date\)/, file);
      assert.doesNotMatch(read(file), /format\(new Date\(log\.date\)/, file);
    }
    assert.doesNotMatch(read('src/components/feeding-log.tsx'), /format\(new Date\(log\.date\)/);
  });

  it('`?tab=` picks a tab, and a change while the page is open switches it (PE-8f)', () => {
    assert.equal(petTabFromParam('medication'), 'medication');
    assert.equal(petTabFromParam('care'), 'care');
    assert.equal(petTabFromParam('bogus'), 'feeding');
    assert.equal(petTabFromParam(null), 'feeding');
    const page = readFileSync(resolve(process.cwd(), 'src/app/pets/[petId]/page.tsx'), 'utf8');
    assert.match(page, /if \(requestedTab !== seenTabParam\)/);
    assert.match(page, /router\.replace\(/);
  });

  it('an off-day of a non-daily schedule is not "Not fed today" (PE-18b)', () => {
    const now = at('2026-11-10T15:00:00Z');
    const plan = feedingPlan({ foodSchedule: '1 cup every other day' });
    assert.equal(plan.nonDaily, true);
    assert.equal(feedingCountLabel(feedingStatus([], plan, now, CHI)), 'No feeding planned daily');
    assert.equal(feedingCountLabel(feedingStatus([], feedingPlan({ foodSchedule: 'some food' }), now, CHI)), 'Not fed today');
  });

  it('units read in lower case in pickers (PE-18e)', () => {
    assert.deepEqual(Object.values(UNIT_LABELS), ['cups', 'cans', 'scoops', 'other']);
  });

  it('pet listeners recover instead of failing for good (PE-8g) and errors say what happened (PE-18c)', () => {
    const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
    for (const file of ['src/components/pets/pet-log-api.ts', 'src/components/pets-client.tsx', 'src/app/pets/[petId]/page.tsx']) {
      assert.match(read(file), /petSnapshotListener/, file);
    }
    assert.doesNotMatch(read('src/components/pets-client.tsx'), /window\.location\.reload/);
    assert.match(read('src/components/pets-client.tsx'), /loadFailed === 'unauthorized'/);
  });

  it('Pets has its own route error boundary (D-P15)', () => {
    const boundary = readFileSync(resolve(process.cwd(), 'src/app/pets/error.tsx'), 'utf8');
    assert.match(boundary, /useCrashRecovery\(error\)/);
    assert.match(boundary, /already saved are safe/);
  });
});
