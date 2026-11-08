import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MAX_PUSH_TOKENS,
  countDemographics,
  demographicFieldsToDelete,
  mergePushTokens,
  parseOpsArgs,
} from '../../scripts/ops/profile-privacy.mjs';

describe('profile demographics purge', () => {
  test('deletes only birthday and gender, and only when present', () => {
    assert.deepEqual(demographicFieldsToDelete({ email: 'a@example.test', birthday: '2/2', gender: 'female' }), ['birthday', 'gender']);
    assert.deepEqual(demographicFieldsToDelete({ birthday: '2/2' }), ['birthday']);
    assert.deepEqual(demographicFieldsToDelete({ gender: 'male', displayName: 'A' }), ['gender']);
    assert.deepEqual(demographicFieldsToDelete({ displayName: 'A', fcmTokens: [], theme: {} }), []);
    assert.deepEqual(demographicFieldsToDelete({}), []);
  });

  test('present but empty values are still removed', () => {
    assert.deepEqual(demographicFieldsToDelete({ birthday: null, gender: '' }), ['birthday', 'gender']);
    assert.deepEqual(demographicFieldsToDelete({ birthday: undefined }), ['birthday']);
  });

  test('look-alike and inherited fields are left alone', () => {
    assert.deepEqual(demographicFieldsToDelete({ Birthday: '1/1', genders: ['x'], birthdays: [] }), []);
    assert.deepEqual(demographicFieldsToDelete(Object.create({ birthday: '1/1' })), []);
  });

  test('missing or malformed documents delete nothing', () => {
    for (const value of [undefined, null, 'birthday', 42]) {
      assert.deepEqual(demographicFieldsToDelete(value as never), []);
    }
  });

  test('totals count profiles, never values', () => {
    const totals = { scanned: 0, birthday: 0, gender: 0 };
    countDemographics(totals, ['birthday', 'gender']);
    countDemographics(totals, ['gender']);
    countDemographics(totals, []);
    assert.deepEqual(totals, { scanned: 3, birthday: 1, gender: 2 });
  });
});

describe('push token migration', () => {
  test('merges legacy tokens after private ones without duplicates', () => {
    assert.deepEqual(mergePushTokens(['a', 'b'], ['b', 'c']), ['b', 'c', 'a']);
    assert.deepEqual(mergePushTokens(['a'], undefined), ['a']);
    assert.deepEqual(mergePushTokens(undefined, ['c']), ['c']);
    assert.deepEqual(mergePushTokens(null, null), []);
  });

  test('drops non-string and empty entries', () => {
    assert.deepEqual(mergePushTokens(['a', 1, null, '', { t: 'x' }], 'not-a-list'), ['a']);
  });

  test('keeps at most the newest tokens the rules allow', () => {
    const legacy = Array.from({ length: 25 }, (_, i) => `t${i}`);
    const merged = mergePushTokens(legacy, []);
    assert.equal(merged.length, MAX_PUSH_TOKENS);
    assert.equal(merged[merged.length - 1], 't24');
  });
});

describe('ops command line', () => {
  test('dry run is the default; --apply opts in', () => {
    assert.deepEqual(parseOpsArgs(['--project', 'demo-x']), { projectId: 'demo-x', apply: false, auth: 'adc', firebaseToolsFrom: null });
    assert.deepEqual(parseOpsArgs(['--apply', '--project', 'demo-x']), { projectId: 'demo-x', apply: true, auth: 'adc', firebaseToolsFrom: null });
  });

  test('a project is required and unknown flags are refused', () => {
    assert.throws(() => parseOpsArgs([]), /--project/);
    assert.throws(() => parseOpsArgs(['--project']), /--project/);
    assert.throws(() => parseOpsArgs(['--project', '--apply']), /--project/);
    assert.throws(() => parseOpsArgs(['--project', 'demo-x', '--aply']), /Unknown argument/);
  });

  test('ADC stays the default; --firebase-tools-login opts in', () => {
    const env = { HOMEHUB_FIREBASE_TOOLS_FROM: 'C:/deps' };
    assert.equal(parseOpsArgs(['--project', 'demo-x'], env).auth, 'adc');
    assert.equal(parseOpsArgs(['--project', 'demo-x'], env).firebaseToolsFrom, null);
    assert.deepEqual(parseOpsArgs(['--project', 'demo-x', '--firebase-tools-login'], {}), {
      projectId: 'demo-x', apply: false, auth: 'firebase-tools', firebaseToolsFrom: null,
    });
    assert.equal(parseOpsArgs(['--firebase-tools-login', '--project', 'demo-x'], env).firebaseToolsFrom, 'C:/deps');
    assert.equal(
      parseOpsArgs(['--project', 'demo-x', '--firebase-tools-login', '--firebase-tools-from', 'D:/tools'], env).firebaseToolsFrom,
      'D:/tools',
    );
  });

  test('the firebase-tools path needs a value and the login flag', () => {
    assert.throws(() => parseOpsArgs(['--project', 'demo-x', '--firebase-tools-login', '--firebase-tools-from']), /value/);
    assert.throws(() => parseOpsArgs(['--project', 'demo-x', '--firebase-tools-from', 'D:/tools']), /needs --firebase-tools-login/);
  });
});
