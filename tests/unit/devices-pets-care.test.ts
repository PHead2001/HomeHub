import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  choreAnswerMeaning,
  confirmCheckOf,
  doseAgainCheck,
  PET_PIN_CAPABILITIES,
  queuedSendResult,
  SENDABLE_CAPABILITIES,
  UNDO_CAPABILITY_OF,
} from '../../src/lib/devices/device-action-answers';
import { DEVICE_ACTION_POLICY, DOSE_CAPABILITIES, UNDO_PROVEN, backdatedCapability, doseCapability, policyOf, requiredLevel } from '../../src/lib/devices/action-policy';

const queuedCapable = (capability: keyof typeof DEVICE_ACTION_POLICY) => (DEVICE_ACTION_POLICY[capability] as { queueable?: true }).queueable === true;
import { queueAllowed } from '../../src/lib/devices/offline-queue';
import { personMay, rosterFrom } from '../../src/lib/devices/roster';
import { MEDICATION_ACTION_PERMISSIONS } from '../../src/lib/pets/medication-permissions';
import { PET_ACTION_PERMISSIONS } from '../../src/lib/pets/pet-actions';
import { doseConfirmOf, doseRepeatReason } from '../../src/lib/pets/medication-course';

// The rest of Pets on a registered wall tablet (F4b-2; docs/modules/devices/README.md,
// "Device actions: pets (F4b-2)"): what the tablet sends, the levels (face for doses, notes
// and weights once their Undo is proven; PIN for JC-14's list and doses older than 12 hours),
// R5 (the policy names the Pets module's own action tables, as the rules do), how the tablet
// reads the answers ("Already given?" bound to the dose it named, refusals, PIN answers,
// queued replays), and guards that no tablet path writes Pets data with the client SDK.

const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

describe('what the tablet sends for pets (F4b-2)', () => {
  it('doses, notes and weights with their Undo; the PIN-level actions; never pet create or photos', () => {
    for (const capability of ['pets.dose.give', 'pets.dose.give.old', 'pets.dose.undo', 'pets.note.add', 'pets.note.undo', 'pets.weight.add', 'pets.weight.undo', ...PET_PIN_CAPABILITIES] as const) {
      assert.ok(SENDABLE_CAPABILITIES.has(capability), capability);
    }
    assert.equal(SENDABLE_CAPABILITIES.has('pets.pet.create'), false);
    assert.equal(SENDABLE_CAPABILITIES.has('pets.photo.upload'), false);
    assert.equal(UNDO_CAPABILITY_OF['pets.dose.give'], 'pets.dose.undo');
    assert.equal(UNDO_CAPABILITY_OF['pets.dose.give.old'], 'pets.dose.undo');
    assert.equal(UNDO_CAPABILITY_OF['pets.note.add'], 'pets.note.undo');
    assert.equal(UNDO_CAPABILITY_OF['pets.weight.add'], 'pets.weight.undo');
    for (const capability of PET_PIN_CAPABILITIES) assert.equal(UNDO_CAPABILITY_OF[capability], undefined, `${capability} has no face Undo`);
  });

  it('levels: face once proven for every person and points setting (D-P6); PIN for JC-14 and doses older than 12 hours (JC-27)', () => {
    for (const capability of ['pets.dose.give', 'pets.dose.undo', 'pets.note.add', 'pets.note.undo', 'pets.weight.add', 'pets.weight.undo'] as const) {
      assert.ok(UNDO_PROVEN.has(capability), capability);
      for (const pointsPin of ['off', 'kids', 'everyone'] as const) assert.equal(requiredLevel(capability, { pointsPin, actorRole: 'child' }), 'face', capability);
    }
    assert.equal(UNDO_PROVEN.has('pets.dose.give.old'), false);
    assert.equal(requiredLevel('pets.dose.give.old', { pointsPin: 'off', actorRole: 'owner' }), 'pin');
    for (const capability of PET_PIN_CAPABILITIES) {
      assert.equal(requiredLevel(capability, { pointsPin: 'off', actorRole: 'owner' }), 'pin', capability);
      assert.equal(queueAllowed(capability, { pointsPin: 'off', actorRole: 'owner' }), false, `${capability} never waits offline (it needs a PIN)`);
    }
    const now = new Date('2026-11-14T20:00:00Z');
    assert.equal(backdatedCapability('dose', new Date(now.getTime() - 11 * 3_600_000), now), 'pets.dose.give');
    assert.equal(backdatedCapability('dose', new Date(now.getTime() - 13 * 3_600_000), now), 'pets.dose.give.old');
    for (const capability of ['pets.dose.give', 'pets.note.add', 'pets.weight.add'] as const) assert.ok(queuedCapable(capability), capability);
  });
});

describe('R5: the policy names the Pets module\'s own tables', () => {
  it('doses and courses use MEDICATION_ACTION_PERMISSIONS; notes, weights and the profile PET_ACTION_PERMISSIONS', () => {
    assert.deepEqual(DEVICE_ACTION_POLICY['pets.dose.give'].permissions, MEDICATION_ACTION_PERMISSIONS['pets.dose.give']);
    assert.deepEqual(DEVICE_ACTION_POLICY['pets.dose.give.old'].permissions, MEDICATION_ACTION_PERMISSIONS['pets.dose.give']);
    assert.deepEqual(DEVICE_ACTION_POLICY['pets.dose.undo'].permissions, MEDICATION_ACTION_PERMISSIONS['pets.dose.undo']);
    assert.deepEqual(DEVICE_ACTION_POLICY['pets.course.finish'].permissions, MEDICATION_ACTION_PERMISSIONS['pets.course.finish']);
    assert.deepEqual(DEVICE_ACTION_POLICY['pets.course.resume'].permissions, MEDICATION_ACTION_PERMISSIONS['pets.course.finish']);
    assert.deepEqual(DEVICE_ACTION_POLICY['pets.course.edit'].permissions, MEDICATION_ACTION_PERMISSIONS['pets.course.edit']);
    assert.deepEqual(DEVICE_ACTION_POLICY['pets.medication.confirmLegacy'].permissions, MEDICATION_ACTION_PERMISSIONS['pets.medication.confirmLegacy']);
    assert.deepEqual(DEVICE_ACTION_POLICY['pets.note.add'].permissions, PET_ACTION_PERMISSIONS['pets.note.add']);
    assert.deepEqual(DEVICE_ACTION_POLICY['pets.weight.add'].permissions, PET_ACTION_PERMISSIONS['pets.weight.add']);
    assert.deepEqual(DEVICE_ACTION_POLICY['pets.profile.edit'].permissions, PET_ACTION_PERMISSIONS['pets.profile.edit']);
    assert.deepEqual(DEVICE_ACTION_POLICY['pets.slots.edit'].permissions, PET_ACTION_PERMISSIONS['pets.profile.edit']);
    assert.deepEqual(DEVICE_ACTION_POLICY['pets.pet.delete'].permissions, PET_ACTION_PERMISSIONS['pets.profile.delete']);
    // Note edits: the author (pets.addLogs) or pets.editProfiles; deletes also pets.deleteLogs.
    assert.deepEqual([...policyOf('pets.note.editPinned').permissions!].sort(), ['pets.addLogs', 'pets.editProfiles']);
    assert.deepEqual([...policyOf('pets.note.delete').permissions!].sort(), ['pets.addLogs', 'pets.deleteLogs', 'pets.editProfiles']);
  });

  it('the rules gate the same records with the same names', () => {
    const rules = read('firestore.rules');
    const block = (start: string) => {
      const at = rules.indexOf(start);
      return rules.slice(at, rules.indexOf('\n        }', at));
    };
    assert.match(block('match /notes/{noteId}'), /hasHouseholdPermission\(householdId, 'pets\.addLogs'\) && petNoteCreate/);
    assert.match(block('match /weights/{weightId}'), /hasHouseholdPermission\(householdId, 'pets\.addLogs'\) && petWeightCreate/);
    assert.match(block('match /medication-logs/{logId}'), /'pets\.deleteLogs'/);
    const courseEdited = rules.slice(rules.indexOf('function courseEdited('), rules.indexOf('function courseEdited(') + 400);
    assert.ok(courseEdited.includes(`'${MEDICATION_ACTION_PERMISSIONS['pets.course.edit'][0]}'`));
  });

  it("a child's face gets what the role allows: doses, notes and weights, never profile edits or deletes", () => {
    const [kid] = rosterFrom([{ id: 'kid_a', data: { role: 'child', kind: 'identity', status: 'active', displayName: 'Mia' } }]);
    for (const capability of ['pets.dose.give', 'pets.note.add', 'pets.weight.add'] as const) assert.equal(personMay(kid, policyOf(capability).permissions), true, capability);
    for (const capability of ['pets.profile.edit', 'pets.slots.edit', 'pets.pet.delete'] as const) assert.equal(personMay(kid, policyOf(capability).permissions), false, capability);
  });
});

describe('reading the answers', () => {
  const asked = { result: { status: 'needsConfirm', staleConfirm: true, check: { reason: 'given', occurrence: { key: '2026-11-14T08:00', day: '2026-11-14', time: '08:00', at: 1 }, last: { logId: 'd1', occurrence: '2026-11-14T08:00', occurrenceAt: 1, givenAt: Date.parse('2026-11-14T14:05:00Z'), byUid: 'u', byName: 'sam@example.test' } } } };
  it('"Already given?" is read from a dose answer, bound to the dose it named, never with an email', () => {
    const check = doseAgainCheck('pets.dose.give', asked);
    assert.ok(check);
    assert.equal(check!.kind, 'dose');
    assert.equal(check!.staleConfirm, true);
    assert.equal(check!.check.last?.logId, 'd1');
    assert.equal(check!.check.last?.byName, null);
    // The answer is bound to the dose it named and the occurrence it was asked for (P3 round 7).
    assert.deepEqual(doseConfirmOf(check!.check as never), { lastLogId: 'd1', occurrence: '2026-11-14T08:00' });
    const folded = doseAgainCheck('pets.dose.give', { result: { ...asked.result, check: { ...asked.result.check, occurrence: { ...asked.result.check.occurrence, fold: 1 } } } });
    assert.equal(doseConfirmOf(folded!.check as never).occurrence, '2026-11-14T08:00~1', 'the later of two same-clock occurrences keeps its identity');
    assert.equal(doseRepeatReason(check!.check as never, new Date('2026-11-14T14:10:00Z'), 'America/Chicago').includes('@'), false);
    assert.equal(doseAgainCheck('pets.note.add', asked), null);
    const any = confirmCheckOf('pets.dose.give.old', asked);
    assert.ok(any && 'kind' in any && any.kind === 'dose');
    assert.equal(confirmCheckOf('pets.dose.give', { result: { status: 'saved' } }), null);
  });

  it('a saved dose, note or weighing offers Undo; a refused or cancelled one says nothing more; PIN answers are plain', () => {
    assert.deepEqual(choreAnswerMeaning('pets.dose.give', { result: { status: 'saved', logId: 'd' } }, 'Apoquel for Maple'), { undoable: true, message: 'Apoquel for Maple: recorded.' });
    assert.equal(choreAnswerMeaning('pets.dose.give', { result: { status: 'refused', reason: 'finished' } }, 'x').undoable, false);
    assert.equal(choreAnswerMeaning('pets.dose.give', { cancelled: true }, 'x').message, '');
    assert.equal(choreAnswerMeaning('pets.note.add', { status: 'added' }, 'Note for Maple').undoable, true);
    assert.equal(choreAnswerMeaning('pets.weight.add', { status: 'refused', reason: 'invalid' }, 'x').undoable, false);
    assert.deepEqual(choreAnswerMeaning('pets.note.pin', { status: 'saved' }, 'Note pinned'), { undoable: false, message: 'Note pinned.' });
    assert.equal(choreAnswerMeaning('pets.profile.edit', { status: 'refused', reason: 'duplicate-name' }, 'x').message, 'Another pet already has that name.');
    assert.equal(choreAnswerMeaning('pets.log.delete', { status: 'already' }, 'x').notice, true);
  });

  it('queued replays: a saved dose or added record is applied; a refused dose is dropped saying why; Undo answers leave nothing to do', () => {
    assert.deepEqual(queuedSendResult('pets.dose.give', { ok: true, data: { result: { status: 'saved' } } }), { ok: true });
    const dropped = queuedSendResult('pets.dose.give', { ok: true, data: { result: { status: 'refused', reason: 'finished' } } });
    assert.equal(dropped.ok, false);
    assert.match(String((dropped as { reason?: string }).reason), /finished/);
    assert.deepEqual(queuedSendResult('pets.note.add', { ok: true, data: { status: 'added' } }), { ok: true });
    assert.deepEqual(queuedSendResult('pets.weight.add', { ok: true, data: { status: 'added' } }), { ok: true });
    for (const capability of ['pets.dose.undo', 'pets.note.undo', 'pets.weight.undo'] as const) {
      for (const status of ['undone', 'already', 'not_applied']) assert.deepEqual(queuedSendResult(capability, { ok: true, data: { status } }), { ok: true });
    }
  });
});

describe('guards: no tablet path writes Pets data with the client SDK', () => {
  const CLIENT_WRITES = /\b(setDoc|addDoc|updateDoc|deleteDoc|writeBatch|runTransaction)\b|records-api|medication-operation|pet-profile-api|pet-log-api|feed-operation/;
  it('the tablet\'s Pets views and sheet import no client write and no personal write module', () => {
    for (const path of ['src/components/devices/tablet-pet-sheet.tsx', 'src/components/devices/tablet-views.tsx', 'src/components/devices/use-device-actions.tsx', 'src/components/devices/tablet-shell.tsx']) {
      assert.doesNotMatch(read(path), CLIENT_WRITES, path);
    }
  });

  it('every write in the sheet is a runAction with a sendable capability', () => {
    const sheet = read('src/components/devices/tablet-pet-sheet.tsx');
    const capabilities = [...sheet.matchAll(/capability: (?:[^'\n]*?)'(pets\.[a-zA-Z.]+)'/g)].map((match) => match[1]);
    assert.ok(capabilities.length >= 12, capabilities.join(','));
    for (const capability of capabilities) assert.ok(SENDABLE_CAPABILITIES.has(capability as never), capability);
    // Its two subscriptions (a collection, a document) are the one `subscribe` handed to tabletListener.
    assert.equal((sheet.match(/onSnapshot\(/g) ?? []).length, 2);
    assert.match(sheet, /stop = tabletListener<QuerySnapshot \| DocumentSnapshot>\(subscribe, \{/);
  });

  it('Give dose and Finish course go through the shell on a tablet before any client transaction', () => {
    const dialog = read('src/components/pets/give-dose-dialog.tsx');
    const tabletBranch = dialog.indexOf('if (tablet) {\n      savingRef.current = true;');
    assert.ok(tabletBranch > 0);
    assert.ok(tabletBranch < dialog.indexOf('const result = await giveDose('), 'the tablet branch returns before giveDose');
    assert.ok(dialog.indexOf("capability: 'pets.course.finish'") < dialog.indexOf('await finishCourse('), 'Finish uses the device path first');
    assert.match(dialog, /const tablet = React\.useContext\(TabletContext\);/);
  });

  it('a reminder\'s ?dose= link opens Give dose on the tablet', () => {
    const views = read('src/components/devices/tablet-views.tsx');
    assert.match(views, /search\?\.get\('dose'\)/);
    assert.match(views, /<TabletPetSheet petId=\{open\.id\} petName=\{open\.name\} doseCourseId=\{open\.dose\}/);
    assert.match(read('src/components/devices/tablet-pet-sheet.tsx'), /entry\.id === doseCourseId && entry\.status === 'active'/);
  });
});

describe('F4b-2 review: the 12-hour line, retries and the request shape', () => {
  const now = new Date('2026-11-14T20:00:00Z');
  const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  it('S1: a dose is classified by its effective time: the given-at time, else the queue time', () => {
    assert.equal(doseCapability({ givenAt: null, queuedAt: null }, now), 'pets.dose.give');
    assert.equal(doseCapability({ givenAt: null, queuedAt: ago(11) }, now), 'pets.dose.give');
    assert.equal(doseCapability({ givenAt: null, queuedAt: ago(13) }, now), 'pets.dose.give.old');
    assert.equal(doseCapability({ givenAt: ago(1), queuedAt: ago(23) }, now), 'pets.dose.give', 'a chosen time wins over the queue time');
    assert.equal(doseCapability({ givenAt: ago(13), queuedAt: null }, now), 'pets.dose.give.old');
  });

  it('S2: one dose press under either capability (the replay family is the dose Undo\'s list)', () => {
    assert.deepEqual([...DOSE_CAPABILITIES].sort(), ['pets.dose.give', 'pets.dose.give.old']);
    const server = read('src/lib/server/device-pets.ts');
    assert.match(server, /authorize\(capability, input, options, DOSE_CAPABILITIES\)/);
    assert.match(server, /doseCapability\(\{ givenAt: doseGivenAtOf\(input\.givenAt, now\), queuedAt: queuedLineTime\(input\.queued, now\) \}, now\)/);
  });

  it('N4: an intent never overrides the request (token, household, person, PIN session, opId, queue)', async () => {
    const { intentFields } = await import('../../src/lib/devices/device-action-answers');
    const fields = intentFields({ petId: 'p', opId: 'x', actorUid: 'evil', queued: { createdAt: 'x' }, idToken: 't', householdId: 'h', pinSessionId: 's', text: 'Hi' });
    assert.deepEqual(fields, { petId: 'p', text: 'Hi' });
    const runtime = read('src/components/devices/use-device-actions.tsx');
    assert.doesNotMatch(runtime, /\{ \.\.\.base, \.\.\.\(intent/);
  });

  it('one helper writes every online dose from a tablet (a course revision field is added in one place)', () => {
    const records = read('src/lib/server/pet-records.ts');
    assert.equal((records.match(/tx\.set\(logRef/g) ?? []).length, 0);
    assert.ok((records.match(/writeDose\(/g) ?? []).length >= 5);
    // P3 round 6: the helper moves the course's dose revision on with every online dose write.
    assert.match(records, /tx\.update\(write\.course\.ref, \{ doseRevision: nextDoseRevision\(write\.course\.data\)/);
  });
});
