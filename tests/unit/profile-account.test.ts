import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { accountDeletionBlocker, exportableProfile, isRecentSignIn, toPlain } from '../../src/lib/profile/account-data';

describe('download my data (PR-26)', () => {
  it('never exports device push tokens and turns Timestamps into ISO strings', () => {
    const at = Timestamp.fromDate(new Date('2026-08-01T12:00:00.000Z'));
    const out = exportableProfile({ displayName: 'Sam', fcmTokens: ['secret'], theme: { version: 2 }, updatedAt: at });
    assert.deepEqual(out, { displayName: 'Sam', theme: { version: 2 }, updatedAt: '2026-08-01T12:00:00.000Z' });
    assert.equal(exportableProfile(undefined), null);
  });

  it('keeps lists and nested maps as plain JSON', () => {
    assert.deepEqual(toPlain({ a: [1, { b: null }], c: undefined }), { a: [1, { b: null }], c: null });
  });
});

describe('delete my account (PR-26)', () => {
  const now = Date.parse('2026-08-01T12:00:00.000Z');
  it('needs a sign-in in the last five minutes', () => {
    assert.ok(isRecentSignIn(now / 1000 - 60, now));
    assert.ok(isRecentSignIn(now / 1000 - 300, now));
    assert.ok(!isRecentSignIn(now / 1000 - 301, now));
    assert.ok(!isRecentSignIn(undefined, now));
    assert.ok(!isRecentSignIn('123', now));
    // A token from the far future (a skewed clock) is not trusted either.
    assert.ok(!isRecentSignIn(now / 1000 + 600, now));
  });

  it('an owner must hand the household on, or delete it, first', () => {
    assert.equal(accountDeletionBlocker({ role: 'member' }, []), null);
    assert.equal(accountDeletionBlocker(null, []), null);
    assert.equal(accountDeletionBlocker({ role: 'owner' }, [{ kind: 'account' }]), 'owner_with_members');
    assert.equal(accountDeletionBlocker({ role: 'owner' }, [{}]), 'owner_with_members');
    // Kid profiles have no account: the owner is the only account holder.
    assert.equal(accountDeletionBlocker({ role: 'owner' }, [{ kind: 'identity' }]), 'owner_alone');
    assert.equal(accountDeletionBlocker({ role: 'owner' }, []), 'owner_alone');
  });
});
