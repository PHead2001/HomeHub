import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FORMER_MEMBER_UID as SHARED_FORMER_MEMBER_UID, creditedPerson } from '../../functions/src/shared/chore-stats';
import { creditedUid } from '../../src/lib/chores/stats';
import { isEmailFolderPhotoUrl, memberProfileDiffers } from '../../src/lib/member-directory';
import { membershipAvatarUrl } from '../../src/lib/household-records';
import { loggerName } from '../../src/lib/pets/care';
import {
  FORMER_MEMBER_UID,
  choreRemainingEmailPlan,
  isEmailFolderPhotoUrl as isEmailFolderPhotoUrlJs,
  labelEmailPlan,
  memberRecordRemainingPlan,
  publicNamesByUid,
  templateRemainingEmailPlan,
} from '../../scripts/ops/remaining-email-scrub.mjs';

// scripts/ops/scrub-remaining-emails.mjs (member privacy release E) and the app
// changes that keep those copies from coming back.
const storageUrl = (path: string) =>
  `https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/${encodeURIComponent(path)}?alt=media&token=t`;
const EMAIL_PHOTO = storageUrl('users/sam@example.test/avatars/me.png');
const UID_PHOTO = storageUrl('users/uid-sam/avatars/me.png');
const names = publicNamesByUid([
  { uid: 'uid-sam', displayName: 'Sam Member' },
  { uid: 'uid-ana', displayName: 'ana@example.test' },
]);
const context = { uidByEmail: new Map([['sam@example.test', 'uid-sam']]), namesByUid: names };

describe('remaining email scrub', () => {
  test('public names never include an email', () => {
    assert.deepEqual([...names], [['uid-sam', 'Sam Member']]);
  });

  test('a former member’s completer email becomes a completer nobody is credited for', () => {
    const chore = { isCompleted: true, assignedToUid: 'uid-sam', completedByEmail: 'gone@example.test', completedByName: 'Gone' };
    const plan = choreRemainingEmailPlan(chore, context);
    assert.equal(plan.kind, 'scrub');
    if (plan.kind !== 'scrub') return;
    assert.deepEqual(plan.remove, [['completedByEmail']]);
    assert.deepEqual(plan.set, [[['completedByUid'], FORMER_MEMBER_UID]]);
    assert.equal(plan.formerCompleter, true);
    assert.equal(plan.emails, 0);
    // Credited to nobody, before and after, in the yearly stats and on the Chores page.
    const after = { ...chore, completedByEmail: undefined, completedByUid: FORMER_MEMBER_UID, completedAt: '2026-01-01T00:00:00Z' };
    assert.equal(creditedPerson({ ...chore, completedAt: '' } as never, [{ uid: 'uid-sam', email: 'sam@example.test' }]), null);
    assert.equal(creditedPerson(after as never, [{ uid: 'uid-sam', email: 'sam@example.test' }]), null);
    assert.equal(creditedUid(after as never, [{ uid: 'uid-sam', email: 'sam@example.test' }]), null);
    assert.equal(FORMER_MEMBER_UID, SHARED_FORMER_MEMBER_UID);
  });

  test('email labels become the current public name, else a neutral label', () => {
    const plan = choreRemainingEmailPlan({
      assignedToUid: 'uid-sam', assignedToDisplayName: 'sam@example.test',
      isCompleted: true, completedByUid: 'uid-ana', completedByName: 'ana@example.test',
    }, context);
    assert.equal(plan.kind, 'scrub');
    if (plan.kind !== 'scrub') return;
    assert.deepEqual(plan.remove, []);
    assert.deepEqual(plan.set, [[['assignedToDisplayName'], 'Sam Member'], [['completedByName'], 'Member']]);
    const unassigned = templateRemainingEmailPlan({ assignedToUid: '', assignedToDisplayName: 'x@example.test' }, context);
    assert.equal(unassigned.kind === 'scrub' && unassigned.set[0][1], 'Unassigned');
  });

  test('a leftover assignee email is removed after naming the member by uid, and the label follows the uid', () => {
    const plan = choreRemainingEmailPlan({ assignedToEmail: 'sam@example.test', assignedToDisplayName: 'sam@example.test' }, context);
    assert.equal(plan.kind, 'scrub');
    if (plan.kind !== 'scrub') return;
    assert.deepEqual(plan.remove, [['assignedToEmail']]);
    assert.deepEqual(plan.set, [[['assignedToUid'], 'uid-sam'], [['assignedToDisplayName'], 'Sam Member']]);
  });

  test('clean documents are left alone; running on the output finds nothing', () => {
    const clean = { assignedToUid: 'uid-sam', assignedToDisplayName: 'Sam Member', isCompleted: true, completedByUid: FORMER_MEMBER_UID, completedByName: 'Gone' };
    assert.deepEqual(choreRemainingEmailPlan(clean, context), { kind: 'clean' });
    assert.deepEqual(labelEmailPlan({ loggedByUid: 'uid-sam', loggedByName: 'Sam' }, 'pet-logs', names), { kind: 'clean' });
  });

  test('pet labels use the first name; the feeding state’s previous feed too', () => {
    assert.deepEqual(labelEmailPlan({ loggedByUid: 'uid-sam', loggedByName: 'sam@example.test' }, 'pet-logs', names),
      { kind: 'scrub', remove: [], set: [[['loggedByName'], 'Sam']], labels: 1 });
    const state = labelEmailPlan({ lastFedByUid: 'gone', lastFedByName: 'gone@example.test', prev: { lastFedByUid: 'uid-sam', lastFedByName: 'sam@example.test' } }, 'feeding-state', names);
    assert.deepEqual(state.kind === 'scrub' && state.set, [[['lastFedByName'], 'Someone'], [['prev', 'lastFedByName'], 'Sam']]);
    assert.deepEqual(labelEmailPlan({ uploadedByUid: 'uid-sam', uploadedByName: 'sam@example.test' }, 'maintenance-attachments', names),
      { kind: 'scrub', remove: [], set: [[['uploadedByName'], 'Sam Member']], labels: 1 });
  });

  test('membership records lose an email name and an email-folder photo; a record email is only counted', () => {
    assert.deepEqual(memberRecordRemainingPlan({ displayName: 'sam@example.test', avatarUrl: EMAIL_PHOTO, email: 'sam@example.test' }),
      { kind: 'scrub', remove: [['displayName'], ['avatarUrl']], set: [], email: true });
    assert.deepEqual(memberRecordRemainingPlan({ displayName: 'Sam', avatarUrl: UID_PHOTO }), { kind: 'clean', email: false });
  });
});

describe('email-folder photos never reach public member data', () => {
  test('the app and the script recognise the same URLs', () => {
    const cases = [EMAIL_PHOTO, UID_PHOTO, 'https://lh3.googleusercontent.com/a/photo', 'not a url', null, storageUrl('households/h1/pets/p.png')];
    for (const url of cases) assert.equal(isEmailFolderPhotoUrl(url), isEmailFolderPhotoUrlJs(url), String(url));
    assert.equal(isEmailFolderPhotoUrl(EMAIL_PHOTO), true);
    assert.equal(isEmailFolderPhotoUrl(UID_PHOTO), false);
  });

  test('joining never copies one, and a profile holding one is not drift', () => {
    assert.equal(membershipAvatarUrl({ avatarUrl: EMAIL_PHOTO }, UID_PHOTO), undefined);
    assert.equal(membershipAvatarUrl(undefined, EMAIL_PHOTO), undefined);
    assert.equal(membershipAvatarUrl({ avatarUrl: UID_PHOTO }), UID_PHOTO);
    assert.equal(memberProfileDiffers({ displayName: 'Sam', avatarUrl: undefined }, { displayName: 'Sam', avatarUrl: EMAIL_PHOTO }), false);
  });

  test('pet log names never come from the email', () => {
    assert.equal(loggerName({ displayName: 'sam@example.test' }), 'Someone');
  });
});
