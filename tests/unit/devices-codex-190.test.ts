import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { addToast, type QueuedToast } from '../../src/lib/shell/toast-queue';
import { tabletToasts } from '../../src/lib/devices/tablet-toasts';
import { createBackStack } from '../../src/lib/shell/back-stack';
import { formOpAfter } from '../../src/lib/devices/device-action-answers';
import { legacyCourseFormValues, medicationDues, readCourse, withOfflineDoses } from '../../src/lib/pets/medication-course';

// Codex review of #190 (nine P2 findings): the tablet sheet reads Pets through the personal
// readers (offline doses, legacy countdowns, pinned notes, both date shapes, the shared clock),
// dose refusals are shown, the tablet's toast limit keeps an Undo, Back survives a dialog that
// refuses to close, and every tablet form holds one pending action with one opId.

const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const sheet = () => read('src/components/devices/tablet-pet-sheet.tsx');

describe('the tablet reads Pets through the personal readers (Codex 1, 3, 7, 8, 9)', () => {
  it('the Pets access key is the tablet itself while the shell is present, so the personal readers subscribe there', () => {
    const access = read('src/components/pets/pet-access.ts');
    assert.match(access, /const tablet = useContext\(TabletContext\);/);
    assert.match(access, /uid: \`device_\$\{tablet\.deviceId\}:\$\{tablet\.generation\}\`, canView: tablet\.settings\.sections\.pets/);
    // A refused Pets listener keeps recovering on a tablet, as its own listeners do.
    assert.match(read('src/lib/pets/live-listener.ts'), /recoverUnauthorizedAfterMs: deviceRecoveryMs/);
    assert.match(read('src/components/devices/tablet-shell.tsx'), /setPetListenerRecovery\(TABLET_DENIED_RECOVERY_MS\)/);
  });

  it('1, 7, 8: medication comes from useMedicationState (offline doses, legacy countdowns) on the shared useNow clock, in the sheet and the board chips', () => {
    const text = sheet();
    assert.equal((text.match(/useMedicationState\(householdId, petId, now, /g) ?? []).length, 2);
    assert.equal((text.match(/const now = useNow\(\);/g) ?? []).length, 2);
    assert.doesNotMatch(text, /medicationDues\(/, 'no tablet-only derivation');
    assert.match(text, /medication\.legacy\.map\(/);
    assert.match(text, /capability: 'pets\.medication\.confirmLegacy'/);
  });

  it('1: an offline-synced dose covers its occurrence in the shared derivation (what the tablet now shows)', () => {
    const course = readCourse('c1', { name: 'Apoquel', dosage: '1', schedule: { kind: 'hours', everyHours: 12, firstTime: '08:00' }, startDay: '2026-11-10', endDay: null, status: 'active', lastDose: null, prevDose: null, coveredUntil: null })!;
    const now = new Date('2026-11-14T22:00:00Z');
    const offline = { id: 'd1', courseId: 'c1', repeat: 'offline', occurrence: '2026-11-14T08:00', occurrenceAt: new Date('2026-11-14T14:00:00Z'), date: new Date('2026-11-14T14:05:00Z'), loggedByUid: 'u', loggedByName: 'Sam' };
    const before = medicationDues([course], [], now, 'America/Chicago')[0];
    const after = medicationDues([withOfflineDoses(course, [offline])], [], now, 'America/Chicago')[0];
    assert.notEqual(after.occurrenceKey, before.occurrenceKey, 'the recorded occurrence is no longer the one due');
  });

  it('7: a legacy medication is confirmed with the shared prefill (a suggestion only when its history agrees)', () => {
    const agreed = legacyCourseFormValues({ name: 'Heartgard', dosage: '1 chew', dueDay: '2026-12-01', suggestion: { kind: 'days', everyDays: 30, times: [] } }, '2026-11-14');
    assert.equal(agreed.everyDays, '30');
    assert.equal(agreed.startDay, '2026-12-01');
    const mixed = legacyCourseFormValues({ name: 'Heartgard', dosage: '1 chew', dueDay: '2026-12-01', suggestion: null }, '2026-11-14');
    assert.equal(mixed.everyDays, '');
    assert.deepEqual(mixed.times, []);
    assert.match(read('src/components/pets/course-form-dialog.tsx'), /setValues\(legacyCourseFormValues\(mode\.group, today\)\)/);
  });

  it('3: pinned notes are rendered from the pinned-note query; 9: history comes from usePetLogs across both date shapes', () => {
    const text = sheet();
    assert.match(text, /const pinned = usePinnedNotes\(householdId, petId\);/);
    assert.match(text, /pinned\.items\.map\(row\)/);
    assert.match(text, /usePetLogs\(householdId, petId, kind, 12\)/);
    assert.doesNotMatch(text, /orderBy\(/, 'no single date-ordered query of its own');
  });
});

describe('2: a dose refusal is shown even when runAction reports not ok', () => {
  it('Give dose reads the refusal from the answer, whatever ok says', () => {
    const dialog = read('src/components/pets/give-dose-dialog.tsx');
    assert.match(dialog, /if \(result\?\.status === 'refused'\) \{\s*setError\(/);
    assert.doesNotMatch(dialog, /outcome\.ok && result\?\.status === 'refused'/);
  });
});

describe('4: the tablet toast limit keeps a pending Undo', () => {
  it('an open Undo and two notices after it: the Undo stays on screen', () => {
    let store: (QueuedToast & { id: string })[] = [];
    store = addToast(store, { id: 'undo', open: true, holdsAction: true });
    store = addToast(store, { id: 'info-1', open: true });
    store = addToast(store, { id: 'info-2', open: true });
    const shown = tabletToasts(store).map((toast) => toast.id);
    assert.equal(shown.length, 2);
    assert.ok(shown.includes('undo'), JSON.stringify(shown));
    assert.ok(shown.includes('info-2'));
  });
});

describe('5: Back survives a dialog that refuses to close', () => {
  it('a refused close pushes its entry back and keeps it registered; the next Back closes it', () => {
    const history: number[] = [0];
    const stack = createBackStack({
      push: (depth) => { history.push(depth); },
      go: (steps) => { history.splice(history.length + steps); },
      currentDepth: () => { const top = history[history.length - 1]; return top === 0 ? null : top; },
    });
    const closed: string[] = [];
    stack.open(() => { closed.push('sheet'); });
    let saving = true;
    stack.open(() => { if (saving) return false; closed.push('give dose'); return true; });
    history.pop(); stack.pop(); // Back while saving
    assert.deepEqual(closed, []);
    assert.equal(stack.size(), 2);
    assert.deepEqual(history, [0, 1, 2], 'its entry is back');
    saving = false;
    history.pop(); stack.pop();
    assert.deepEqual(closed, ['give dose'], 'the dialog itself closes, not the sheet under it');
  });

  it('the dialogs that refuse while saving tell the hook so', () => {
    for (const path of ['src/components/pets/give-dose-dialog.tsx', 'src/components/pets/course-form-dialog.tsx', 'src/components/pets/correct-feed-time-dialog.tsx', 'src/components/pets/notes-tab.tsx', 'src/components/edit-pet-dialog.tsx', 'src/components/add-pet-dialog.tsx', 'src/components/medication-log.tsx', 'src/components/devices/pin-pad.tsx', 'src/components/devices/tablet-settings.tsx']) {
      assert.match(read(path), /useBackCloses\([^\n]*return false;/, path);
    }
  });
});

describe('6: one pending action per tablet form, one opId per open form', () => {
  it('a form keeps its opId until an attempt was applied or saved on the tablet', () => {
    assert.equal(formOpAfter({ ok: true }), 'renew');
    assert.equal(formOpAfter({ ok: true, queued: true }), 'renew');
    assert.equal(formOpAfter({ ok: false, uncertain: true }), 'keep');
    assert.equal(formOpAfter({ ok: false }), 'keep');
  });

  it('the submit guard is a ref (a double tap before a re-render is held), and the runtime uses the form\'s opId', () => {
    const hook = read('src/components/devices/use-tablet-submit.ts');
    assert.match(hook, /if \(pending\.current\) return null;\s*pending\.current = true;/);
    assert.match(read('src/components/devices/use-device-actions.tsx'), /const opId = formOpId && UUID_OP\.test\(formOpId\) \? formOpId\.toLowerCase\(\) : crypto\.randomUUID\(\);/);
    assert.match(read('src/components/devices/tablet-shell.tsx'), /toastGroup: request\.toastGroup, opId: request\.opId,/);
  });

  it('every tablet form submits through it with its opId and disables its submit while pending', () => {
    const text = sheet();
    for (const capability of ['pets.weight.add', 'pets.note.add', 'pets.note.editPinned', 'pets.log.correctTime', 'pets.profile.edit', 'pets.slots.edit', 'pets.pet.delete', 'pets.course.edit', 'pets.medication.confirmLegacy']) {
      assert.match(text, new RegExp(`runAction\\(\\{ capability: '${capability.replace(/\./g, '\\.')}', opId,`), capability);
    }
    assert.match(text, /disabled=\{!value\.trim\(\) \|\| form\.busy\} data-testid="tablet-weight-save"/);
    assert.match(read('src/components/devices/tablet-views.tsx'), /runAction\(\{ capability: 'pets\.care\.add', opId,/);
    assert.match(read('src/components/pets/give-dose-dialog.tsx'), /opId,\s*capability: chosen \? backdatedCapability/);
  });
});
