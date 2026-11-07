// Removes the Google birthday and gender values that older sign-ins stored on
// users/{email} profiles. Sign-in no longer collects them (identity-profile
// README). Approved by the owner; run it by hand.
//
// Usage:
//   node scripts/ops/purge-profile-demographics.mjs --project homehub-j91jb           # dry run: counts only
//   node scripts/ops/purge-profile-demographics.mjs --project homehub-j91jb --apply   # deletes the two fields
//
// Auth: Application Default Credentials, like scripts/deploy/verify-live-rules.mjs
// (`gcloud auth application-default login`, or GOOGLE_APPLICATION_CREDENTIALS
// pointing at a service-account key). The account needs Firestore read/write.
//
// Output is counts only: never emails, document IDs or field values. The scan
// reads only the two fields (a projection), so the other profile data is never
// downloaded. --apply deletes just those fields with FieldValue.delete(), in
// batches of at most 400 writes; nothing else on the profile changes.
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { FieldPath, FieldValue, getFirestore } from 'firebase-admin/firestore';
import { DEMOGRAPHIC_FIELDS, countDemographics, demographicFieldsToDelete, parseOpsArgs } from './profile-privacy.mjs';

const PAGE_SIZE = 400;

const { projectId, apply } = parseOpsArgs(process.argv.slice(2));
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : 'live Firestore';
console.log(`Project ${projectId} (${target}). Mode: ${apply ? 'APPLY (fields will be deleted)' : 'dry run (no writes)'}.`);

const app = initializeApp({ credential: applicationDefault(), projectId });
const db = getFirestore(app);

const totals = { scanned: 0, birthday: 0, gender: 0 };
let updated = 0;
let cursor = null;

for (;;) {
  let page = db.collection('users').select(...DEMOGRAPHIC_FIELDS).orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
  if (cursor) page = page.startAfter(cursor);
  const snapshot = await page.get();
  if (snapshot.empty) break;

  const batch = db.batch();
  let writes = 0;
  for (const profile of snapshot.docs) {
    const fields = demographicFieldsToDelete(profile.data());
    countDemographics(totals, fields);
    if (apply && fields.length > 0) {
      batch.update(profile.ref, Object.fromEntries(fields.map(field => [field, FieldValue.delete()])));
      writes += 1;
    }
  }
  if (writes > 0) {
    await batch.commit();
    updated += writes;
  }
  cursor = snapshot.docs[snapshot.docs.length - 1];
  if (snapshot.size < PAGE_SIZE) break;
}

console.log(`Profiles scanned: ${totals.scanned}`);
console.log(`Profiles with birthday: ${totals.birthday}`);
console.log(`Profiles with gender: ${totals.gender}`);
console.log(apply
  ? `Profiles updated: ${updated}`
  : 'Dry run only. Re-run with --apply to delete these fields.');
