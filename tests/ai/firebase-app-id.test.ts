import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizeFirebaseAppId } from '../../src/lib/firebase-app-id';

describe('Firebase web app ID', () => {
  test('restores the missing 1: prefix that App Check requires', () => {
    assert.equal(normalizeFirebaseAppId('562837692805:web:a21c3805ca4921564d24ec'), '1:562837692805:web:a21c3805ca4921564d24ec');
  });
  test('leaves a complete ID, other values and an unset value unchanged', () => {
    assert.equal(normalizeFirebaseAppId('1:562837692805:web:a21c3805ca4921564d24ec'), '1:562837692805:web:a21c3805ca4921564d24ec');
    assert.equal(normalizeFirebaseAppId('demo-app-id'), 'demo-app-id');
    assert.equal(normalizeFirebaseAppId(undefined), undefined);
  });
});
