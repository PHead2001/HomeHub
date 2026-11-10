import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildNotificationDocument } from '../../src/lib/notifications';
import type { User } from '../../src/lib/types';
import {
  AUDIENCE_EVERYONE,
  hasAudience,
  memberUidByEmail,
  notificationAudience,
} from '../../functions/src/shared/notification-audience';
import {
  AUDIENCE_EVERYONE as OPS_EVERYONE,
  audienceForNotification,
  backfillDecision,
  hasAudience as opsHasAudience,
  memberUidByEmail as opsMemberUidByEmail,
  needsMemberLookup,
} from '../../scripts/ops/notification-audience.mjs';

const members = [
  { uid: 'uid-ana', email: 'Ana@Example.test' },
  { uid: 'uid-ben', email: 'ben@example.test' },
  { uid: '', email: 'nouid@example.test' },
  { uid: 'uid-noemail' },
];

describe('notification audience (shared derivation)', () => {
  test('one member: [uid]; the uid wins over the email', () => {
    assert.deepEqual(notificationAudience({ targetUserUid: 'uid-ana' }), ['uid-ana']);
    assert.deepEqual(notificationAudience({ targetUserUid: 'uid-ana', targetUserEmail: 'ben@example.test' },
      memberUidByEmail(members)), ['uid-ana']);
  });

  test('household-wide: ["*"]', () => {
    assert.equal(AUDIENCE_EVERYONE, '*');
    assert.deepEqual(notificationAudience({}), ['*']);
    assert.deepEqual(notificationAudience({ targetUserUid: undefined, targetUserEmail: undefined }), ['*']);
    // Values that are not usable targets count as no target.
    assert.deepEqual(notificationAudience({ targetUserUid: '', targetUserEmail: '' }), ['*']);
    assert.deepEqual(notificationAudience({ targetUserUid: null, targetUserEmail: 7 }), ['*']);
  });

  test('legacy email-only target: the member\'s uid when known, otherwise nobody', () => {
    const lookup = memberUidByEmail(members);
    assert.deepEqual(notificationAudience({ targetUserEmail: 'ana@example.test' }, lookup), ['uid-ana']);
    assert.deepEqual(notificationAudience({ targetUserEmail: 'BEN@example.test' }, lookup), ['uid-ben']);
    assert.deepEqual(notificationAudience({ targetUserEmail: 'gone@example.test' }, lookup), []);
    assert.deepEqual(notificationAudience({ targetUserEmail: 'nouid@example.test' }, lookup), []);
    assert.deepEqual(notificationAudience({ targetUserEmail: 'ana@example.test' }), [], 'no lookup, never "*"');
  });

  test('hasAudience accepts only lists of strings', () => {
    for (const value of [['*'], ['uid-ana'], []]) assert.equal(hasAudience(value), true);
    for (const value of [undefined, null, '*', { 0: '*' }, [1], ['*', null]]) assert.equal(hasAudience(value), false);
  });
});

describe('notification audience (web app builder)', () => {
  test('the web app builder writes it for targeted and household-wide notifications', () => {
    const base = { householdId: 'h1', category: 'chores' as const, message: 'Hello' };
    const targeted = buildNotificationDocument({ ...base, targetUser: { uid: 'uid-ana', email: 'ana@example.test' } as User });
    assert.deepEqual(targeted.audience, ['uid-ana']);
    assert.equal(targeted.targetUserUid, 'uid-ana');
    const everyone = buildNotificationDocument(base);
    assert.deepEqual(everyone.audience, ['*']);
    assert.equal('targetUserUid' in everyone, false);
  });
});

describe('notification audience backfill (scripts/ops)', () => {
  const lookup = opsMemberUidByEmail(members);

  test('a document that already has an audience is left alone', () => {
    assert.deepEqual(backfillDecision({ audience: ['*'], targetUserUid: 'uid-ana' }, lookup), { kind: 'present' });
    assert.deepEqual(backfillDecision({ audience: [], targetUserEmail: 'ana@example.test' }, lookup), { kind: 'present' });
  });

  test('missing or malformed audience is filled from the targeting fields', () => {
    assert.deepEqual(backfillDecision({ targetUserUid: 'uid-ana', targetUserEmail: 'x@example.test' }, lookup),
      { kind: 'uid', audience: ['uid-ana'] });
    assert.deepEqual(backfillDecision({ targetUserEmail: 'ANA@example.test' }, lookup), { kind: 'email', audience: ['uid-ana'] });
    assert.deepEqual(backfillDecision({ targetUserEmail: 'gone@example.test' }, lookup), { kind: 'unresolvable', audience: [] });
    assert.deepEqual(backfillDecision({ category: 'system' }, lookup), { kind: 'everyone', audience: ['*'] });
    assert.deepEqual(backfillDecision({ audience: '*' }, lookup), { kind: 'everyone', audience: ['*'] });
    assert.deepEqual(backfillDecision({ audience: [1], targetUserUid: 'uid-ben' }, lookup), { kind: 'uid', audience: ['uid-ben'] });
    assert.deepEqual(backfillDecision(undefined, lookup), { kind: 'everyone', audience: ['*'] });
  });

  test('members are only needed for an email-only target without an audience', () => {
    assert.equal(needsMemberLookup({ targetUserEmail: 'ana@example.test' }), true);
    assert.equal(needsMemberLookup({ targetUserEmail: 'ana@example.test', targetUserUid: 'uid-ana' }), false);
    assert.equal(needsMemberLookup({ targetUserEmail: 'ana@example.test', audience: [] }), false);
    assert.equal(needsMemberLookup({}), false);
  });

  test('the scripts\' copy agrees with the shared derivation', () => {
    assert.equal(OPS_EVERYONE, AUDIENCE_EVERYONE);
    const shared = memberUidByEmail(members);
    const targets: Array<Record<string, unknown>> = [
      {}, { targetUserUid: 'uid-ana' }, { targetUserUid: 'uid-ana', targetUserEmail: 'ben@example.test' },
      { targetUserEmail: 'ana@example.test' }, { targetUserEmail: 'BEN@EXAMPLE.TEST' }, { targetUserEmail: 'gone@example.test' },
      { targetUserEmail: 'nouid@example.test' }, { targetUserUid: '', targetUserEmail: '' }, { targetUserUid: null },
      { targetUserUid: 5, targetUserEmail: 'ben@example.test' }, { targetUserUid: 'uid-zed', audience: ['ignored'] },
    ];
    for (const target of targets) {
      assert.deepEqual(audienceForNotification(target, lookup), notificationAudience(target, shared), JSON.stringify(target));
      assert.deepEqual(audienceForNotification(target), notificationAudience(target), JSON.stringify(target));
      const withoutAudience = { ...target };
      delete withoutAudience.audience;
      const decision = backfillDecision(withoutAudience, lookup);
      assert.deepEqual(decision.kind === 'present' ? null : decision.audience, notificationAudience(target, shared));
    }
    for (const value of [['*'], [], ['a', 'b'], undefined, null, '*', [1], {}]) {
      assert.equal(opsHasAudience(value), hasAudience(value));
    }
    for (const email of ['ana@example.test', 'ANA@EXAMPLE.TEST', 'ben@example.test', 'gone@example.test', 'nouid@example.test']) {
      assert.equal(lookup(email), shared(email));
    }
  });
});
