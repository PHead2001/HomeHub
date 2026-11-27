// Removes the legacy `forcePasswordChange` field from users/{email} profiles
// (audit PR-8). Sign-in is Google-only, the dialog that read it is gone, and the
// rules no longer let a person write it, so a profile that still holds `true`
// can only be cleared here. Run it by hand.
//
// Usage:
//   node scripts/ops/clear-force-password-change.mjs --project homehub-j91jb           # dry run: counts only
//   node scripts/ops/clear-force-password-change.mjs --project homehub-j91jb --apply   # deletes the field
//
// Auth: as scripts/ops/purge-profile-demographics.mjs (./credentials.mjs):
// Application Default Credentials by default, or --firebase-tools-login.
//
// Output is counts only: never emails, document IDs or values. The scan reads
// only the one field (a projection); --apply deletes just that field with
// FieldValue.delete(), in batches of at most 400 writes.
import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { parseOpsArgs } from './profile-privacy.mjs';
import { opsFirestore } from './credentials.mjs';

const PAGE_SIZE = 400;
const FIELD = 'forcePasswordChange';

const options = parseOpsArgs(process.argv.slice(2), process.env);
const { projectId, apply } = options;
const { db, label } = await opsFirestore(options);
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : 'live Firestore';
console.log(`Project ${projectId} (${target}, ${label}). Mode: ${apply ? 'APPLY (field will be deleted)' : 'dry run (no writes)'}.`);

const totals = { scanned: 0, withField: 0, setTrue: 0 };
let updated = 0;
let cursor = null;

for (;;) {
  let page = db.collection('users').select(FIELD).orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
  if (cursor) page = page.startAfter(cursor);
  const snapshot = await page.get();
  if (snapshot.empty) break;

  const batch = db.batch();
  let writes = 0;
  for (const profile of snapshot.docs) {
    totals.scanned += 1;
    const data = profile.data();
    if (!(FIELD in data)) continue;
    totals.withField += 1;
    if (data[FIELD] === true) totals.setTrue += 1;
    if (apply) {
      batch.update(profile.ref, { [FIELD]: FieldValue.delete() });
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
console.log(`Profiles with the field: ${totals.withField} (true: ${totals.setTrue})`);
console.log(apply ? `Profiles updated: ${updated}` : 'Dry run only. Re-run with --apply to delete the field.');
