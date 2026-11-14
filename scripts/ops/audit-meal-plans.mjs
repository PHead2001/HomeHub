// Read-only audit of meal plans (Pets P2, PE-22i): how many pets have confirmed
// meal slots and, for the rest, what their confirmation in the app will need
// (suggested times to confirm, guessed times to check, times to set by hand, or
// nothing for a non-daily schedule). It never writes anything: pets get meal
// slots only when a member confirms them in the app (no silent conversion of a
// legacy schedule, D-P8 spirit). There is no --apply.
//
// Usage (it reads the app's own TypeScript parser through tsx, a dev dependency
// of this checkout, so it classifies exactly as the meal plan form suggests):
//   node --import tsx scripts/ops/audit-meal-plans.mjs --project homehub-j91jb
//   node --import tsx scripts/ops/audit-meal-plans.mjs --project homehub-j91jb --firebase-tools-login
//
// Auth: as scripts/ops/backfill-feeding-state.mjs (see ./credentials.mjs). The
// account needs Firestore read only.
//
// Output is counts only: never document contents, names or IDs.
import { FieldPath } from 'firebase-admin/firestore';
import { parseOpsArgs } from './profile-privacy.mjs';
import { opsFirestore } from './credentials.mjs';
// The TypeScript module loads as CommonJS (the package is not "type": "module"): read its exports object.
import mealPlanAudit from '../../src/lib/pets/meal-plan-audit.ts';

const { auditPetMealPlan, MEAL_PLAN_AUDIT_NEEDS } = mealPlanAudit;

const PAGE_SIZE = 300;

const argv = process.argv.slice(2);
if (argv.includes('--apply')) {
  console.error('This audit never writes. Meal times are converted only by a member confirming them in the app.');
  process.exit(2);
}
const options = parseOpsArgs(argv, process.env);
const { db, label } = await opsFirestore(options);
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : 'live Firestore';
console.log(`Project ${options.projectId} (${target}, ${label}). Mode: dry run (read only, no writes).`);

const totals = { households: 0, pets: 0 };
const kinds = Object.fromEntries(Object.keys(MEAL_PLAN_AUDIT_NEEDS).map((kind) => [kind, 0]));

const auditHousehold = async (household) => {
  let cursor = null;
  for (;;) {
    let page = household.ref.collection('pets').select('mealPlan', 'foodSchedule', 'feedingsPerDay').orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    if (snapshot.empty) break;
    for (const pet of snapshot.docs) {
      totals.pets += 1;
      kinds[auditPetMealPlan(pet.data())] += 1;
    }
    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < PAGE_SIZE) break;
  }
};

let householdCursor = null;
for (;;) {
  let page = db.collection('households').select().orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
  if (householdCursor) page = page.startAfter(householdCursor);
  const snapshot = await page.get();
  if (snapshot.empty) break;
  for (const household of snapshot.docs) {
    totals.households += 1;
    await auditHousehold(household);
  }
  householdCursor = snapshot.docs[snapshot.docs.length - 1];
  if (snapshot.size < PAGE_SIZE) break;
}

console.log(`Households scanned: ${totals.households}`);
console.log(`Pets scanned: ${totals.pets}`);
for (const [kind, count] of Object.entries(kinds)) {
  console.log(`${kind}: ${count} (needs: ${MEAL_PLAN_AUDIT_NEEDS[kind]})`);
}
console.log('Read only: nothing was written. Pets without confirmed meal times keep their legacy daily count until a member confirms times in the app.');
