// Moves push tokens from the housemate-readable profile field
// users/{email}.fcmTokens into the owner-only document
// users/{email}/private/push, then deletes the legacy field (notifications
// README). The send function reads both places, so pushes keep working before,
// during and after this runs. Run it by hand.
//
// Usage:
//   node scripts/ops/migrate-push-tokens.mjs --project homehub-j91jb           # dry run: counts only
//   node scripts/ops/migrate-push-tokens.mjs --project homehub-j91jb --apply   # moves the tokens
//
// Auth: Application Default Credentials, like scripts/deploy/verify-live-rules.mjs
// (`gcloud auth application-default login`, or GOOGLE_APPLICATION_CREDENTIALS).
//
// Output is counts only: never emails, document IDs or tokens. Each profile is
// moved in its own transaction (read both documents, write the merged list,
// delete the legacy field), so a token registered meanwhile is not lost.
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { FieldPath, FieldValue, getFirestore } from 'firebase-admin/firestore';
import { mergePushTokens, parseOpsArgs } from './profile-privacy.mjs';

const PAGE_SIZE = 400;

const { projectId, apply } = parseOpsArgs(process.argv.slice(2));
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : 'live Firestore';
console.log(`Project ${projectId} (${target}). Mode: ${apply ? 'APPLY (tokens will move)' : 'dry run (no writes)'}.`);

const app = initializeApp({ credential: applicationDefault(), projectId });
const db = getFirestore(app);

let scanned = 0;
let withLegacyField = 0;
let legacyTokens = 0;
let moved = 0;
let cursor = null;

for (;;) {
  let page = db.collection('users').select('fcmTokens').orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
  if (cursor) page = page.startAfter(cursor);
  const snapshot = await page.get();
  if (snapshot.empty) break;

  for (const profile of snapshot.docs) {
    scanned += 1;
    const data = profile.data();
    if (!Object.prototype.hasOwnProperty.call(data, 'fcmTokens')) continue;
    withLegacyField += 1;
    legacyTokens += Array.isArray(data.fcmTokens) ? data.fcmTokens.length : 0;
    if (!apply) continue;
    await db.runTransaction(async transaction => {
      const pushRef = profile.ref.collection('private').doc('push');
      const [fresh, push] = await Promise.all([transaction.get(profile.ref), transaction.get(pushRef)]);
      if (!fresh.exists) return;
      const tokens = mergePushTokens(fresh.get('fcmTokens'), push.get('fcmTokens'));
      if (tokens.length > 0) {
        transaction.set(pushRef, { fcmTokens: tokens, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
      transaction.update(profile.ref, { fcmTokens: FieldValue.delete() });
    });
    moved += 1;
  }
  cursor = snapshot.docs[snapshot.docs.length - 1];
  if (snapshot.size < PAGE_SIZE) break;
}

console.log(`Profiles scanned: ${scanned}`);
console.log(`Profiles with the legacy fcmTokens field: ${withLegacyField}`);
console.log(`Legacy tokens found: ${legacyTokens}`);
console.log(apply
  ? `Profiles migrated: ${moved}`
  : 'Dry run only. Re-run with --apply to move the tokens.');
