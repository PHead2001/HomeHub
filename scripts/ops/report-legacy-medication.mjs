// Reports legacy (name-keyed) pet medications before and after the medication
// course release (P3, D-P8). Dry run ONLY: it never writes. Legacy medications
// are never converted by a script: each one keeps its legacy countdown and
// reminders until a member confirms a schedule (or finishes or merges it) in
// the app's confirmation card on the pet's Medication tab.
//
// Usage:
//   node scripts/ops/report-legacy-medication.mjs --project homehub-j91jb
//   node scripts/ops/report-legacy-medication.mjs --project homehub-j91jb --firebase-tools-login
//
// Auth: as scripts/ops/migrate-push-tokens.mjs (see ./credentials.mjs). The
// account needs Firestore read access only.
//
// Output is counts only: never document contents, names or IDs.
import { FieldPath } from 'firebase-admin/firestore';
import { parseOpsArgs } from './profile-privacy.mjs';
import { opsFirestore } from './credentials.mjs';
import { classifyLegacyMedication, isLegacyLog, takenLegacyKeys } from './medication-legacy.mjs';

const PAGE_SIZE = 300;

const options = parseOpsArgs(process.argv.slice(2), process.env);
if (options.apply) {
  console.error('This report is a dry run only: legacy medication is confirmed by members in the app, never converted by a script. Run it without --apply.');
  process.exit(2);
}
const { projectId } = options;
const { db, label } = await opsFirestore(options);
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : 'live Firestore';
console.log(`Project ${projectId} (${target}, ${label}). Mode: dry run (read only).`);

const totals = {
  households: 0, pets: 0, petsWithLegacy: 0, legacyEntries: 0, courses: 0,
  names: 0, taken: 0, ended: 0, consistent: 0, conflicting: 0, noInterval: 0,
};

const reportPet = async (petRef, timeZone) => {
  totals.pets += 1;
  const [logs, courses] = await Promise.all([petRef.collection('medication-logs').get(), petRef.collection('medication-courses').get()]);
  totals.courses += courses.size;
  const entries = logs.docs.map(entry => entry.data());
  const legacy = entries.filter(isLegacyLog);
  if (legacy.length === 0) return;
  totals.petsWithLegacy += 1;
  totals.legacyEntries += legacy.length;
  for (const group of classifyLegacyMedication(entries, takenLegacyKeys(courses.docs.map(course => course.data())), timeZone)) {
    totals.names += 1;
    if (group.status === 'taken') totals.taken += 1;
    else if (group.status === 'ended') totals.ended += 1;
    else if (group.status === 'consistent') totals.consistent += 1;
    else if (group.status === 'conflicting') totals.conflicting += 1;
    else totals.noInterval += 1;
  }
};

const reportHousehold = async household => {
  const timeZone = household.get('timeZone');
  let cursor = null;
  for (;;) {
    let page = household.ref.collection('pets').select().orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    if (snapshot.empty) break;
    for (const pet of snapshot.docs) await reportPet(pet.ref, timeZone);
    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < PAGE_SIZE) break;
  }
};

let householdCursor = null;
for (;;) {
  let page = db.collection('households').select('timeZone').orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
  if (householdCursor) page = page.startAfter(householdCursor);
  const snapshot = await page.get();
  if (snapshot.empty) break;
  for (const household of snapshot.docs) {
    totals.households += 1;
    await reportHousehold(household);
  }
  householdCursor = snapshot.docs[snapshot.docs.length - 1];
  if (snapshot.size < PAGE_SIZE) break;
}

console.log(`Households scanned: ${totals.households}`);
console.log(`Pets scanned: ${totals.pets} (with legacy medication entries: ${totals.petsWithLegacy}; legacy entries: ${totals.legacyEntries}; courses: ${totals.courses})`);
console.log(`Legacy medication names: ${totals.names}`);
console.log(`  Taken over by a course (confirmed, merged or finished): ${totals.taken}`);
console.log(`  Countdown already ended (nothing to confirm): ${totals.ended}`);
console.log(`  Waiting for confirmation, consistent history (suggestion shown): ${totals.consistent}`);
console.log(`  Waiting for confirmation, ambiguous: conflicting gaps (no suggestion): ${totals.conflicting}`);
console.log(`  Waiting for confirmation, ambiguous: no usable gap (no suggestion): ${totals.noInterval}`);
console.log('Dry run only. Nothing was written; members confirm each legacy medication in the app.');
