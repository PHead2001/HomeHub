// Creates `households/{h}/pets/{p}/feeding-state/current` (pets README, shared
// feed operation) for pets that have feeding logs but no state document yet,
// from each pet's newest feeding logs (`feedingStateFromLogs`). Existing state
// documents are never touched (create-only), so the script can be stopped and
// re-run at any time; a state written by a client meanwhile wins. Run it by
// hand after the release with rules stage R1 is deployed. Clients work without
// it (a pet without state reads as "no recent feed known" and falls back to the
// logs they have loaded), so it only makes the first "Feed again?" check exact.
//
// Usage:
//   node scripts/ops/backfill-feeding-state.mjs --project homehub-j91jb           # dry run: counts only
//   node scripts/ops/backfill-feeding-state.mjs --project homehub-j91jb --apply   # creates the documents
//
// Auth: as scripts/ops/migrate-push-tokens.mjs (see ./credentials.mjs), including
// --firebase-tools-login. The account needs Firestore read/write.
//
// Output is counts only: never document contents, names or IDs.
import { FieldPath, Timestamp } from 'firebase-admin/firestore';
import { parseOpsArgs } from './profile-privacy.mjs';
import { opsFirestore } from './credentials.mjs';
import { feedingStateFromLogs } from './feeding-state.mjs';

const PAGE_SIZE = 300;
// Newest entries per date shape, as the pet cards read them.
const NEWEST = 20;
const ALREADY_EXISTS = 6;
const MIN_TIMESTAMP = Timestamp.fromMillis(-62135596800000);

const options = parseOpsArgs(process.argv.slice(2), process.env);
const { projectId, apply } = options;
const { db, label } = await opsFirestore(options);
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : 'live Firestore';
console.log(`Project ${projectId} (${target}, ${label}). Mode: ${apply ? 'APPLY (feeding-state documents will be created)' : 'dry run (no writes)'}.`);

const totals = { households: 0, pets: 0, present: 0, noFeedings: 0, missing: 0, created: 0, raced: 0 };

// Timestamps and ISO strings sort separately in Firestore, so each shape is read on its own.
const newestLogs = async petRef => {
  const logs = petRef.collection('feeding-logs');
  const shapes = await Promise.all([
    logs.where('date', '>=', MIN_TIMESTAMP).orderBy('date', 'desc').limit(NEWEST).get(),
    logs.where('date', '>=', '').orderBy('date', 'desc').limit(NEWEST).get(),
  ]);
  return shapes.flatMap(snapshot => snapshot.docs.map(entry => ({ id: entry.id, ...entry.data() })));
};

const backfillPet = async (petRef, timeZone) => {
  totals.pets += 1;
  const stateRef = petRef.collection('feeding-state').doc('current');
  if ((await stateRef.get()).exists) {
    totals.present += 1;
    return;
  }
  const state = feedingStateFromLogs(await newestLogs(petRef), timeZone);
  if (!state) {
    totals.noFeedings += 1;
    return;
  }
  totals.missing += 1;
  if (!apply) return;
  try {
    await stateRef.create({ ...state, lastFedAt: Timestamp.fromDate(state.lastFedAt) });
    totals.created += 1;
  } catch (error) {
    // A client fed the pet between the read and the create: its state wins.
    if (error?.code !== ALREADY_EXISTS) throw error;
    totals.raced += 1;
  }
};

const backfillHousehold = async household => {
  const timeZone = household.get('timeZone');
  let cursor = null;
  for (;;) {
    let page = household.ref.collection('pets').select().orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    if (snapshot.empty) break;
    for (const pet of snapshot.docs) await backfillPet(pet.ref, timeZone);
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
    await backfillHousehold(household);
  }
  householdCursor = snapshot.docs[snapshot.docs.length - 1];
  if (snapshot.size < PAGE_SIZE) break;
}

console.log(`Households scanned: ${totals.households}`);
console.log(`Pets scanned: ${totals.pets}`);
console.log(`Already have feeding state: ${totals.present}`);
console.log(`No readable feedings (left without state): ${totals.noFeedings}`);
console.log(`Missing feeding state: ${totals.missing}`);
console.log(apply
  ? `Feeding-state documents created: ${totals.created}. Created by a client meanwhile and skipped: ${totals.raced}.`
  : 'Dry run only. Re-run with --apply to create the documents.');
