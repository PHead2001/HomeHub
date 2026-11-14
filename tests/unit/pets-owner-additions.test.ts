/**
 * P5 owner additions and quality, pure parts: who may do what (R5 constants and
 * the author rules), notes (PE-29), weights and the trend (PE-28), vet contact
 * (PE-28a), pet ids and renames (PE-30), photo ownership (PE-21f), the photo
 * limits (PE-21e) and the ambient animation (PE-21d).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { householdPermissions } from '../../src/lib/permissions';
import { AUTHOR_DELETE_WINDOW_MS, PET_ACTION_PERMISSIONS, mayDeleteNote, mayDeleteWeight, mayEditNote, mayPet } from '../../src/lib/pets/pet-actions';
import {
  NOTE_TEXT_MAX,
  PINNED_NOTES_MAX,
  behaviourEntries,
  headlineNote,
  newRecordOpId,
  noteCreateFields,
  noteDate,
  pinnedNotes,
  readNote,
  recordDocId,
  validateNoteDraft,
  type PetNote,
} from '../../src/lib/pets/notes';
import {
  KG_PER_LB,
  WEIGHT_MAX,
  convertWeight,
  formatWeight,
  petWeightUnit,
  readWeight,
  roundWeight,
  sparklinePoints,
  validateWeightDraft,
  weightHistory,
  weightTrend,
  type WeightEntry,
} from '../../src/lib/pets/weights';
import {
  DuplicatePetNameError,
  PET_PHOTO_MAX_BYTES,
  duplicatePetName,
  isPetId,
  newPetId,
  otherPetNames,
  ownedPhotoPath,
  storagePathOfUrl,
  telHref,
  validateVet,
  vetFields,
} from '../../src/lib/pets/profile';
import { newPetData } from '../../src/lib/pets/profile-transaction';
import { PET_TABS, petTabFromParam, validatePetForm } from '../../src/lib/pets/care';
import { parseQuickAdd, type QuickAddContext } from '../../src/lib/dashboard/quick-add';
import { computePetFacts } from '../../src/lib/dashboard/facts';
import { DEFAULT_MAX_EDGE, planDownscale } from '../../src/lib/images/downscale';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
const TZ = 'America/Chicago';

const note = (overrides: Partial<PetNote> = {}): PetNote => ({
  id: 'n1', text: 'Allergic to chicken', tag: null, pinned: false, pinnedAt: null,
  date: new Date('2026-11-10T15:00:00Z'), loggedAt: new Date('2026-11-10T15:00:00Z'),
  loggedByUid: 'sam', loggedByName: 'Sam', editedAt: null, editedByName: null, ...overrides,
});

describe('R5: pet action permissions are one shared table', () => {
  it('names only real household permissions, and the rules enforce the same ones', () => {
    for (const [action, permissions] of Object.entries(PET_ACTION_PERMISSIONS)) {
      assert.ok(permissions.length > 0, action);
      for (const permission of permissions) assert.ok(householdPermissions.includes(permission), `${action}: ${permission}`);
    }
    const rules = read('firestore.rules');
    const block = (start: string) => rules.slice(rules.indexOf(start), rules.indexOf('\n        }', rules.indexOf(start)));
    const notes = block('match /notes/{noteId}');
    assert.match(notes, /allow create: if hasHouseholdPermission\(householdId, 'pets\.addLogs'\)/);
    assert.match(notes, /allow delete: if hasHouseholdPermission\(householdId, 'pets\.deleteLogs'\)/);
    const weights = block('match /weights/{weightId}');
    assert.match(weights, /allow create: if hasHouseholdPermission\(householdId, 'pets\.addLogs'\)/);
    assert.match(weights, /allow delete: if hasHouseholdPermission\(householdId, 'pets\.deleteLogs'\)/);
    assert.match(rules, /function petNoteUpdate[\s\S]*?hasHouseholdPermission\(householdId, 'pets\.editProfiles'\)/);
    assert.deepEqual(PET_ACTION_PERMISSIONS['pets.note.add'], ['pets.addLogs']);
    assert.deepEqual(PET_ACTION_PERMISSIONS['pets.note.edit'], ['pets.editProfiles']);
    assert.deepEqual(PET_ACTION_PERMISSIONS['pets.note.delete'], ['pets.deleteLogs']);
    assert.deepEqual(PET_ACTION_PERMISSIONS['pets.weight.add'], ['pets.addLogs']);
    assert.deepEqual(PET_ACTION_PERMISSIONS['pets.profile.delete'], ['pets.editProfiles']);
    // The server action takes its permission from the table, not a literal.
    assert.match(read('src/app/pets/actions.ts'), /PET_ACTION_PERMISSIONS\['pets\.profile\.delete'\]/);
  });

  it('applies the author rules: edit by author or editor; delete within 10 minutes by the author', () => {
    const member = { uid: 'sam', permissions: { 'pets.addLogs': true } };
    const other = { uid: 'kim', permissions: { 'pets.addLogs': true } };
    const editor = { uid: 'kim', permissions: { 'pets.editProfiles': true } };
    const deleter = { uid: 'kim', permissions: { 'pets.deleteLogs': true } };
    const guest = { uid: 'sam', permissions: { 'pets.view': true } };
    const written = note();
    const inWindow = new Date(written.loggedAt!.getTime() + AUTHOR_DELETE_WINDOW_MS - 1);
    const late = new Date(written.loggedAt!.getTime() + AUTHOR_DELETE_WINDOW_MS);
    assert.equal(mayPet('pets.note.add', member.permissions), true);
    assert.equal(mayPet('pets.note.add', guest.permissions), false);
    assert.equal(mayEditNote(written, member), true);
    assert.equal(mayEditNote(written, other), false);
    assert.equal(mayEditNote(written, editor), true);
    assert.equal(mayEditNote(written, guest), false, 'the author without pets.addLogs');
    assert.equal(mayDeleteNote(written, member, inWindow), true);
    assert.equal(mayDeleteNote(written, member, late), false);
    assert.equal(mayDeleteNote(written, other, inWindow), false);
    assert.equal(mayDeleteNote(written, deleter, late), true);
    assert.equal(mayDeleteNote(written, editor, late), false, 'an entry is a log');
    assert.equal(mayDeleteNote({ ...written, pinned: true }, editor, late), true, 'a pinned note is profile data');
    assert.equal(mayDeleteNote({ ...written, loggedAt: null }, member, inWindow), false, 'unknown write time');
    const weight = { loggedByUid: 'sam', loggedAt: written.loggedAt };
    assert.equal(mayDeleteWeight(weight, member, inWindow), true);
    assert.equal(mayDeleteWeight(weight, member, late), false);
    assert.equal(mayDeleteWeight(weight, deleter, late), true);
  });
});

describe('notes (PE-29)', () => {
  it('checks drafts: text required and bounded, no future day, a cap on pinned notes', () => {
    const today = '2026-11-14';
    assert.deepEqual(validateNoteDraft({ text: 'Barked', tag: '', pinned: false, day: '' }, today), {});
    assert.ok(validateNoteDraft({ text: '  ', tag: '', pinned: false, day: '' }, today).text);
    assert.ok(validateNoteDraft({ text: 'x'.repeat(NOTE_TEXT_MAX + 1), tag: '', pinned: true, day: '' }, today).text);
    assert.ok(validateNoteDraft({ text: 'Walk', tag: '', pinned: false, day: '2026-11-15' }, today).day);
    assert.deepEqual(validateNoteDraft({ text: 'Walk', tag: '', pinned: false, day: '2026-11-13' }, today), {});
    assert.ok(validateNoteDraft({ text: 'Chip 123', tag: '', pinned: true, day: '' }, today, PINNED_NOTES_MAX).pinned);
  });

  it('dates an entry on its household day: now for today, noon household time for an earlier day', () => {
    const now = new Date('2026-11-14T05:30:00Z'); // 23:30 on Nov 13 in Chicago
    assert.equal(noteDate({ pinned: false, day: '' }, now, TZ), now);
    assert.equal(noteDate({ pinned: false, day: '2026-11-13' }, now, TZ), now, 'the household day is still the 13th');
    assert.equal(noteDate({ pinned: false, day: '2026-11-12' }, now, TZ).toISOString(), '2026-11-12T18:00:00.000Z');
    assert.equal(noteDate({ pinned: true, day: '2026-11-01' }, now, TZ), now, 'a pinned note is dated when written');
    // Daylight saving: Nov 1 2026 is the fall-back day in Chicago (noon is 17:00Z).
    assert.equal(noteDate({ pinned: false, day: '2026-11-01' }, now, TZ).toISOString(), '2026-11-01T17:00:00.000Z');
  });

  it('writes the signed fields only (no server stamps, no empty tag)', () => {
    const fields = noteCreateFields({ text: ' Calm at the vet ', tag: '', pinned: false, day: '' }, { uid: 'sam', name: 'Sam' }, new Date(0));
    assert.deepEqual(Object.keys(fields).sort(), ['date', 'loggedByName', 'loggedByUid', 'pinned', 'text']);
    assert.equal(fields.text, 'Calm at the vet');
    assert.equal(noteCreateFields({ text: 'x', tag: 'vet', pinned: true, day: '' }, { uid: 'sam', name: 'Sam' }, new Date(0)).tag, 'vet');
  });

  it('lists pinned notes newest pin first (the headline) and entries newest first', () => {
    const a = note({ id: 'a', pinned: true, pinnedAt: new Date('2026-11-01T00:00:00Z') });
    const b = note({ id: 'b', pinned: true, pinnedAt: new Date('2026-11-05T00:00:00Z') });
    const e1 = note({ id: 'e1', date: new Date('2026-11-02T00:00:00Z') });
    const e2 = note({ id: 'e2', date: new Date('2026-11-09T00:00:00Z') });
    assert.deepEqual(pinnedNotes([a, e1, b, e2]).map((n) => n.id), ['b', 'a']);
    assert.equal(headlineNote([a, e1, b])?.id, 'b');
    assert.equal(headlineNote([e1, e2]), null);
    assert.deepEqual(behaviourEntries([a, e1, b, e2]).map((n) => n.id), ['e2', 'e1']);
  });

  it('reads malformed notes harmlessly and takes one id per add', () => {
    const odd = readNote('x', { text: 5, tag: 'nonsense', pinned: 'yes', date: 'not a date' });
    assert.deepEqual([odd.text, odd.tag, odd.pinned, odd.date], ['', null, false, null]);
    const opId = newRecordOpId();
    assert.equal(recordDocId(opId), opId);
    assert.notEqual(newRecordOpId(), opId);
    assert.throws(() => recordDocId('../x'));
    assert.throws(() => recordDocId('short'));
  });
});

describe('weights (PE-28)', () => {
  const entry = (id: string, value: number, unit: 'kg' | 'lb', iso: string): WeightEntry => ({
    id, value, unit, date: new Date(iso), loggedAt: new Date(iso), loggedByUid: 'sam', loggedByName: 'Sam',
  });

  it('converts with one exact factor and rounds for display only', () => {
    assert.equal(KG_PER_LB, 0.45359237);
    assert.ok(Math.abs(convertWeight(10, 'lb', 'kg') - 4.5359237) < 1e-12);
    assert.ok(Math.abs(convertWeight(convertWeight(12.3, 'kg', 'lb'), 'lb', 'kg') - 12.3) < 1e-12);
    assert.equal(roundWeight(4.256), 4.26);
    assert.equal(roundWeight(25.36), 25.4);
    assert.equal(formatWeight(4.5359237, 'kg'), '4.54 kg');
    assert.equal(petWeightUnit({}), 'kg');
    assert.equal(petWeightUnit({ weightUnit: 'lb' }), 'lb');
    assert.equal(petWeightUnit({ weightUnit: 'stone' }), 'kg');
  });

  it('validates drafts per unit and refuses a future day', () => {
    assert.deepEqual(validateWeightDraft({ value: '4.2', unit: 'kg', day: '' }, '2026-11-14'), {});
    assert.ok(validateWeightDraft({ value: '', unit: 'kg', day: '' }, '2026-11-14').value);
    assert.ok(validateWeightDraft({ value: '0', unit: 'kg', day: '' }, '2026-11-14').value);
    assert.ok(validateWeightDraft({ value: String(WEIGHT_MAX.kg + 1), unit: 'kg', day: '' }, '2026-11-14').value);
    assert.deepEqual(validateWeightDraft({ value: String(WEIGHT_MAX.kg + 1), unit: 'lb', day: '' }, '2026-11-14'), {});
    assert.ok(validateWeightDraft({ value: '4', unit: 'kg', day: '2026-11-15' }, '2026-11-14').day);
  });

  it('shows history and trend in the pet unit, entries in the other unit converted', () => {
    const entries = [
      entry('w1', 10, 'lb', '2026-09-01T12:00:00Z'),
      entry('w2', 4.6, 'kg', '2026-10-01T12:00:00Z'),
      entry('w3', 10.6, 'lb', '2026-11-01T12:00:00Z'),
    ];
    const kg = weightTrend(entries, 'kg', { timeZone: TZ })!;
    assert.equal(roundWeight(kg.latest.value), 4.81);
    assert.equal(kg.previous!.date.toISOString(), '2026-09-01T12:00:00.000Z', 'the earliest weighing within 90 days');
    assert.equal(kg.direction, 'up');
    assert.equal(kg.summary, 'Up 0.27 kg since Sep 1');
    const lb = weightTrend(entries, 'lb', { timeZone: TZ })!;
    assert.equal(lb.summary, 'Up 0.6 lb since Sep 1');
    assert.deepEqual(lb.series.map((point) => roundWeight(point.value)), [10, 10.1, 10.6], 'oldest first, in one unit (4.6 kg shown as 10.1 lb)');
    const steady = weightTrend([entry('a', 4, 'kg', '2026-10-01T12:00:00Z'), entry('b', 4.001, 'kg', '2026-11-01T12:00:00Z')], 'kg', { timeZone: TZ })!;
    assert.equal(steady.direction, 'steady');
    assert.match(steady.summary, /^No change since/);
    const first = weightTrend([entry('a', 4, 'kg', '2026-10-01T12:00:00Z')], 'kg')!;
    assert.equal(first.summary, 'First weighing');
    assert.equal(weightTrend([], 'kg'), null);
    // Older than the window: compared against the weighing just before the latest.
    const sparse = weightTrend([entry('a', 5, 'kg', '2025-01-01T12:00:00Z'), entry('b', 4, 'kg', '2026-11-01T12:00:00Z')], 'kg', { timeZone: TZ })!;
    assert.equal(sparse.summary, 'Down 1 kg since Jan 1');
  });

  it('skips malformed entries and draws a decorative sparkline', () => {
    assert.equal(weightHistory([readWeight('bad', { value: 'x', unit: 'kg', date: new Date() }), readWeight('ok', { value: 3, unit: 'kg', date: new Date() })]).length, 1);
    assert.equal(sparklinePoints([], 100, 20), '');
    assert.equal(sparklinePoints([{ value: 1 }], 100, 20), '50,10');
    assert.equal(sparklinePoints([{ value: 1 }, { value: 2 }], 100, 20), '2,18 98,2');
  });
});

describe('pet profile: ids, names, vet and photos (PE-30, PE-28a, PE-21e/f)', () => {
  it('gives new pets a random id that is not the name', () => {
    const id = newPetId();
    assert.match(id, /^pet-[A-Za-z0-9]{20}$/);
    assert.notEqual(newPetId(), id);
    assert.ok(isPetId(id));
    assert.ok(isPetId('rex-1a2b'), 'existing slug ids stay valid');
    for (const bad of ['', 'a/b', '..', '__x__', 'x'.repeat(201), 5]) assert.equal(isPetId(bad), false);
    assert.doesNotMatch(read('src/lib/pets/profile-transaction.ts'), /slugify/);
    assert.doesNotMatch(read('src/components/pets/pet-profile-api.ts'), /slugify|placehold\.co/);
  });

  it('checks duplicate names case-insensitively, excluding the pet itself (a rename)', () => {
    const pets = [{ id: 'rex', name: 'Rex' }, { id: 'pet-2', name: 'Maple' }];
    assert.equal(duplicatePetName(' rex ', pets)?.id, 'rex');
    assert.equal(duplicatePetName('REX', pets, 'rex'), null, 'renaming Rex to REX');
    assert.equal(duplicatePetName('Maple', pets, 'rex')?.id, 'pet-2');
    assert.equal(duplicatePetName('Biscuit', pets, 'rex'), null);
    assert.deepEqual(otherPetNames(pets, 'rex'), ['Maple']);
    assert.match(new DuplicatePetNameError('Maple').message, /already have a pet named Maple/);
    // The form: a rename to another pet's name is refused, the pet's own name (any case) is fine.
    const values = { name: 'maple', foodSchedule: 'twice daily', feedingsPerDay: '', portionAmount: '' };
    assert.ok(validatePetForm(values, otherPetNames(pets, 'rex'), { ...values, name: 'Rex' }).name);
    assert.equal(validatePetForm({ ...values, name: 'REX' }, otherPetNames(pets, 'rex'), { ...values, name: 'Rex' }).name, undefined);
  });

  it('picks up a new name in quick add and the dashboard (they read the name field, keyed by id)', () => {
    const context = (name: string): QuickAddContext => ({
      now: new Date('2026-11-14T15:00:00Z'), viewer: { uid: 'sam', email: 'sam@example.test' }, members: [], lists: [],
      pets: [{ id: 'rex-1a2b', name }],
    });
    const renamed = parseQuickAdd('fed Biscuit', context('Biscuit'));
    assert.equal(renamed?.kind, 'feeding');
    assert.equal(renamed?.kind === 'feeding' ? renamed.pet.id : null, 'rex-1a2b', 'same pet, same id');
    assert.notEqual(parseQuickAdd('fed Rex', context('Biscuit'))?.kind, 'feeding', 'the old name no longer matches');
    const facts = computePetFacts([{ id: 'rex-1a2b', name: 'Biscuit', foodSchedule: 'twice daily' }], { 'rex-1a2b': [] }, new Date('2026-11-14T15:00:00Z'), TZ);
    assert.equal(facts.pets[0].name, 'Biscuit');
    assert.equal(facts.pets[0].id, 'rex-1a2b');
  });

  it('validates the optional vet contact and builds a tel: link', () => {
    assert.deepEqual(validateVet({ vetName: '', vetClinic: '', vetPhone: '' }), {});
    assert.deepEqual(validateVet({ vetName: 'Dr. Rivera', vetClinic: 'Riverside', vetPhone: '+1 (512) 555-0134' }), {});
    assert.ok(validateVet({ vetName: 'x'.repeat(81), vetClinic: '', vetPhone: '' }).vetName);
    assert.ok(validateVet({ vetName: '', vetClinic: '', vetPhone: 'call me' }).vetPhone);
    assert.ok(validateVet({ vetName: '', vetClinic: '', vetPhone: '--' }).vetPhone, 'too few digits');
    const stored = { vetName: 'x'.repeat(90), vetClinic: '', vetPhone: '' };
    assert.deepEqual(validateVet(stored, stored), {}, 'an unchanged stored value never blocks a save');
    assert.deepEqual(vetFields({ vetName: ' Dr. R ', vetClinic: '', vetPhone: '' }), { vetName: 'Dr. R', vetClinic: null, vetPhone: null });
    assert.equal(telHref('+1 (512) 555-0134'), 'tel:+15125550134');
    assert.equal(telHref('512.555.0134'), 'tel:5125550134');
    assert.equal(telHref('12'), null);
    assert.equal(telHref(undefined), null);
  });

  it('writes a new pet without the external placeholder and with only the vet fields set', () => {
    const fields = { name: 'Biscuit', type: 'Dog', dataAiHint: 'dog', foodSchedule: 'twice daily', feedingsPerDay: null, portionAmount: null, portionUnit: null, slots: null, vetName: 'Dr. R', vetClinic: null, vetPhone: null, weightUnit: 'lb' as const };
    const data = newPetData(fields, '', undefined, new Date('2026-11-14T15:00:00Z'));
    assert.equal(data.photoUrl, '');
    assert.equal(data.vetName, 'Dr. R');
    assert.equal('vetClinic' in data, false);
    assert.equal(data.weightUnit, 'lb');
  });

  it('deletes only the pet’s own photo objects (PE-21f)', () => {
    const bucket = 'demo.appspot.com';
    const url = (path: string, host = 'https://firebasestorage.googleapis.com', inBucket = bucket) =>
      `${host}/v0/b/${inBucket}/o/${encodeURIComponent(path)}?alt=media&token=t`;
    const scope = { householdId: 'h1', petId: 'pet-a', bucket };
    assert.equal(storagePathOfUrl(url('households/h1/pets/pet-a/p.jpg')), 'households/h1/pets/pet-a/p.jpg');
    assert.equal(storagePathOfUrl(url('households/h1/pets/x.jpg', 'http://127.0.0.1:9199')), 'households/h1/pets/x.jpg', 'emulator URL');
    assert.equal(ownedPhotoPath(url('households/h1/pets/pet-a/p.jpg'), scope), 'households/h1/pets/pet-a/p.jpg');
    assert.equal(ownedPhotoPath(url('households/h1/pets/legacy.jpg'), scope), 'households/h1/pets/legacy.jpg', 'a legacy photo nobody else uses');
    assert.equal(ownedPhotoPath(url('households/h1/pets/legacy.jpg'), { ...scope, otherPetPhotoUrls: [url('households/h1/pets/legacy.jpg')] }), null, 'shared with another pet');
    assert.equal(ownedPhotoPath(url('households/h1/pets/pet-b/p.jpg'), scope), null, "another pet's folder");
    assert.equal(ownedPhotoPath(url('households/h2/pets/pet-a/p.jpg'), scope), null, 'another household');
    assert.equal(ownedPhotoPath(url('households/h1/pets/pet-a/p.jpg', undefined, 'other-bucket'), scope), null, 'another bucket');
    assert.equal(ownedPhotoPath(url('households/h1/barcode-library/p.jpg'), scope), null);
    assert.equal(ownedPhotoPath(url('households/h1/pets/../pets/pet-b/p.jpg'), scope), null);
    assert.equal(ownedPhotoPath('https://placehold.co/300x300.png', scope), null, 'the legacy placeholder');
    assert.equal(ownedPhotoPath('', scope), null);
    assert.equal(ownedPhotoPath('https://example.com/v0/b/x/o/households%2Fh1%2Fpets%2Fpet-a%2Fp.jpg', scope), null, 'another bucket name in the URL');
  });

  it('shrinks pet photos with the shared helper at the barcode library limits (PE-21e)', () => {
    assert.equal(PET_PHOTO_MAX_BYTES, 5 * 1024 * 1024);
    assert.equal(DEFAULT_MAX_EDGE, 1024);
    assert.deepEqual(planDownscale({ width: 4032, height: 3024, type: 'image/jpeg', bytes: 8_000_000 }, { maxBytes: PET_PHOTO_MAX_BYTES }).action, 'redraw');
    const draft = read('src/components/pets/pet-photo-draft.ts');
    assert.match(draft, /downscaleImage\(file, \{ maxBytes: PET_PHOTO_MAX_BYTES \}\)/);
    assert.match(draft, /downscaleErrorCopy\(result\.reason, PET_PHOTO_MAX_BYTES\)/);
    // Uploads go into the pet's own folder, and a replaced photo is removed only after the save.
    const api = read('src/components/pets/pet-profile-api.ts');
    assert.match(api, /petPhotoFolder\(householdId, petId\)/);
    assert.ok(api.indexOf('runUpdatePet(db') < api.indexOf('deleteReplacedPhoto(householdId, petId, replaced)'));
  });
});

describe('pet page tabs and ambient work', () => {
  it('has a Notes tab selectable with ?tab=notes (PE-29a)', () => {
    assert.ok((PET_TABS as readonly string[]).includes('notes'));
    assert.equal(petTabFromParam('notes'), 'notes');
  });

  it('stops the blink and the idle sway after a few cycles (PE-21d)', () => {
    const css = read('src/components/pets/pets.module.css');
    const blink = css.match(/\.eyes \{[^}]*animation: pet-blink 7s ease-in-out (\w+);/);
    const idle = css.match(/\.idle \{[^}]*animation: pet-idle 24s ease-in-out (\w+);/);
    assert.ok(blink && idle);
    assert.ok(Number(blink![1]) > 0 && Number(blink![1]) <= 10, 'a few blinks, not infinite');
    assert.ok(Number(idle![1]) > 0 && Number(idle![1]) <= 5, 'a few sways, not infinite');
    assert.doesNotMatch(css, /infinite/);
  });

  it('shows one skeleton from route to content (PE-21g)', () => {
    assert.match(read('src/app/pets/loading.tsx'), /PetsListSkeletonBody/);
    assert.match(read('src/app/pets/page.tsx'), /Suspense fallback=\{<div[^>]*><PetsListSkeletonBody \/><\/div>\}/);
    assert.match(read('src/components/pets-client.tsx'), /<PetsGridSkeleton \/>/);
    assert.match(read('src/app/pets/[petId]/loading.tsx'), /PetDetailSkeletonBody/);
    assert.match(read('src/app/pets/[petId]/page.tsx'), /<PetDetailSkeletonBody \/>/);
  });
});
