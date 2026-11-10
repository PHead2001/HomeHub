// Moves uploaded profile photos from the email-keyed Storage folder
// (`users/{email}/avatars/{file}`) to the account-ID folder
// (`users/{uid}/avatars/{file}`) and points `users/{email}.avatarUrl` and every
// membership record's `avatarUrl` at the copy (identity-profile README,
// "Profile photos"). The app uploads to the uid folder from release B on; this
// script covers photos uploaded before. The original files are kept (older
// builds and cached pages may still show them); a later release removes them.
//
// The uid comes from the profile's `uid` field and from membership records
// (document ID and `email`); a photo whose email maps to no single uid is left
// alone. Photos that are not uploads in this project (the Google account photo)
// are left alone. The copy keeps the file name, so re-running finds the copy
// made before and reuses it: the script can be stopped and re-run at any time.
//
// Usage:
//   node scripts/ops/migrate-avatars-to-uid.mjs --project homehub-j91jb           # dry run: counts only
//   node scripts/ops/migrate-avatars-to-uid.mjs --project homehub-j91jb --apply   # copies files, rewrites URLs
//
// Buckets: `<project>.firebasestorage.app` and `<project>.appspot.com`, plus
// HOMEHUB_STORAGE_BUCKET if set. Photos in any other bucket are left alone.
//
// Auth: as scripts/ops/migrate-push-tokens.mjs (see ./credentials.mjs), including
// --firebase-tools-login. The account needs Firestore read/write and Storage
// object read/create/metadata update.
//
// Output is counts only: never document contents, emails, IDs or URLs. Every
// URL rewrite is an update of the one field guarded by the document's update
// time: a document changed (or deleted) since it was read is skipped and
// counted, never overwritten; the next run picks it up.
import { randomUUID } from 'node:crypto';
import { FieldPath } from 'firebase-admin/firestore';
import { parseOpsArgs } from './profile-privacy.mjs';
import { opsFirestore, opsStorage } from './credentials.mjs';
import { avatarMigrationDecision, firstDownloadToken, storageDownloadUrl, uidsByEmail } from './avatar-path.mjs';

const PAGE_SIZE = 300;
const NOT_FOUND = 5;
const FAILED_PRECONDITION = 9;

const options = parseOpsArgs(process.argv.slice(2), process.env);
const { projectId, apply } = options;
const { db, label } = await opsFirestore(options);
const bucketNamed = await opsStorage(options);
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : 'live Firestore';
console.log(`Project ${projectId} (${target}, ${label}). Mode: ${apply ? 'APPLY (files will be copied and URLs rewritten)' : 'dry run (no writes)'}.`);

const buckets = new Set([`${projectId}.firebasestorage.app`, `${projectId}.appspot.com`]);
if (process.env.HOMEHUB_STORAGE_BUCKET) buckets.add(process.env.HOMEHUB_STORAGE_BUCKET);

const empty = () => ({ scanned: 0, none: 0, external: 0, 'uid-path': 0, 'no-uid': 0, migrate: 0, 'missing-file': 0, rewritten: 0, changed: 0 });
const totals = { files: { copied: 0, reused: 0 }, profiles: empty(), members: empty() };

/** Every document of a query, page by page (selected fields only). */
const readAll = async (base, fields) => {
  const docs = [];
  let cursor = null;
  for (;;) {
    let page = base.select(...fields).orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    docs.push(...snapshot.docs);
    if (snapshot.size < PAGE_SIZE) break;
    cursor = snapshot.docs[snapshot.docs.length - 1];
  }
  return docs;
};

const profiles = await readAll(db.collection('users'), ['uid', 'avatarUrl']);
const members = await readAll(db.collectionGroup('members'), ['email', 'avatarUrl']);
const uidByEmail = uidsByEmail([
  ...profiles.map(profile => ({ email: profile.id, uid: profile.get('uid') })),
  ...members.map(member => ({ email: member.get('email'), uid: member.id })),
]);

// One copy per original file, shared by the profile and every membership
// record that shows it. Resolves to the new download URL, or null when the
// original file no longer exists (or, in a dry run, a placeholder).
const copies = new Map();
const copyOnce = decision => {
  const key = `${decision.bucket}/${decision.fromPath}`;
  if (!copies.has(key)) copies.set(key, copyFile(decision));
  return copies.get(key);
};

const copyFile = async ({ bucket: bucketName, fromPath, toPath }) => {
  const bucket = bucketNamed(bucketName);
  const destination = bucket.file(toPath);
  const [copied] = await destination.exists();
  if (copied) {
    const [metadata] = await destination.getMetadata();
    let token = firstDownloadToken(metadata.metadata);
    if (!token) {
      if (!apply) return 'dry-run';
      token = randomUUID();
      await destination.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
    }
    totals.files.reused += 1;
    return storageDownloadUrl(bucketName, toPath, token);
  }
  const source = bucket.file(fromPath);
  const [present] = await source.exists();
  if (!present) return null;
  if (!apply) return 'dry-run';
  await source.copy(destination);
  // A token of its own: the original file's token must not open the copy.
  const token = randomUUID();
  await destination.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
  totals.files.copied += 1;
  return storageDownloadUrl(bucketName, toPath, token);
};

const rewrite = async (snapshot, counts) => {
  counts.scanned += 1;
  const decision = avatarMigrationDecision(snapshot.get('avatarUrl'), { buckets, uidByEmail });
  counts[decision.kind] += 1;
  if (decision.kind !== 'migrate') return;
  const url = await copyOnce(decision);
  if (url === null) {
    counts['missing-file'] += 1;
    return;
  }
  if (!apply || url === 'dry-run') return;
  try {
    await snapshot.ref.update({ avatarUrl: url }, { lastUpdateTime: snapshot.updateTime });
    counts.rewritten += 1;
  } catch (error) {
    if (error?.code !== NOT_FOUND && error?.code !== FAILED_PRECONDITION) throw error;
    counts.changed += 1;
  }
};

for (const profile of profiles) await rewrite(profile, totals.profiles);
for (const member of members) await rewrite(member, totals.members);

for (const [name, counts] of [['Profiles', totals.profiles], ['Membership records', totals.members]]) {
  console.log(`${name}: ${counts.scanned} scanned`);
  console.log(`  no photo: ${counts.none}`);
  console.log(`  not an uploaded photo in this project (left alone): ${counts.external}`);
  console.log(`  already under the account ID: ${counts['uid-path']}`);
  console.log(`  under an email with no known account ID (left alone): ${counts['no-uid']}`);
  console.log(`  under an email, to move: ${counts.migrate}`);
  console.log(`    original file missing (left alone): ${counts['missing-file']}`);
  if (apply) console.log(`    rewritten: ${counts.rewritten}; changed or deleted meanwhile and skipped: ${counts.changed}`);
}
if (apply) console.log(`Files copied: ${totals.files.copied}; copies from an earlier run reused: ${totals.files.reused}`);
if (!apply) console.log('Dry run only. Re-run with --apply to copy files and rewrite URLs.');
