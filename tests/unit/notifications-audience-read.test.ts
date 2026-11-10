import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore';
import {
  AUDIENCE_EVERYONE,
  audienceQueryValues,
  isAddressedToMember,
  notificationAudience,
} from '../../functions/src/shared/notification-audience';
import { selectRecipientEmails } from '../../functions/src/push-policy';
import { isNotificationVisibleToUser, parseNotificationDoc } from '../../src/lib/notifications';

const ana = { uid: 'uid-ana', email: 'ana@example.test' };
const ben = { uid: 'uid-ben', email: 'ben@example.test' };
const members = [
  { ...ana, role: 'owner' },
  { ...ben, role: 'member' },
  { uid: 'uid-pending', email: 'pending@example.test', role: 'newuser', status: 'pending' },
];

const snapshot = (data: Record<string, unknown>) =>
  ({ id: 'n1', data: () => ({ createdAt: new Date(), message: 'Hi', ...data }) }) as unknown as QueryDocumentSnapshot<DocumentData>;

describe('notification audience (read side)', () => {
  test('list queries ask for the member and everyone', () => {
    assert.deepEqual(audienceQueryValues(ana.uid), [ana.uid, AUDIENCE_EVERYONE]);
  });

  test('a stored audience decides on its own', () => {
    assert.equal(isAddressedToMember({ audience: ['*'] }, ana), true);
    assert.equal(isAddressedToMember({ audience: [ana.uid] }, ana), true);
    assert.equal(isAddressedToMember({ audience: [ana.uid] }, ben), false);
    assert.equal(isAddressedToMember({ audience: [] }, ana), false);
    // The audience is never hidden by a conflicting legacy field.
    assert.equal(isAddressedToMember({ audience: ['*'], targetUserEmail: 'someone@else.test' }, ana), true);
    assert.equal(isAddressedToMember({ audience: [ben.uid], targetUserUid: ana.uid }, ana), false);
  });

  test('documents without audience fall back to the old targeting', () => {
    assert.equal(isAddressedToMember({}, ana), true);
    assert.equal(isAddressedToMember({ targetUserUid: ana.uid }, ana), true);
    assert.equal(isAddressedToMember({ targetUserUid: ana.uid }, ben), false);
    assert.equal(isAddressedToMember({ targetUserEmail: 'ANA@example.test' }, ana), true);
    assert.equal(isAddressedToMember({ targetUserEmail: ana.email }, ben), false);
    assert.equal(isAddressedToMember({ targetUserEmail: ana.email }, { uid: ana.uid }), false);
    assert.equal(isAddressedToMember({ audience: 'not-a-list' }, ana), true);
  });

  test('a stored audience and the targeting it was derived from agree', () => {
    for (const target of [{}, { targetUserUid: ana.uid }, { targetUserUid: ben.uid }]) {
      for (const member of [ana, ben]) {
        assert.equal(
          isAddressedToMember({ ...target, audience: notificationAudience(target) }, member),
          isAddressedToMember(target, member),
          JSON.stringify({ target, member }),
        );
      }
    }
  });

  test('parseNotificationDoc keeps a well-formed audience only', () => {
    assert.deepEqual(parseNotificationDoc(snapshot({ audience: ['*'] })).audience, ['*']);
    assert.equal(parseNotificationDoc(snapshot({ audience: [1] })).audience, undefined);
    assert.equal(parseNotificationDoc(snapshot({})).audience, undefined);
  });

  test('the bell/center filter shows what the audience says is visible', () => {
    const cases: Array<Record<string, unknown>> = [
      { audience: ['*'] },
      { audience: [ana.uid], targetUserUid: ana.uid },
      { audience: [ben.uid], targetUserUid: ben.uid },
      { audience: [], targetUserEmail: ana.email },
      { targetUserUid: ana.uid },
      { targetUserEmail: ben.email },
      {},
    ];
    for (const data of cases) {
      const parsed = parseNotificationDoc(snapshot(data));
      for (const member of [ana, ben]) {
        assert.equal(isNotificationVisibleToUser(parsed, member), isAddressedToMember(data, member), JSON.stringify({ data, member }));
      }
    }
  });

  test('push recipients follow the audience when present', () => {
    assert.deepEqual(selectRecipientEmails(members, { audience: ['*'] }).sort(), [ana.email, ben.email]);
    assert.deepEqual(selectRecipientEmails(members, { audience: [ben.uid], targetUserUid: ben.uid }), [ben.email]);
    assert.deepEqual(selectRecipientEmails(members, { audience: ['uid-pending'] }), []);
    assert.deepEqual(selectRecipientEmails(members, { audience: ['uid-stranger'] }), []);
    // Email-only legacy target stored with an empty audience: nobody.
    assert.deepEqual(selectRecipientEmails(members, { audience: [], targetUserEmail: ana.email }), []);
  });

  test('push recipients fall back to targetUserUid / targetUserEmail without audience', () => {
    assert.deepEqual(selectRecipientEmails(members, {}).sort(), [ana.email, ben.email]);
    assert.deepEqual(selectRecipientEmails(members, { targetUserUid: ana.uid }), [ana.email]);
    assert.deepEqual(selectRecipientEmails(members, { targetUserEmail: 'BEN@example.test' }), [ben.email]);
    assert.deepEqual(selectRecipientEmails(members, { targetUserUid: 'uid-pending' }), []);
  });
});
