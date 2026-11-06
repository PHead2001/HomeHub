import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  feedingCountLabel,
  feedingHeadline,
  feedingPlan,
  feedingStatus,
  formatAgo,
  formatPortion,
  hasRealPhoto,
  loggerName,
  medicationState,
  nextMedication,
  parseFeedingsPerDay,
  parseLocalDate,
  parsePortion,
  speciesArt,
  toDate,
  validatePetForm,
} from '../../src/lib/pets/care';

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min);
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

  it('parses the usual portion', () => {
    assert.deepEqual(parsePortion('1.5 cups twice daily'), { amount: 1.5, unit: 'Cups' });
    assert.deepEqual(parsePortion('One can morning and evening'), { amount: 1, unit: 'Cans' });
    assert.deepEqual(parsePortion('2 scoops'), { amount: 2, unit: 'Scoops' });
    assert.deepEqual(parsePortion('1/2 cup at night'), { amount: 0.5, unit: 'Cups' });
    assert.deepEqual(parsePortion('half a cup'), { amount: 0.5, unit: 'Cups' });
    assert.equal(parsePortion('whatever she wants'), null);
  });

  it('prefers structured fields, then the schedule, then 1 cup', () => {
    assert.deepEqual(feedingPlan({ foodSchedule: '1.5 cups twice daily' }), { perDay: 2, amount: 1.5, unit: 'Cups' });
    assert.deepEqual(
      feedingPlan({ foodSchedule: '1.5 cups twice daily', feedingsPerDay: 3, portionAmount: 0.75, portionUnit: 'Scoops' }),
      { perDay: 3, amount: 0.75, unit: 'Scoops' },
    );
    assert.deepEqual(feedingPlan({ foodSchedule: 'free feed' }), { perDay: null, amount: 1, unit: 'Cups' });
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
    const status = feedingStatus(logs, { perDay: 2 }, now);
    assert.equal(status.fedToday, 1);
    assert.equal(status.progress, 0.5);
    assert.equal(status.complete, false);
    assert.equal(status.last?.by, 'Sam');
    assert.equal(feedingHeadline(status, now), 'Fed 4 h ago by Sam');
    assert.equal(feedingCountLabel(status), '1 of 2 today');
  });

  it('marks the day complete when the target is met', () => {
    const status = feedingStatus([...logs, { date: at(2026, 8, 1, 11, 0) }], { perDay: 2 }, now);
    assert.equal(status.fedToday, 2);
    assert.equal(status.complete, true);
    assert.equal(status.progress, 1);
    assert.equal(feedingHeadline(status, now), 'Fed 1 h ago');
  });

  it('handles no target, no logs, string and Timestamp-like dates', () => {
    const empty = feedingStatus([], { perDay: null }, now);
    assert.equal(feedingHeadline(empty, now), 'No feedings logged yet');
    assert.equal(feedingCountLabel(empty), 'Not fed today');
    const mixed = feedingStatus(
      [{ date: at(2026, 8, 1, 9).toISOString() }, { date: { toDate: () => at(2026, 8, 1, 10) } }],
      { perDay: null },
      now,
    );
    assert.equal(mixed.fedToday, 2);
    assert.equal(feedingCountLabel(mixed), '2 today');
    assert.equal(mixed.progress, 1);
  });

  it('formats relative times', () => {
    assert.equal(formatAgo(at(2026, 8, 1, 11, 59), now), '1 min ago');
    assert.equal(formatAgo(new Date(now.getTime() - 30_000), now), 'just now');
    assert.equal(formatAgo(at(2026, 7, 31, 20), now), 'yesterday');
    assert.equal(formatAgo(at(2026, 7, 28, 20), now), '4 days ago');
    assert.match(formatAgo(at(2026, 7, 1), now), /^on /);
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
    );
    assert.equal(due?.medication, 'Heartworm');
    assert.equal(due?.days, 2);
    assert.equal(due?.state, 'soon');
    assert.equal(due?.label, 'Due in 2 days');
  });

  it('returns null without due dates and labels every state', () => {
    assert.equal(nextMedication([{ date: '2026-07-30', medication: 'X', dosage: '1' }], now), null);
    assert.deepEqual(medicationState(-3), { state: 'overdue', label: 'Overdue by 3 days' });
    assert.deepEqual(medicationState(-1), { state: 'overdue', label: 'Overdue by 1 day' });
    assert.deepEqual(medicationState(0), { state: 'due', label: 'Due today' });
    assert.deepEqual(medicationState(1), { state: 'soon', label: 'Due tomorrow' });
    assert.deepEqual(medicationState(10), { state: 'upcoming', label: 'Due in 10 days' });
  });

  it('parses only real calendar dates', () => {
    assert.equal(parseLocalDate('2026-08-26')?.getDate(), 26);
    assert.equal(parseLocalDate('2026-02-30'), null);
    assert.equal(parseLocalDate('next week'), null);
    assert.equal(toDate('not a date'), null);
  });
});

describe('who logged', () => {
  it('prefers first name, then display name, then the email local part', () => {
    assert.equal(loggerName({ firstName: 'Alex', displayName: 'Alex E2E' }), 'Alex');
    assert.equal(loggerName({ firstName: '', displayName: 'Sam Member' }), 'Sam');
    assert.equal(loggerName({ email: 'casey@example.test' }), 'casey');
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

  it('keeps every pets animation behind both reduced-motion selectors', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/pets/pets.module.css'), 'utf8');
    assert.match(css, /html\[data-motion='reduce'\]\) \.eyes/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /html\[data-visibility='hidden'\]\) \.eyes/);
  });
});
