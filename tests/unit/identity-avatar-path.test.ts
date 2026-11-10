import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  avatarMigrationDecision,
  firstDownloadToken,
  parseStorageDownloadUrl,
  storageDownloadUrl,
  uidsByEmail,
} from '../../scripts/ops/avatar-path.mjs';

const BUCKET = 'demo-project.firebasestorage.app';
const buckets = new Set([BUCKET]);
const emailUrl = storageDownloadUrl(BUCKET, 'users/Pat@Example.test/avatars/abc.png', 'tok-1');

describe('Storage download URLs', () => {
  test('round-trip bucket and object path, including encoded characters', () => {
    assert.match(emailUrl, /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/demo-project\.firebasestorage\.app\/o\/users%2FPat%40Example\.test%2Favatars%2Fabc\.png\?alt=media&token=tok-1$/);
    assert.deepEqual(parseStorageDownloadUrl(emailUrl), { bucket: BUCKET, path: 'users/Pat@Example.test/avatars/abc.png' });
  });

  test('anything else is not a Storage download URL', () => {
    const others = [
      null,
      42,
      '',
      'not a url',
      'http://firebasestorage.googleapis.com/v0/b/x/o/y',
      'https://lh3.googleusercontent.com/a/photo',
      'https://firebasestorage.googleapis.com/v0/b/x/o/a/b',
      'https://firebasestorage.googleapis.com/v0/b/x/o/%E0%A4%A',
    ];
    for (const url of others) assert.equal(parseStorageDownloadUrl(url), null, String(url));
  });

  test('the first download token is used', () => {
    assert.equal(firstDownloadToken({ firebaseStorageDownloadTokens: ' a , b' }), 'a');
    for (const metadata of [undefined, null, {}, { firebaseStorageDownloadTokens: '' }, { firebaseStorageDownloadTokens: 3 }]) {
      assert.equal(firstDownloadToken(metadata), null);
    }
  });
});

describe('avatar migration planner', () => {
  const uidByEmail = new Map([['pat@example.test', 'uid-pat']]);

  test('a photo under a known email moves to the same file name under the uid', () => {
    assert.deepEqual(avatarMigrationDecision(emailUrl, { buckets, uidByEmail }), {
      kind: 'migrate', bucket: BUCKET, fromPath: 'users/Pat@Example.test/avatars/abc.png', toPath: 'users/uid-pat/avatars/abc.png',
    });
  });

  test('no photo, Google photos, other buckets and other paths are left alone', () => {
    assert.deepEqual(avatarMigrationDecision(null, { buckets, uidByEmail }), { kind: 'none' });
    assert.deepEqual(avatarMigrationDecision('  ', { buckets, uidByEmail }), { kind: 'none' });
    assert.deepEqual(avatarMigrationDecision('https://lh3.googleusercontent.com/a/p', { buckets, uidByEmail }), { kind: 'external' });
    assert.deepEqual(avatarMigrationDecision(storageDownloadUrl('other-bucket', 'users/pat@example.test/avatars/a.png', 't'), { buckets, uidByEmail }), { kind: 'external' });
    assert.deepEqual(avatarMigrationDecision(storageDownloadUrl(BUCKET, 'households/h/pets/a.png', 't'), { buckets, uidByEmail }), { kind: 'external' });
  });

  test('already under a uid: nothing to do (so a re-run is a no-op)', () => {
    const moved = storageDownloadUrl(BUCKET, 'users/uid-pat/avatars/abc.png', 't2');
    assert.deepEqual(avatarMigrationDecision(moved, { buckets, uidByEmail }), { kind: 'uid-path' });
  });

  test('an email with no known uid is left alone', () => {
    const url = storageDownloadUrl(BUCKET, 'users/nobody@example.test/avatars/a.png', 't');
    assert.deepEqual(avatarMigrationDecision(url, { buckets, uidByEmail }), { kind: 'no-uid' });
  });
});

describe('email to uid lookup', () => {
  test('profiles and membership records agree; case and spaces do not matter', () => {
    const map = uidsByEmail([{ email: ' Pat@Example.test', uid: 'u1' }, { email: 'pat@example.test', uid: 'u1' }, { email: 'sam@example.test', uid: 'u2' }]);
    assert.deepEqual([...map], [['pat@example.test', 'u1'], ['sam@example.test', 'u2']]);
  });

  test('an email claimed by two uids, or entries without both values, are dropped', () => {
    const map = uidsByEmail([
      { email: 'pat@example.test', uid: 'u1' },
      { email: 'pat@example.test', uid: 'u9' },
      { email: 'pat@example.test', uid: 'u1' },
      { email: '', uid: 'u3' },
      { email: 'x@example.test' },
      { email: 'y@example.test', uid: 'y@example.test' },
    ]);
    assert.equal(map.size, 0);
  });
});
