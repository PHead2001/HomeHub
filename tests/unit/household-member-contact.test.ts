import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { contactEmailOf, memberEmailOf, withContactEmails } from '../../functions/src/shared/member-contact';
import { contactBackfillDecision, contactDocument } from '../../scripts/ops/member-contact.mjs';

describe('member email: the contact document only (member privacy release D)', () => {
  test('the contact document holds the email', () => {
    assert.equal(memberEmailOf({ email: 'record@example.test' }, { email: ' contact@example.test ' }), 'contact@example.test');
  });

  test('a missing, empty or malformed contact means no email; the record is never used', () => {
    for (const contact of [undefined, null, {}, { email: '' }, { email: '  ' }, { email: 42 }, 'contact@example.test']) {
      assert.equal(memberEmailOf({ email: 'record@example.test' }, contact), '');
    }
    assert.equal(memberEmailOf({}, undefined), '');
    assert.equal(contactEmailOf(null), '');
  });

  test('withContactEmails sets each email from the contact document and drops record emails', () => {
    const members = [
      { uid: 'a', email: 'a.old@example.test', role: 'owner' },
      { uid: 'b', email: 'b@example.test', role: 'member' },
      { uid: 'c', role: 'guest' },
    ];
    const contacts = new Map<string, unknown>([['a', { email: 'a@example.test' }], ['c', { email: 'c@example.test' }], ['b', { email: '' }]]);
    assert.deepEqual(withContactEmails(members, contacts), [
      { uid: 'a', email: 'a@example.test', role: 'owner' },
      { uid: 'b', role: 'member' },
      { uid: 'c', email: 'c@example.test', role: 'guest' },
    ]);
    assert.equal(withContactEmails(members, new Map())[2], members[2], 'a record without any email is passed through');
    assert.equal('email' in withContactEmails(members, new Map())[1], false);
  });
});

describe('contact backfill planner', () => {
  test('a record without an email is skipped', () => {
    for (const member of [undefined, null, {}, { email: '' }, { email: ' ' }, { email: 7 }]) {
      assert.deepEqual(contactBackfillDecision(member, null), { kind: 'no-email' });
    }
  });

  test('a missing contact document is created from the record email', () => {
    assert.deepEqual(contactBackfillDecision({ email: ' a@example.test ' }, null), { kind: 'missing', email: 'a@example.test' });
  });

  test('a matching contact document is left alone; a different one is updated', () => {
    assert.deepEqual(contactBackfillDecision({ email: 'a@example.test' }, { email: 'a@example.test', updatedAt: 'x' }), { kind: 'present' });
    assert.deepEqual(contactBackfillDecision({ email: 'a@example.test' }, { email: 'old@example.test' }), { kind: 'different', email: 'a@example.test' });
    assert.deepEqual(contactBackfillDecision({ email: 'a@example.test' }, {}), { kind: 'different', email: 'a@example.test' });
  });

  test('re-running after a write finds nothing to do', () => {
    const now = new Date('2026-11-10T12:00:00.000Z');
    const first = contactBackfillDecision({ email: 'a@example.test' }, null);
    assert.equal(first.kind, 'missing');
    const written = contactDocument((first as { email: string }).email, now);
    assert.deepEqual(written, { email: 'a@example.test', updatedAt: '2026-11-10T12:00:00.000Z' });
    assert.deepEqual(contactBackfillDecision({ email: 'a@example.test' }, written), { kind: 'present' });
  });
});
