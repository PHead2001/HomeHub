import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { exportableProfile, toPlain } from '../../src/lib/profile/account-data';

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
