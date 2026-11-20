import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROMPT_TAP_GUARD_MS, promptTapAllowed } from '../../src/lib/devices/tap-guard';
import { TABLET_INFO_TOAST_MS, tabletToasts, toastExpiries } from '../../src/lib/devices/tablet-toasts';
import { toDate } from '../../src/lib/pets/care';

// The prompts' tap guard (a double tap never picks a face or answers a prompt), and the
// Codex #190 follow-ups: tablet toast expiry independent of the display limit, feeding times
// in the tablet's History, a queued dose keeping what Give dose showed.

const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

describe('the prompts\' tap guard', () => {
  it('a pointer press counts only when it began at least the guard after the prompt opened', () => {
    assert.equal(PROMPT_TAP_GUARD_MS, 400);
    const openedAt = 1_000;
    assert.equal(promptTapAllowed({ openedAt, pressStartedAt: null, keyboard: false }), false, 'a press that began before the prompt opened (none seen since)');
    assert.equal(promptTapAllowed({ openedAt, pressStartedAt: 1_050, keyboard: false }), false, 'the second tap of a double tap');
    assert.equal(promptTapAllowed({ openedAt, pressStartedAt: 1_399, keyboard: false }), false);
    assert.equal(promptTapAllowed({ openedAt, pressStartedAt: 1_400, keyboard: false }), true, 'a deliberate tap');
    assert.equal(promptTapAllowed({ openedAt: null, pressStartedAt: 5_000, keyboard: false }), false, 'not yet open');
  });

  it('the keyboard is never held', () => {
    assert.equal(promptTapAllowed({ openedAt: 1_000, pressStartedAt: null, keyboard: true }), true);
    assert.equal(promptTapAllowed({ openedAt: 1_000, pressStartedAt: 1_001, keyboard: true }), true);
  });

  it('the hook records presses from the moment the prompt opens and treats a click with detail 0 as the keyboard', () => {
    const hook = read('src/components/devices/use-prompt-tap-guard.ts');
    assert.match(hook, /useLayoutEffect\(\(\) => \{\s*openedAt\.current = performance\.now\(\);\s*pressStartedAt\.current = null;/);
    assert.match(hook, /document\.addEventListener\('pointerdown', down, true\)/);
    assert.match(hook, /keyboard: event\.detail === 0/);
    assert.match(hook, /if \(!ok\) event\.preventDefault\(\);/);
  });

  it('every choice of "Who\'s here?", the PIN pad and "Feed again?"/"Already given?" goes through it', () => {
    const who = read('src/components/devices/who-is-here.tsx');
    assert.match(who, /onClick=\{\(event\) => \{ if \(tap\.allow\(event\)\) pick\(person\); \}\}/);
    assert.match(who, /onClick=\{\(event\) => \{ if \(tap\.allow\(event\)\) onPick\(null\); \}\}>Cancel/);
    assert.match(who, /data-tap-ready=/);
    const pad = read('src/components/devices/pin-pad.tsx');
    assert.equal((pad.match(/tap\.allow\(event\)/g) ?? []).length, 5, 'the digits, 0, delete, OK and Cancel');
    assert.doesNotMatch(pad, /onClick=\{\(\) => press|onClick=\{back\}|onClick=\{onCancel\}/);
    assert.match(pad, /window\.addEventListener\('keydown', onKey\)/, 'typing on a keyboard is unchanged');
    const again = read('src/components/devices/feed-again-prompt.tsx');
    assert.match(again, /onClick=\{\(event\) => \{ tap\.allow\(event\); \}\} data-testid="tablet-feed-again-cancel"/);
    assert.match(again, /onClick=\{\(event\) => \{ if \(tap\.allow\(event\)\) answer\(true\); \}\}/);
  });
});

describe('Codex #190: tablet toasts expire on time whether shown or not', () => {
  const undo = (id: string) => ({ id, open: true, action: {}, duration: 10_000 });
  it('every open toast gets an absolute expiry, including one the two-toast limit hides', () => {
    const toasts = [undo('c'), undo('b'), undo('a')];
    assert.deepEqual(tabletToasts(toasts).map((t) => t.id), ['c', 'b'], 'a is hidden');
    const first = toastExpiries(new Map(), toasts, 0);
    assert.deepEqual([...first.keys()].sort(), ['a', 'b', 'c']);
    assert.equal(first.get('a')!.expiresAt, 10_000);
  });

  it('an expiry is kept across updates (a hidden toast never comes back with a full duration); a new duration restarts it', () => {
    const at0 = toastExpiries(new Map(), [undo('a')], 0);
    const later = toastExpiries(at0, [{ ...undo('b'), duration: 10_000 }, undo('a')], 6_000);
    assert.equal(later.get('a')!.expiresAt, 10_000, 'still 10 s after it appeared');
    assert.equal(later.get('b')!.expiresAt, 16_000);
    const reoffered = toastExpiries(later, [{ ...undo('a'), duration: 3_000 }], 7_000);
    assert.equal(reoffered.get('a')!.expiresAt, 10_000);
    assert.equal(toastExpiries(at0, [{ id: 'n', open: true }], 2_000).get('n')!.expiresAt, 2_000 + TABLET_INFO_TOAST_MS);
  });

  it('closed toasts are dropped', () => {
    assert.equal(toastExpiries(new Map(), [{ ...undo('a'), open: false }], 0).size, 0);
  });

  it('the tablet toaster dismisses from those expiries, never from a timer inside a shown toast', () => {
    const toaster = read('src/components/ui/toaster.tsx');
    assert.match(toaster, /expiries\.current = toastExpiries\(expiries\.current, toasts, now\)/);
    assert.match(toaster, /window\.setTimeout\(\(\) => dismiss\(id\), Math\.max\(0, expiresAt - now\)\)/);
    assert.doesNotMatch(toaster, /TabletToastTimer/);
  });
});

describe('Codex #190: the tablet\'s History reads feeding times', () => {
  it('the shared reader takes the Dates usePetLogs gives feedings, as well as strings and timestamps', () => {
    const at = new Date('2026-11-19T12:30:00Z');
    assert.equal(toDate(at), at);
    assert.equal(toDate(new Date(Number.NaN)), null);
    assert.equal(toDate({ toDate: () => at })?.getTime(), at.getTime());
    assert.equal(toDate('2026-11-19T12:30:00Z')?.getTime(), at.getTime());
    const sheet = read('src/components/devices/tablet-pet-sheet.tsx');
    assert.match(sheet, /import \{ householdDateLabel, toDate \} from '@\/lib\/pets\/care';/);
    assert.doesNotMatch(sheet, /const toDate =/);
  });
});

describe('Codex #190: a queued dose keeps what Give dose showed', () => {
  it('the tablet intent carries the shown medication and dosage; the server records them for a queued dose', () => {
    assert.match(read('src/components/pets/give-dose-dialog.tsx'), /notes: notes\.trim\(\), medication: course\.name, dosage: course\.dosage \}/);
    const server = read('src/lib/server/pet-records.ts');
    assert.match(server, /medication: shownMedication \?\? course\.name,\s*dosage: shownDosage \?\? course\.dosage,/);
    assert.match(server, /value\.length > 200/);
    assert.match(read('src/lib/server/device-pets.ts'), /medication: input\.medication, dosage: input\.dosage,/);
  });
});
