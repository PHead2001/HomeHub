import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  chipOverflow,
  currentMedications,
  FEED_SHORTCUT_PARAM,
  petHref,
  petPhotoMorphName,
  quickFeedDecision,
  quickFeedFood,
  feedingHistoryState,
  wantsQuickFeed,
  feedingCountLabel,
  feedingHeadline,
  feedingPlan,
  feedingStatus,
  formatAgo,
  formatPortion,
  hasRealPhoto,
  loggerName,
  medicationState,
  isNonDailySchedule,
  isValidPortion,
  mergeById,
  newestFirst,
  PORTION_MAX,
  pendingWindowStart,
  nextMedication,
  parseFeedingsPerDay,
  parseLocalDate,
  parsePortion,
  speciesArt,
  toDate,
  validatePetForm,
} from '../../src/lib/pets/care';
import { deviceTimeZone } from '../../src/lib/household-day';

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min);
// `at` builds device-local times; these cases pass the device zone as the household zone.
const LOCAL = deviceTimeZone();
const now = at(2026, 8, 1, 12, 0);

describe('species art', () => {
  it('maps every species and legacy types', () => {
    assert.equal(speciesArt('Dog'), 'dog');
    assert.equal(speciesArt('Cat'), 'cat');
    assert.equal(speciesArt('Bird'), 'bird');
    assert.equal(speciesArt('Fish'), 'fish');
    assert.equal(speciesArt('Small mammal'), 'small-mammal');
    assert.equal(speciesArt('Reptile'), 'reptile');
    assert.equal(speciesArt('Other'), 'other');
  });

  it('uses the photo hint for legacy "Other" pets', () => {
    assert.equal(speciesArt('Other', 'rabbit'), 'small-mammal');
    assert.equal(speciesArt('Other', 'leopard gecko'), 'reptile');
    assert.equal(speciesArt('Other', 'other'), 'other');
    assert.equal(speciesArt(undefined, null), 'other');
  });
});

describe('photos', () => {
  it('treats the legacy placeholder and empty values as no photo', () => {
    assert.equal(hasRealPhoto('https://placehold.co/300x300.png'), false);
    assert.equal(hasRealPhoto(''), false);
    assert.equal(hasRealPhoto(null), false);
    assert.equal(hasRealPhoto('/favicon.ico'), true);
    assert.equal(hasRealPhoto('https://firebasestorage.googleapis.com/v0/b/x/o/pet.png'), true);
  });
});

describe('feeding plan', () => {
  it('parses feedings per day from free text', () => {
    assert.equal(parseFeedingsPerDay('1.5 cups twice daily'), 2);
    assert.equal(parseFeedingsPerDay('One can morning and evening'), 2);
    assert.equal(parseFeedingsPerDay('Twice a day, 8am and 6pm'), 2);
    assert.equal(parseFeedingsPerDay('1 cup at 7am, 12pm and 6pm'), 3);
    assert.equal(parseFeedingsPerDay('3x a day'), 3);
    assert.equal(parseFeedingsPerDay('once daily'), 1);
    assert.equal(parseFeedingsPerDay('free feed'), null);
    assert.equal(parseFeedingsPerDay(''), null);
  });

  it('never turns a non-daily or irregular schedule into a daily target', () => {
    for (const text of [
      '1 scoop twice a week', 'once every other day', 'every 2 days', 'twice weekly', '3x per week', 'once a month',
      'every third day', 'alternate days', 'as needed', 'free feed', 'free-choice hay', 'feed on Mondays and Thursdays',
      '1 cup / week', 'every few days',
    ]) {
      assert.equal(parseFeedingsPerDay(text), null, text);
      assert.equal(isNonDailySchedule(text), true, text);
      assert.equal(feedingPlan({ foodSchedule: text }).perDay, null, text);
    }
  });

  it('reads hourly intervals as a daily count and keeps daily schedules', () => {
    assert.equal(parseFeedingsPerDay('every 8 hours'), 3);
    assert.equal(parseFeedingsPerDay('1/2 can every twelve hours'), 2);
    assert.equal(parseFeedingsPerDay('every 5 hours'), null);
    assert.equal(parseFeedingsPerDay('twice a day'), 2);
    assert.equal(parseFeedingsPerDay('every day at 7am'), 1);
    assert.equal(isNonDailySchedule('1.5 cups twice daily'), false);
  });

  it('parses the usual portion', () => {
    assert.deepEqual(parsePortion('1.5 cups twice daily'), { amount: 1.5, unit: 'Cups' });
    assert.deepEqual(parsePortion('One can morning and evening'), { amount: 1, unit: 'Cans' });
    assert.deepEqual(parsePortion('2 scoops'), { amount: 2, unit: 'Scoops' });
    assert.deepEqual(parsePortion('1/2 cup at night'), { amount: 0.5, unit: 'Cups' });
    assert.deepEqual(parsePortion('half a cup'), { amount: 0.5, unit: 'Cups' });
    assert.equal(parsePortion('whatever she wants'), null);
  });

  it('reads leading-dot decimals whole and never a numeric suffix', () => {
    assert.deepEqual(parsePortion('.5 cups twice daily'), { amount: 0.5, unit: 'Cups' });
    assert.deepEqual(parsePortion('0.75 scoops'), { amount: 0.75, unit: 'Scoops' });
    assert.deepEqual(parsePortion('1.25 cups'), { amount: 1.25, unit: 'Cups' });
    assert.equal(parsePortion('x5 cups'), null);
  });

  it('only produces portions every portion input accepts', () => {
    // Fractions round to two decimals and stay above 0 (feeding form uses step="any").
    assert.deepEqual(parsePortion('1/3 cup twice daily'), { amount: 0.33, unit: 'Cups' });
    assert.deepEqual(parsePortion('1/8 cup'), { amount: 0.13, unit: 'Cups' });
    assert.equal(parsePortion('100 cups'), null);
    for (const text of ['1/3 cup', '1/8 cup', '.5 cups', '2 1/2 scoops', 'half a cup', '50 cups', '0.01 cups']) {
      const portion = parsePortion(text);
      assert.ok(portion && isValidPortion(portion.amount), `${text} -> ${portion?.amount}`);
      assert.deepEqual(validatePetForm({ name: 'X', foodSchedule: text, feedingsPerDay: '', portionAmount: String(portion!.amount) }), {});
    }
    assert.equal(isValidPortion(0), false);
    assert.equal(isValidPortion(PORTION_MAX + 0.01), false);
    assert.deepEqual(feedingPlan({ foodSchedule: '.5 cups twice daily' }), { perDay: 2, amount: 0.5, unit: 'Cups' });
  });

  it('prefers structured fields, then the schedule, then 1 cup', () => {
    assert.deepEqual(feedingPlan({ foodSchedule: '1.5 cups twice daily' }), { perDay: 2, amount: 1.5, unit: 'Cups' });
    assert.deepEqual(
      feedingPlan({ foodSchedule: '1.5 cups twice daily', feedingsPerDay: 3, portionAmount: 0.75, portionUnit: 'Scoops' }),
      { perDay: 3, amount: 0.75, unit: 'Scoops' },
    );
    // An explicitly non-daily schedule has no daily target and says so (PE-18b).
    assert.deepEqual(feedingPlan({ foodSchedule: 'free feed' }), { perDay: null, amount: 1, unit: 'Cups', nonDaily: true });
    assert.deepEqual(feedingPlan({ foodSchedule: 'free feed', feedingsPerDay: 2 }), { perDay: 2, amount: 1, unit: 'Cups' });
  });

  it('formats portions with correct singular and plural units', () => {
    assert.equal(formatPortion(1, 'Cups'), '1 cup');
    assert.equal(formatPortion(1.5, 'Cups'), '1.5 cups');
    assert.equal(formatPortion(2, 'Cans'), '2 cans');
    assert.equal(formatPortion(1, 'Other'), '1 portion');
    assert.equal(formatPortion(0.333333, 'Scoops'), '0.33 scoops');
  });
});

describe('feeding status', () => {
  const logs = [
    { date: at(2026, 8, 1, 7, 30), loggedByName: 'Sam', loggedByUid: 'u1' },
    { date: at(2026, 7, 31, 18, 0), loggedByName: 'Alex', loggedByUid: 'u2' },
  ];

  it('counts today, finds the latest and fills the ring', () => {
    const status = feedingStatus(logs, { perDay: 2 }, now, LOCAL);
    assert.equal(status.fedToday, 1);
    assert.equal(status.progress, 0.5);
    assert.equal(status.complete, false);
    assert.equal(status.last?.by, 'Sam');
    assert.equal(feedingHeadline(status, now, LOCAL), 'Fed 4 h ago by Sam');
    assert.equal(feedingCountLabel(status), '1 of 2 today');
  });

  it('marks the day complete when the target is met', () => {
    const status = feedingStatus([...logs, { date: at(2026, 8, 1, 11, 0) }], { perDay: 2 }, now, LOCAL);
    assert.equal(status.fedToday, 2);
    assert.equal(status.complete, true);
    assert.equal(status.progress, 1);
    assert.equal(feedingHeadline(status, now, LOCAL), 'Fed 1 h ago');
  });

  it('handles no target, no logs, string and Timestamp-like dates', () => {
    const empty = feedingStatus([], { perDay: null }, now, LOCAL);
    assert.equal(feedingHeadline(empty, now, LOCAL), 'No feedings logged yet');
    assert.equal(feedingCountLabel(empty), 'Not fed today');
    const mixed = feedingStatus(
      [{ date: at(2026, 8, 1, 9).toISOString() }, { date: { toDate: () => at(2026, 8, 1, 10) } }],
      { perDay: null },
      now,
      LOCAL,
    );
    assert.equal(mixed.fedToday, 2);
    assert.equal(feedingCountLabel(mixed), '2 today');
    assert.equal(mixed.progress, 1);
  });

  it('formats relative times', () => {
    assert.equal(formatAgo(at(2026, 8, 1, 11, 59), now, LOCAL), '1 min ago');
    assert.equal(formatAgo(new Date(now.getTime() - 30_000), now, LOCAL), 'just now');
    assert.equal(formatAgo(at(2026, 7, 31, 20), now, LOCAL), 'yesterday');
    assert.equal(formatAgo(at(2026, 7, 28, 20), now, LOCAL), '4 days ago');
    assert.match(formatAgo(at(2026, 7, 1), now, LOCAL), /^on /);
  });
});

describe('medication countdown', () => {
  it('uses the latest entry per medication and picks the earliest due', () => {
    const due = nextMedication(
      [
        { date: '2026-07-01T10:00:00.000Z', medication: 'Flea prevention', dosage: '1 dose', nextDueDate: '2026-07-29' },
        { date: '2026-07-29T10:00:00.000Z', medication: 'flea prevention', dosage: '1 dose', nextDueDate: '2026-08-26' },
        { date: '2026-07-30T10:00:00.000Z', medication: 'Heartworm', dosage: '1 chew', nextDueDate: '2026-08-03' },
        { date: '2026-07-30T10:00:00.000Z', medication: 'Ear drops', dosage: '2 drops' },
      ],
      now,
      LOCAL,
    );
    assert.equal(due?.medication, 'Heartworm');
    assert.equal(due?.days, 2);
    assert.equal(due?.state, 'soon');
    assert.equal(due?.label, 'Due in 2 days');
  });

  it('lists every current medication, most urgent first (one rule for chips and the calendar)', () => {
    const logs = [
      { date: '2026-07-01T10:00:00.000Z', medication: 'Flea prevention', dosage: '1 dose', nextDueDate: '2026-07-29' },
      { date: '2026-07-29T10:00:00.000Z', medication: 'flea prevention', dosage: '1 dose', nextDueDate: '2026-08-26' },
      { date: '2026-07-30T10:00:00.000Z', medication: 'Heartworm', dosage: '1 chew', nextDueDate: '2026-08-03' },
      { date: '2026-07-30T10:00:00.000Z', medication: 'Joint support', dosage: '1 tab', nextDueDate: '2026-07-30' },
      // A later dose without a next date cancels that medication's countdown.
      { date: '2026-07-20T10:00:00.000Z', medication: 'Ear drops', dosage: '2 drops', nextDueDate: '2026-08-02' },
      { date: '2026-07-30T10:00:00.000Z', medication: 'Ear drops', dosage: '2 drops' },
      { date: '2026-07-30T10:00:00.000Z', medication: 'Antibiotic', dosage: '1', nextDueDate: '2026-08-03' },
    ];
    const dues = currentMedications(logs, now, LOCAL);
    assert.deepEqual(dues.map((due) => [due.medication, due.label]), [
      ['Joint support', 'Overdue by 2 days'],
      ['Antibiotic', 'Due in 2 days'],
      ['Heartworm', 'Due in 2 days'],
      ['flea prevention', 'Due in 25 days'],
    ]);
    assert.equal(nextMedication(logs, now, LOCAL)?.medication, dues[0].medication);
    assert.deepEqual(currentMedications([], now, LOCAL), []);
  });

  it('folds extra chips into +N, never +1', () => {
    assert.deepEqual(chipOverflow([1, 2], 2), { shown: [1, 2], hidden: 0 });
    assert.deepEqual(chipOverflow([1, 2, 3], 2), { shown: [1, 2, 3], hidden: 0 });
    assert.deepEqual(chipOverflow([1, 2, 3, 4], 2), { shown: [1, 2], hidden: 2 });
    assert.deepEqual(chipOverflow([1, 2, 3, 4, 5, 6], 4), { shown: [1, 2, 3, 4], hidden: 2 });
    assert.deepEqual(chipOverflow([1, 2, 3], 0), { shown: [1], hidden: 2 });
  });

  it('returns null without due dates and labels every state', () => {
    assert.equal(nextMedication([{ date: '2026-07-30', medication: 'X', dosage: '1' }], now), null);
    assert.deepEqual(medicationState(-3), { state: 'overdue', label: 'Overdue by 3 days' });
    assert.deepEqual(medicationState(-1), { state: 'overdue', label: 'Overdue by 1 day' });
    assert.deepEqual(medicationState(0), { state: 'due', label: 'Due today' });
    assert.deepEqual(medicationState(1), { state: 'soon', label: 'Due tomorrow' });
    assert.deepEqual(medicationState(10), { state: 'upcoming', label: 'Due in 10 days' });
  });

  it('keeps a monthly dose pending beyond any history window', () => {
    const monthly = { id: 'm1', date: '2026-07-05T09:00:00.000Z', medication: 'Flea prevention', dosage: '1 dose', nextDueDate: '2026-08-04' };
    // 60 later twice-daily doses of another medication, none dated.
    const daily = Array.from({ length: 60 }, (_, i) => ({
      id: `d${i}`, date: new Date(Date.UTC(2026, 6, 6) + i * 12 * 3_600_000).toISOString(), medication: 'Antibiotic', dosage: '1 pill',
    }));
    const since = pendingWindowStart([monthly]);
    assert.equal(since?.toISOString(), monthly.date);
    const recent = daily.filter((log) => new Date(log.date) >= since!);
    const due = nextMedication(mergeById([monthly], recent), now);
    assert.equal(due?.medication, 'Flea prevention');
    assert.equal(due?.label, 'Due in 3 days');
    // The newest 50 entries alone would have lost it.
    assert.equal(nextMedication(daily.slice(-50), now), null);
  });

  it('lets a later undated dose of the same medication supersede a due date', () => {
    const dated = [{ id: 'a', date: '2026-07-01T09:00:00.000Z', medication: 'Heartworm', dosage: '1 chew', nextDueDate: '2026-07-31' }];
    const since = pendingWindowStart(dated);
    const recent = [...dated, { id: 'b', date: '2026-07-31T09:00:00.000Z', medication: 'heartworm', dosage: '1 chew' }];
    assert.ok(recent.every((log) => new Date(log.date) >= since!));
    assert.equal(nextMedication(mergeById(dated, recent), now), null);
  });

  it('starts the window at the oldest pending medication and ignores undated entries', () => {
    assert.equal(pendingWindowStart([]), null);
    assert.equal(pendingWindowStart([{ date: '2026-07-01T00:00:00.000Z', medication: 'X', nextDueDate: '' }]), null);
    assert.equal(
      pendingWindowStart([
        { date: '2026-06-01T00:00:00.000Z', medication: 'A', nextDueDate: '2026-07-01' },
        { date: '2026-07-01T00:00:00.000Z', medication: 'a', nextDueDate: '2026-08-01' },
        { date: '2026-07-10T00:00:00.000Z', medication: 'B', nextDueDate: '2026-08-10' },
      ])?.toISOString(),
      '2026-07-01T00:00:00.000Z',
    );
    // Legacy Timestamp-shaped dates count too.
    assert.equal(
      pendingWindowStart([{ date: { toDate: () => new Date('2026-06-15T00:00:00.000Z') }, medication: 'C', nextDueDate: '2026-07-15' }])?.toISOString(),
      '2026-06-15T00:00:00.000Z',
    );
  });

  it('parses only real calendar dates', () => {
    assert.equal(parseLocalDate('2026-08-26')?.getDate(), 26);
    assert.equal(parseLocalDate('2026-02-30'), null);
    assert.equal(parseLocalDate('next week'), null);
    assert.equal(toDate('not a date'), null);
  });
});

describe('mixed date shapes', () => {
  it('orders Timestamp, Date and ISO-string entries chronologically and applies the limit after merging', () => {
    // 20 legacy ISO-string feedings, all older than one new Timestamp feeding.
    const legacy = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, date: new Date(Date.UTC(2026, 5, 1 + i)).toISOString() }));
    const fresh = [{ id: 't1', date: { toDate: () => new Date('2026-08-01T11:00:00.000Z') } }];
    const merged = newestFirst<{ id: string; date: unknown }>([fresh, legacy], 20);
    assert.equal(merged.length, 20);
    assert.equal(merged[0].id, 't1');
    assert.equal(merged[1].id, 's19');
    assert.equal(merged.at(-1)?.id, 's1');
  });

  it('dedupes by id and puts unreadable dates last', () => {
    const merged = newestFirst<{ id: string; date: unknown }>([
      [{ id: 'a', date: 'not a date' }, { id: 'b', date: new Date('2026-07-01') }],
      [{ id: 'b', date: new Date('2026-07-01') }, { id: 'c', date: '2026-07-02T00:00:00.000Z' }],
    ], 10);
    assert.deepEqual(merged.map((entry) => entry.id), ['c', 'b', 'a']);
  });
});

describe('who logged', () => {
  it('prefers first name, then display name, and never uses the email', () => {
    assert.equal(loggerName({ firstName: 'Alex', displayName: 'Alex E2E' }), 'Alex');
    assert.equal(loggerName({ firstName: '', displayName: 'Sam Member' }), 'Sam');
    assert.equal(loggerName({ email: 'casey@example.test' } as never), 'Someone');
    assert.equal(loggerName({ firstName: 'casey@example.test', displayName: 'casey@example.test' }), 'Someone');
    assert.equal(loggerName({ displayName: 'casey@example.test Casey' }), 'Someone');
  });
});

describe('pet form validation', () => {
  const valid = { name: 'Maple', foodSchedule: '1 cup twice daily', feedingsPerDay: '', portionAmount: '' };

  it('accepts a minimal pet', () => {
    assert.deepEqual(validatePetForm(valid), {});
  });

  it('reports inline field problems', () => {
    const errors = validatePetForm({ name: ' ', foodSchedule: '', feedingsPerDay: '1.5', portionAmount: '0' });
    assert.ok(errors.name);
    assert.ok(errors.foodSchedule);
    assert.ok(errors.feedingsPerDay);
    assert.ok(errors.portionAmount);
  });

  it('never blocks editing a pet created before a rule existed', () => {
    const legacy = {
      name: 'A very long legacy pet name that is well over forty characters',
      foodSchedule: 'x'.repeat(260),
      feedingsPerDay: '',
      portionAmount: '',
    };
    // Unchanged legacy values pass when the stored values are given.
    assert.deepEqual(validatePetForm(legacy, [], legacy), {});
    // A changed value still follows the rules.
    const changed = validatePetForm({ ...legacy, foodSchedule: 'y'.repeat(260), feedingsPerDay: '20' }, [], legacy);
    assert.ok(changed.foodSchedule);
    assert.ok(changed.feedingsPerDay);
    assert.equal(changed.name, undefined);
    // Without stored values (adding), the name rule applies.
    assert.ok(validatePetForm(legacy).name);
    // An empty schedule is still required.
    assert.ok(validatePetForm({ ...legacy, foodSchedule: ' ' }, [], legacy).foodSchedule);
  });

  it('ignores an out-of-range stored portion for the feeding plan', () => {
    assert.deepEqual(feedingPlan({ foodSchedule: '2 cups daily', portionAmount: 80, portionUnit: 'Cups' }), { perDay: 1, amount: 2, unit: 'Cups' });
  });

  it('rejects duplicate names case-insensitively', () => {
    assert.match(validatePetForm({ ...valid, name: 'pixel' }, ['Pixel']).name ?? '', /already have a pet named pixel/);
  });
});

describe('pets components use tokens only', () => {
  it('has no raw color literals', () => {
    const dir = resolve(process.cwd(), 'src/components/pets');
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), 'utf8');
      assert.doesNotMatch(text, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|\bhsl\((?!var\()/i, `${file} uses a raw color`);
    }
  });

  it('every live-log consumer handles load errors separately from empty results', () => {
    // A failed subscription returns { logs: [], error }; rendering it as an empty
    // history would read as "not fed" or "nothing due".
    const files = ['src/components/feeding-log.tsx', 'src/components/medication-log.tsx', 'src/components/care-log.tsx', 'src/components/pets/pet-care-summary.tsx'];
    const hookCall = /const\s+(\w+|\{[^}]*\})\s*=\s*(?:usePetLogs|useMedicationCountdownLogs)\W/g;
    for (const file of files) {
      const text = readFileSync(resolve(process.cwd(), file), 'utf8');
      const calls = [...text.matchAll(hookCall)];
      assert.ok(calls.length > 0, `${file} uses a live-log hook`);
      for (const [, binding] of calls) {
        const handled = binding.startsWith('{')
          ? binding.includes('error') && ['error ?', '!error', '&& error', '|| error'].some((use) => text.includes(use))
          : text.includes(`${binding}.error`);
        assert.ok(handled, `${file}: ${binding} ignores its error`);
      }
    }
    const offenders = readdirSync(resolve(process.cwd(), 'src/components'), { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.tsx?$/.test(file))
      .filter((file) => /(?:usePetLogs|useMedicationCountdownLogs)\W/.test(readFileSync(resolve(process.cwd(), 'src/components', file), 'utf8')))
      .map((file) => `src/components/${file.split(String.fromCharCode(92)).join('/')}`)
      .filter((file) => !files.includes(file) && !file.endsWith('pet-log-api.ts'));
    assert.deepEqual(offenders, [], 'new consumers must be added to this check');
  });

  it('keeps every pets animation behind both reduced-motion selectors', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/pets/pets.module.css'), 'utf8');
    assert.match(css, /html\[data-motion='reduce'\]\) \.eyes/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /html\[data-visibility='hidden'\]\) \.eyes/);
  });

  it('idles the species art on a slow ambient loop that pauses and stops under reduced motion', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/pets/pets.module.css'), 'utf8');
    const loop = css.match(/\.idle \{[^}]*animation: pet-idle (\d+)s/);
    assert.ok(loop, 'the idle loop exists');
    assert.ok(Number(loop![1]) >= 20, 'ambient loops are 20 s or longer');
    // Small amplitude: at most 2 px and 2 degrees at the strongest preset intensity
    // (7%, so 7/6 of the base amplitude scaled by --ambient-scale).
    const start = css.indexOf('@keyframes pet-idle');
    const frames = css.slice(start, css.indexOf('\n}', start) + 2);
    const px = [...frames.matchAll(/translateY\(calc\((-?[\d.]+)px \* var\(--ambient-scale, 1\)\)\)/g)];
    const deg = [...frames.matchAll(/rotate\(calc\((-?[\d.]+)deg \* var\(--ambient-scale, 1\)\)\)/g)];
    assert.ok(px.length > 0 && deg.length > 0, 'the sway scales with the ambient token');
    for (const [, value] of [...px, ...deg]) assert.ok(Math.abs(Number(value)) * (0.07 / 0.06) <= 2);
    assert.match(css, /html\[data-visibility='hidden'\]\) \.idle/);
    assert.match(css, /html\[data-motion='reduce'\]\) \.idle/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.eyes,\s*\.idle,/);
    const avatar = readFileSync(resolve(process.cwd(), 'src/components/pets/species-avatar.tsx'), 'utf8');
    assert.match(avatar, /className=\{styles\.idle\}/);
  });
});

describe('pet links, morph and shortcut', () => {
  it('names the card photo and the pet hero alike, and reads the feed shortcut', () => {
    assert.equal(petHref('maple'), '/pets/maple');
    assert.equal(petPhotoMorphName('maple'), 'pet-maple-photo');
    assert.equal(petPhotoMorphName('a b'), 'pet-a_b-photo');
    assert.equal(FEED_SHORTCUT_PARAM, 'feed');
    assert.equal(wantsQuickFeed(new URLSearchParams('feed=1')), true);
    assert.equal(wantsQuickFeed(new URLSearchParams('feed=0')), false);
    assert.equal(wantsQuickFeed(new URLSearchParams('')), false);
    assert.equal(wantsQuickFeed(null), false);
  });

  it('the Feed button is one tap with Undo; only the shortcut confirms', () => {
    const button = readFileSync(resolve(process.cwd(), 'src/components/pets/quick-feed-button.tsx'), 'utf8');
    // Owner decision (H09): one reversible tap is the accessible alternative to holding.
    assert.match(button, /onClick=\{\(\) => void quick\.feed\('tap'\)\}/);
    assert.doesNotMatch(button, /Popover/);
    assert.match(button, /Undo/);
    // The launcher shortcut never logs silently: its picker ends in a confirm step.
    const picker = readFileSync(resolve(process.cwd(), 'src/components/pets/feed-picker-dialog.tsx'), 'utf8');
    assert.match(picker, /FeedConfirmPanel/);
    const manifest = readFileSync(resolve(process.cwd(), 'src/app/manifest.ts'), 'utf8');
    assert.match(manifest, /url: '\/pets\?feed=1'/);
  });

  it('never logs a quick feeding before the history says which food the pet eats', () => {
    assert.equal(feedingHistoryState({ loading: true, error: null }), 'loading');
    assert.equal(feedingHistoryState({ loading: false, error: new Error('denied') }), 'unavailable');
    assert.equal(feedingHistoryState({ loading: false, error: null }), 'ready');
    // Loading: not ready, so Confirm, the Feed button and hold stay disabled.
    assert.equal(quickFeedFood('loading', 'Wet').ready, false);
    // Loaded: the latest feeding's type; Dry only for a pet with no (known) history.
    assert.deepEqual(quickFeedFood('ready', 'Wet'), { ready: true, foodType: 'Wet', fallback: false });
    assert.deepEqual(quickFeedFood('ready', undefined), { ready: true, foodType: 'Dry', fallback: false });
    assert.deepEqual(quickFeedFood('ready', 'Kibble'), { ready: true, foodType: 'Dry', fallback: false });
    // Unavailable history is not empty history: Dry, flagged so the UI says so.
    assert.deepEqual(quickFeedFood('unavailable', undefined), { ready: true, foodType: 'Dry', fallback: true });
    const button = readFileSync(resolve(process.cwd(), 'src/components/pets/quick-feed-button.tsx'), 'utf8');
    assert.match(button, /if \(!allowed \|\| !ready \|\|/);
    assert.equal((button.match(/disabled=\{quick\.saving \|\| !quick\.ready\}/g) ?? []).length, 2, 'Feed button and Confirm');
    assert.match(button, /last feeding unavailable/);
    const hold = readFileSync(resolve(process.cwd(), 'src/components/pets/hold-to-feed.tsx'), 'utf8');
    assert.match(hold, /!feed\.ready/);
  });

  it('decides ?feed=1 only once permissions and pets have both loaded', () => {
    const base = { requested: true, permissionsReady: true, petsReady: true, canFeed: true, petCount: 2 };
    assert.equal(quickFeedDecision({ ...base, requested: false }), 'none');
    // Pets loaded before the membership (the race): wait, never ignore.
    assert.equal(quickFeedDecision({ ...base, permissionsReady: false, canFeed: false }), 'wait');
    assert.equal(quickFeedDecision({ ...base, petsReady: false, petCount: 0 }), 'wait');
    assert.equal(quickFeedDecision(base), 'open');
    assert.equal(quickFeedDecision({ ...base, petCount: 1 }), 'open');
    assert.equal(quickFeedDecision({ ...base, canFeed: false }), 'ignore');
    assert.equal(quickFeedDecision({ ...base, petCount: 0 }), 'ignore');
    const client = readFileSync(resolve(process.cwd(), 'src/components/pets-client.tsx'), 'utf8');
    assert.match(client, /permissionsReady: !authLoading && !householdLoading && Boolean\(currentMember\)/);
    // The param is removed only after a decision.
    assert.match(client, /if \(!handledFeedRequest \|\| !feedRequested\) return;/);
  });
});
