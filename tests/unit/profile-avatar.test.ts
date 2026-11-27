import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AVATAR_MAX_EDGE, avatarExtensionFor, ownAvatarPath, profilePhotoError } from '../../src/lib/profile/avatar';
import { planDownscale } from '../../src/lib/images/downscale';

const BUCKET = 'homehub.appspot.com';
const url = (path: string, bucket = BUCKET, host = 'https://firebasestorage.googleapis.com') =>
  `${host}/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=abc`;
const me = { uid: 'uid-1', email: 'me@example.test' };

describe('profile photos (PR-9)', () => {
  it('accepts HEIC (even with an empty type) and refuses other files', () => {
    assert.equal(profilePhotoError({ type: 'image/heic', size: 4_000_000 }), null);
    assert.equal(profilePhotoError({ type: '', size: 4_000_000, name: 'IMG_0001.HEIC' }), null);
    assert.equal(profilePhotoError({ type: 'image/jpeg', size: 12_000_000 }), null);
    assert.match(profilePhotoError({ type: 'image/svg+xml', size: 10 }) ?? '', /JPG, PNG, GIF, WebP or HEIC/);
    assert.match(profilePhotoError({ type: '', size: 10, name: 'notes.txt' }) ?? '', /Choose a photo/);
    assert.match(profilePhotoError({ type: 'image/png', size: 26 * 1024 * 1024 }) ?? '', /over 25 MB/);
  });

  it('takes the extension from the encoded type, never the file name', () => {
    assert.equal(avatarExtensionFor('image/jpeg'), 'jpg');
    assert.equal(avatarExtensionFor('image/png'), 'png');
    assert.equal(avatarExtensionFor('image/webp'), 'webp');
    assert.equal(avatarExtensionFor('IMAGE/PNG'), 'png');
    assert.equal(avatarExtensionFor(''), 'jpg');
  });

  it('always redraws at 512 px, so a small photo still loses its EXIF data', () => {
    const small = planDownscale({ width: 300, height: 300, type: 'image/jpeg', bytes: 50_000 }, { maxEdge: AVATAR_MAX_EDGE, force: true });
    assert.equal(small.action, 'redraw');
    const big = planDownscale({ width: 4032, height: 3024, type: 'image/heic', bytes: 3_000_000 }, { maxEdge: AVATAR_MAX_EDGE, force: true });
    assert.deepEqual(big.action === 'redraw' && [big.width, big.height, big.type], [512, 384, 'image/jpeg']);
  });

  it('finds the person\'s own previous upload (uid or older email folder) to delete', () => {
    assert.equal(ownAvatarPath(url('users/uid-1/avatars/a.jpg'), me, BUCKET), 'users/uid-1/avatars/a.jpg');
    assert.equal(ownAvatarPath(url('users/me@example.test/avatars/b.IMG'), me, BUCKET), 'users/me@example.test/avatars/b.IMG');
    // The emulator host works too.
    assert.equal(ownAvatarPath(url('users/uid-1/avatars/c.png', BUCKET, 'http://127.0.0.1:9199'), me, BUCKET), 'users/uid-1/avatars/c.png');
  });

  it('never deletes anything that is not the person\'s own upload', () => {
    assert.equal(ownAvatarPath('https://lh3.googleusercontent.com/a/photo=s96-c', me, BUCKET), null);
    assert.equal(ownAvatarPath(url('users/uid-2/avatars/a.jpg'), me, BUCKET), null);
    assert.equal(ownAvatarPath(url('users/uid-1/avatars/a.jpg', 'other-bucket'), me, BUCKET), null);
    assert.equal(ownAvatarPath(url('households/h/members/uid-1/avatar/a.jpg'), me, BUCKET), null);
    assert.equal(ownAvatarPath(url('users/uid-1/avatars/'), me, BUCKET), null);
    assert.equal(ownAvatarPath(url('users/uid-1/avatars/../../x'), me, BUCKET), null);
    assert.equal(ownAvatarPath('not a url', me, BUCKET), null);
    assert.equal(ownAvatarPath(null, me, BUCKET), null);
  });
});
