import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { birthdayGreeting, birthdayNamesOn, isBirthdayOn, nicknameError, parseBirthday, parseMemberColor } from '../../src/lib/profile/member-extras';
import { memberColorFor, memberColorIndex, memberColorMap } from '../../src/lib/member-colors';

describe('choose your colour (PR-24)', () => {
  it('accepts slots 1-8 or null only', () => {
    assert.equal(parseMemberColor(3), 3);
    assert.equal(parseMemberColor(null), null);
    for (const bad of [0, 9, 2.5, '3', undefined, {}]) assert.equal(parseMemberColor(bad), undefined);
  });

  it('a chosen colour wins; an earlier member who chose the same keeps it', () => {
    const map = memberColorMap([
      { uid: 'a', joinedAt: '2026-01-01', color: 5 },
      { uid: 'b', joinedAt: '2026-02-01', color: 5 },
      { uid: 'c', joinedAt: '2026-03-01' },
    ]);
    assert.equal(map.get('a')?.index, 5);
    assert.notEqual(map.get('b')?.index, 5);
    assert.equal(new Set([...map.values()].map((c) => c.index)).size, 3);
    // The map still reads in join order.
    assert.deepEqual([...map.keys()], ['a', 'b', 'c']);
  });

  it('someone without a choice moves off a chosen colour', () => {
    const own = memberColorIndex('x');
    const map = memberColorMap([{ uid: 'x', joinedAt: '2026-01-01' }, { uid: 'y', joinedAt: '2026-02-01', color: own }]);
    assert.equal(map.get('y')?.index, own);
    assert.notEqual(map.get('x')?.index, own);
  });

  it('a lone avatar uses the chosen colour, else the automatic one', () => {
    assert.equal(memberColorFor('x', 7).index, 7);
    assert.equal(memberColorFor('x', null).index, memberColorIndex('x'));
    assert.equal(memberColorFor('x', 12).index, memberColorIndex('x'));
  });
});

describe('nickname and birthday (PR-25)', () => {
  it('a nickname is one short word', () => {
    assert.equal(nicknameError(''), null);
    assert.equal(nicknameError('Mom'), null);
    assert.equal(nicknameError("O'Neil"), null);
    assert.equal(nicknameError('Zoë'), null);
    assert.match(nicknameError('Big Al') ?? '', /One word/);
    assert.match(nicknameError('x'.repeat(21)) ?? '', /20 characters/);
  });

  it('a birthday is a real month and day, no year', () => {
    assert.deepEqual(parseBirthday({ month: 2, day: 29 }), { month: 2, day: 29 });
    assert.equal(parseBirthday(null), null);
    for (const bad of [{ month: 2, day: 30 }, { month: 13, day: 1 }, { month: 4, day: 31 }, { month: 1.5, day: 1 }, '05-04', { month: 5 }]) {
      assert.equal(parseBirthday(bad), undefined, JSON.stringify(bad));
    }
  });

  it('falls on the household day; Feb 29 is celebrated on Feb 28 in other years', () => {
    assert.ok(isBirthdayOn({ month: 5, day: 4 }, '2026-05-04'));
    assert.ok(!isBirthdayOn({ month: 5, day: 4 }, '2026-05-05'));
    assert.ok(isBirthdayOn({ month: 2, day: 29 }, '2027-02-28'));
    assert.ok(!isBirthdayOn({ month: 2, day: 29 }, '2028-02-28'));
    assert.ok(isBirthdayOn({ month: 2, day: 29 }, '2028-02-29'));
  });

  it('names approved members only, by first name, never an email', () => {
    const records = [
      { uid: 'a', displayName: 'Sam Smith', role: 'member', status: 'active', birthday: { month: 5, day: 4 } },
      { uid: 'b', displayName: 'Mia', role: 'child', birthday: { month: 5, day: 4 } },
      { uid: 'c', displayName: 'Pending Pat', role: 'newuser', status: 'pending', birthday: { month: 5, day: 4 } },
      { uid: 'd', displayName: 'x@example.test', role: 'member', birthday: { month: 5, day: 4 } },
      { uid: 'e', displayName: 'Lee', role: 'member', birthday: { month: 6, day: 1 } },
    ];
    assert.deepEqual(birthdayNamesOn(records, '2026-05-04'), ['Mia', 'Sam']);
    assert.equal(birthdayGreeting(['Mia', 'Sam']), 'Happy birthday, Mia and Sam!');
    assert.equal(birthdayGreeting(['Sam']), 'Happy birthday, Sam!');
    assert.equal(birthdayGreeting([]), null);
  });
});
