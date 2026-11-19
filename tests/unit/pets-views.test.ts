/**
 * P4 Pets views, pure parts and source checks: the board status band (PE-9a/b,
 * D-P3), the layouts (D-P1, PE-13a) and the board grid (PE-9d/e, D-P14), the
 * hold caption (PE-12a, D-P17), the reduced-motion ring steps (PE-20a), the
 * household care store (PE-21a), chips (PE-16), touch and detail navigation
 * (PE-11, PE-12b/d), the phone header and pet page order (PE-13b/c) and 48 px
 * form targets (PE-14e).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  BOARD_FIT,
  BOARD_QUERY,
  HOLD_CAPTION_KEY,
  ROWS_QUERY,
  boardGrid,
  boardStatus,
  petsLayoutFor,
  showHoldCaption,
  steppedHoldProgress,
} from '../../src/lib/pets/board';
import type { MedicationDue } from '../../src/lib/pets/care';
import { mealStatus } from '../../src/lib/pets/meal-plan';
import type { MealSlot, PetProfile } from '../../src/lib/pets/types';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
const CHI = 'America/Chicago';
const nov = (day: number, time: string) => {
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, day, h + 6, m));
};
const BREAKFAST: MealSlot = { id: 'breakfast', name: 'Breakfast', time: '07:00', amount: 1, unit: 'Cups' };
const DINNER: MealSlot = { id: 'dinner', name: 'Dinner', time: '18:00', amount: 0.5, unit: 'Cans' };
type Pet = Pick<PetProfile, 'foodSchedule' | 'feedingsPerDay' | 'portionAmount' | 'portionUnit' | 'mealPlan' | 'mealPlanHistory'>;
const slotPet: Pet = { foodSchedule: 'twice daily', mealPlan: { slots: [BREAKFAST, DINNER], effectiveFrom: '2026-11-01' } };
const legacyPet: Pet = { foodSchedule: '1 cup twice daily', feedingsPerDay: 2 };
const fed = (id: string, date: Date, extra: Record<string, unknown> = {}) => ({ id, date, loggedByName: 'Sam', loggedByUid: 'sam', ...extra });
const overdue: MedicationDue = { medication: 'Heartworm', dosage: '1 chew', due: new Date('2026-11-12T12:00:00Z'), dueDay: '2026-11-12', days: -2, state: 'overdue', label: 'Overdue by 2 days' };

const band = (pet: Pet, logs: ReturnType<typeof fed>[], now: Date, dues: MedicationDue[] = []) => {
  const meal = mealStatus(pet, logs, now, CHI);
  // The card's ring view of a slot status (pet-care-summary's `ringView`).
  const status = meal.kind === 'legacy' ? meal.status : { fedToday: meal.day.fedCount, perDay: meal.day.planned || null, progress: 0, complete: meal.complete, last: meal.last };
  return boardStatus({ meal, status, dues, feedingsLoading: false, feedingsFailed: false, medicationFailed: false, now, timeZone: CHI });
};

describe('the board status band (PE-9a/b)', () => {
  it('is amber with "Meal due" once a confirmed meal is due, and the feeding line is the slot status', () => {
    const status = band(slotPet, [fed('a', nov(14, '07:10'), { slotId: 'breakfast' })], nov(14, '18:20'));
    assert.equal(status.tone, 'due');
    assert.equal(status.label, 'Meal due');
    assert.equal(status.line, 'Dinner due 6:00 pm');
  });

  it('is green "Fed" when every meal of today is fed, neutral before a meal is due, amber for a missed one', () => {
    const done = band(slotPet, [fed('a', nov(14, '07:10'), { slotId: 'breakfast' }), fed('b', nov(14, '18:05'), { slotId: 'dinner' })], nov(14, '19:00'));
    assert.deepEqual([done.tone, done.label, done.line], ['fed', 'Fed', 'All 2 meals done today']);
    const afternoon = band(slotPet, [fed('a', nov(14, '07:10'), { slotId: 'breakfast' })], nov(14, '15:00'));
    assert.deepEqual([afternoon.tone, afternoon.label], ['neutral', 'Not due yet']);
    const missed = band(slotPet, [], nov(14, '16:30'));
    assert.deepEqual([missed.tone, missed.label, missed.line], ['due', 'Meal missed', 'Next: dinner at 6:00 pm']);
  });

  it('is red for an overdue medication, over any meal state, with a text label and the medication named', () => {
    const status = band(slotPet, [fed('a', nov(14, '07:10'), { slotId: 'breakfast' })], nov(14, '18:20'), [overdue]);
    assert.equal(status.tone, 'overdue');
    assert.equal(status.label, 'Medication overdue');
    assert.equal(status.line, 'Dinner due 6:00 pm', 'the feeding status stays the big line');
    assert.equal(status.medication, 'Heartworm: overdue by 2 days');
  });

  it('never amber for a pet without confirmed meal times (D-P3); green only when its count is met', () => {
    const none = band(legacyPet, [], nov(14, '20:00'));
    assert.deepEqual([none.tone, none.label], ['neutral', 'Not fed today']);
    const one = band(legacyPet, [fed('a', nov(14, '08:00'))], nov(14, '20:00'));
    assert.deepEqual([one.tone, one.label, one.detail], ['neutral', 'Fed today', '1 of 2 today']);
    const both = band(legacyPet, [fed('a', nov(14, '08:00')), fed('b', nov(14, '18:00'))], nov(14, '20:00'));
    assert.deepEqual([both.tone, both.label, both.line], ['fed', 'Fed', 'All fed today']);
  });

  it('claims nothing while loading or failed (an overdue dose still shows)', () => {
    const base = { meal: null, status: null, dues: [], feedingsLoading: true, feedingsFailed: false, medicationFailed: false, now: nov(14, '12:00') };
    assert.deepEqual(boardStatus(base).tone, 'unknown');
    assert.deepEqual(boardStatus({ ...base, feedingsLoading: false, feedingsFailed: true }).line, 'Feeding status unavailable');
    assert.equal(boardStatus({ ...base, dues: [overdue] }).tone, 'overdue');
    assert.equal(boardStatus({ ...base, dues: [overdue], medicationFailed: true }).tone, 'unknown');
  });
});

describe('layouts and the board grid (D-P1, PE-9d/e, D-P14, PE-13a)', () => {
  it('gives wide landscape screens the board, phones the rows, the rest the grid', () => {
    assert.equal(petsLayoutFor({ board: true, rows: false }), 'board');
    assert.equal(petsLayoutFor({ board: false, rows: true }), 'rows');
    assert.equal(petsLayoutFor({ board: false, rows: false }), 'grid');
    assert.match(BOARD_QUERY, /min-width: 1024px\) and \(orientation: landscape\)/);
    assert.equal(ROWS_QUERY, '(max-width: 639px)');
  });

  it('lets one or two pets fill the screen, fits up to six without scrolling, scrolls inside past six', () => {
    assert.deepEqual(boardGrid(1), { columns: 1, rows: 1, scroll: false });
    assert.deepEqual(boardGrid(2), { columns: 2, rows: 1, scroll: false });
    assert.deepEqual(boardGrid(4), { columns: 2, rows: 2, scroll: false });
    assert.deepEqual(boardGrid(5), { columns: 3, rows: 2, scroll: false });
    assert.deepEqual(boardGrid(BOARD_FIT), { columns: 3, rows: 2, scroll: false });
    assert.deepEqual(boardGrid(9), { columns: 3, rows: 3, scroll: true });
  });

  it('hides the subtitle on the board and sizes the status text above the name (PE-9a, PE-9f)', () => {
    const card = read('src/components/pets/living-pet-card.tsx');
    assert.match(card, /text-2xl font-bold[^"]*" data-testid="pet-status-line"/);
    assert.match(card, /<NameLink pet=\{pet\} model=\{model\} className="text-lg" \/>/);
    assert.match(card, /'h-40 w-40' : 'h-20 w-20'/, 'an 80 px avatar, larger for one or two pets');
    assert.match(read('src/components/pets-client.tsx'), /<PetsPageHeader action=\{addButton\} subtitle=\{layout !== 'board'\} \/>/);
  });
});

describe('touch: hold caption, hold ring, detail navigation (PE-11, PE-12, PE-20a)', () => {
  it('shows the caption on touch screens to members who may feed until it is done, remembered per browser', () => {
    assert.equal(showHoldCaption({ coarse: true, canFeed: true, done: false, hasPets: true }), true);
    assert.equal(showHoldCaption({ coarse: false, canFeed: true, done: false, hasPets: true }), false);
    assert.equal(showHoldCaption({ coarse: true, canFeed: false, done: false, hasPets: true }), false);
    assert.equal(showHoldCaption({ coarse: true, canFeed: true, done: true, hasPets: true }), false);
    assert.equal(HOLD_CAPTION_KEY, 'homehub.pets.holdCaptionDone');
    const store = read('src/components/pets/use-pets-layout.ts');
    assert.match(store, /localStorage\.setItem\(HOLD_CAPTION_KEY, '1'\)/);
    assert.match(store, /catch \{/);
    assert.match(read('src/components/pets/hold-to-feed.tsx'), /markHoldCaptionDone\(\);/, 'the first successful hold marks it done');
    assert.match(read('src/components/pets-client.tsx'), />Hold the photo to feed</);
  });

  it('fills the reduced-motion ring in three discrete steps', () => {
    assert.deepEqual([0, 0.2, 0.34, 0.5, 0.67, 0.99, 1].map((value) => steppedHoldProgress(value)), [0, 0, 1 / 3, 1 / 3, 2 / 3, 2 / 3, 1]);
    assert.match(read('src/components/pets/hold-to-feed.tsx'), /reduced \? steppedHoldProgress\(progress\) : progress/);
  });

  it('keeps holds from being cancelled by selection or zoom, and never makes the whole card a link (PE-11, PE-12b)', () => {
    const card = read('src/components/pets/living-pet-card.tsx');
    assert.doesNotMatch(card, /after:absolute after:inset-0/, 'no stretched link over the card');
    assert.match(card, /select-none \[-webkit-touch-callout:none\] \[touch-action:manipulation\]/);
    for (const layout of ['board', 'rows', 'grid']) assert.match(card, new RegExp(`select-none \\[touch-action:manipulation\\]['"]?[^\\n]*\\n?[^\\n]*data-layout="${layout}"|data-layout="${layout}"`));
    // On touch the photo is not a link (a hold only); with a mouse it is; details have explicit controls.
    assert.match(card, /\{fine \? \(/);
    assert.match(card, /aria-label=\{`Details for \$\{pet\.name\}`\}/);
    assert.match(card, /data-testid=\{`pet-name-\$\{pet\.id\}`\}/);
  });

  it('shows the keyboard hint only with a fine pointer (PE-12d)', () => {
    const button = read('src/components/pets/quick-feed-button.tsx');
    assert.match(button, /\{fine \? <ShortcutHint shortcut="log-feeding"/);
  });
});

describe('the household care store (PE-21a)', () => {
  it('subscribes a pet once for every reader and lingers after the last one', async () => {
    const { CareStore } = await import('../../src/components/pets/care-store-core');
    const timers: Array<() => void> = [];
    const store = new CareStore(30_000, { set: ((fn: () => void) => { timers.push(fn); return timers.length as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout, clear: (() => undefined) as typeof clearTimeout });
    let wantedChanges = 0;
    store.subscribeWanted(() => { wantedChanges += 1; });
    const releaseCard = store.acquire('h/rex');
    const releasePage = store.acquire('h/rex');
    assert.deepEqual(store.wanted(), ['h/rex']);
    assert.equal(wantedChanges, 1, 'two readers, one subscription');
    releaseCard();
    releasePage();
    assert.deepEqual(store.wanted(), ['h/rex'], 'lingers after the last reader');
    const again = store.acquire('h/rex');
    timers.forEach((run) => run());
    assert.deepEqual(store.wanted(), ['h/rex'], 'a reader that came back keeps it');
    again();
    timers.forEach((run) => run());
    assert.deepEqual(store.wanted(), [], 'gone after the linger');
  });

  it('runs the real release path with browser-strict timers: mount, unmount, re-mount (the strict-mode double invoke) never throw', async () => {
    // Browsers throw "Illegal invocation" when setTimeout/clearTimeout run with another receiver
    // (for example stored on an object and called as `timers.set(...)`). These stand-ins do the same.
    const { CareStore } = await import('../../src/components/pets/care-store-core');
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const pending = new Map<number, () => void>();
    let next = 1;
    function strictSet(this: unknown, callback: () => void) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      const id = next++;
      pending.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    }
    function strictClear(this: unknown, id: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      pending.delete(id as number);
    }
    globalThis.setTimeout = strictSet as unknown as typeof setTimeout;
    globalThis.clearTimeout = strictClear as unknown as typeof clearTimeout;
    try {
      const store = new CareStore<string>();
      const unsubscribe = store.subscribe(() => undefined);
      // React dev: effect runs, its cleanup runs, it runs again (useSharedPetCare's acquire/release).
      const first = store.acquire('h/rex');
      assert.doesNotThrow(first);
      const second = store.acquire('h/rex');
      store.publish('h/rex', 'data');
      assert.equal(store.read('h/rex'), 'data');
      assert.doesNotThrow(second);
      assert.equal(pending.size, 1, 'one linger timer, the first one cleared on re-mount');
      for (const callback of [...pending.values()]) callback();
      assert.deepEqual(store.wanted(), []);
      assert.equal(store.read('h/rex'), undefined);
      unsubscribe();
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
    // The defaults call the globals through wrappers, never detached or with another receiver.
    const core = read('src/components/pets/care-store-core.ts');
    assert.match(core, /set: \(callback, ms\) => globalThis\.setTimeout\(callback, ms\)/);
    assert.doesNotMatch(core, /\{ set: setTimeout, clear: clearTimeout \}/);
  });

  it('serves every Pets reader from the store: cards, the summary, the pinned line, the Notes and Medication tabs', () => {
    assert.match(read('src/app/pets/layout.tsx'), /<PetsCareProvider>\{children\}<\/PetsCareProvider>/);
    assert.match(read('src/components/pets/pet-care-summary.tsx'), /useSharedPetCare\(householdId, pet\.id\)/);
    assert.match(read('src/components/pets/pinned-note-line.tsx'), /useSharedPetCare\(householdId, petId\)\.pinned/);
    assert.match(read('src/components/pets/notes-tab.tsx'), /useSharedPetCare\(householdId, petId\)\.pinned/);
    assert.match(read('src/components/medication-log.tsx'), /useSharedPetCare\(householdId, petId\)\.medications/);
    assert.doesNotMatch(read('src/components/pets/pet-care-summary.tsx'), /usePetLogs|useMedicationState/);
  });
});

describe('chips, phone header, pet page order, form targets (PE-16, PE-13b/c, PE-14e)', () => {
  it('truncates only the name, shows the due date on touch and makes "+N" a button', () => {
    const chip = read('src/components/pets/medication-chip.tsx');
    assert.match(chip, /min-w-0 truncate font-semibold" data-testid="chip-name"/);
    assert.match(chip, /shrink-0 whitespace-nowrap" data-testid="chip-status"/);
    assert.match(chip, /hidden shrink-0 whitespace-nowrap coarse:inline" data-testid="chip-date"/);
    assert.match(chip, /<button[\s\S]*data-testid="medication-chips-more"[\s\S]*setExpanded\(true\)/);
  });

  it('keeps Add Pet in the header row on phones and puts the tabs first on the pet page', () => {
    assert.match(read('src/components/pets/pets-page-header.tsx'), /flex flex-row items-start justify-between/);
    assert.doesNotMatch(read('src/components/pets-client.tsx'), /className="w-full sm:w-auto"/);
    const page = read('src/app/pets/[petId]/page.tsx');
    assert.match(page, /order-first scroll-mt-20 md:order-none md:col-span-2/);
    assert.match(page, /data-testid="pet-phone-header"/);
  });

  it('gives the feeding form options 48 px (44 px) label targets', () => {
    const form = read('src/components/feeding-log.tsx');
    assert.equal((form.match(/flex min-h-\[var\(--target-min\)\] cursor-pointer items-center/g) ?? []).length, 4);
    assert.equal((form.match(/className="hit-slop-off"/g) ?? []).length, 3);
  });
});
