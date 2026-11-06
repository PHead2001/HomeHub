import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  FRIENDLY_ERROR_MESSAGES,
  FRIENDLY_ERROR_TITLES,
  friendlyError,
  friendlyErrorKind,
  type FriendlyErrorKind,
} from '../../src/lib/friendly-error';
import { avatarGradient, avatarGradientPartner, avatarStackSlots, formatMemberNames, memberInitials } from '../../src/lib/member-avatar';
import { memberColor, memberColorIndex, type MemberColorIndex } from '../../src/lib/member-colors';
import { fieldErrorId, fieldErrorProps } from '../../src/lib/field-errors';
import { FirestorePermissionError } from '../../src/lib/errors';

const root = process.cwd();
const online = { online: true };

/** Shape of a FirebaseError without importing the SDK. */
function firebaseError(code: string, message = `Firebase: raw text (${code}).`) {
  return Object.assign(new Error(message), { name: 'FirebaseError', code });
}

describe('friendlyError', () => {
  const cases: Array<[unknown, FriendlyErrorKind]> = [
    [firebaseError('permission-denied', 'Missing or insufficient permissions.'), 'permission-denied'],
    [firebaseError('firestore/permission-denied'), 'permission-denied'],
    [firebaseError('storage/unauthorized'), 'permission-denied'],
    [new FirestorePermissionError({ path: 'households/x', operation: 'update' }), 'permission-denied'],
    [firebaseError('unavailable'), 'unavailable'],
    [firebaseError('auth/network-request-failed'), 'unavailable'],
    [new TypeError('Failed to fetch'), 'unavailable'],
    [firebaseError('deadline-exceeded'), 'deadline-exceeded'],
    [firebaseError('functions/deadline-exceeded'), 'deadline-exceeded'],
    [Object.assign(new Error('aborted'), { name: 'AbortError' }), 'deadline-exceeded'],
    [firebaseError('not-found'), 'not-found'],
    [firebaseError('storage/object-not-found'), 'not-found'],
    [firebaseError('resource-exhausted'), 'resource-exhausted'],
    [firebaseError('storage/quota-exceeded'), 'resource-exhausted'],
    [firebaseError('auth/too-many-requests'), 'resource-exhausted'],
    [firebaseError('unauthenticated'), 'unauthenticated'],
    [firebaseError('auth/user-token-expired'), 'unauthenticated'],
    [firebaseError('auth/requires-recent-login'), 'unauthenticated'],
    [{ status: 403 }, 'permission-denied'],
    [{ status: 429 }, 'resource-exhausted'],
    [{ status: 503 }, 'unavailable'],
    [firebaseError('internal', 'INTERNAL ASSERTION FAILED: Unexpected state'), 'unknown'],
    [new Error('Cannot read properties of undefined'), 'unknown'],
    ['boom', 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
    [42, 'unknown'],
  ];

  for (const [error, kind] of cases) {
    it(`maps ${JSON.stringify((error as { code?: string })?.code ?? (error as Error)?.message ?? error)} to ${kind}`, () => {
      assert.equal(friendlyErrorKind(error, online), kind);
      assert.equal(friendlyError(error, online), FRIENDLY_ERROR_MESSAGES[kind]);
    });
  }

  it('reports offline for network-shaped and unknown errors when the device is offline', () => {
    assert.equal(friendlyErrorKind(firebaseError('unavailable'), { online: false }), 'offline');
    assert.equal(friendlyErrorKind(new TypeError('Failed to fetch'), { online: false }), 'offline');
    assert.equal(friendlyErrorKind(new Error('???'), { online: false }), 'offline');
    // A real answer from the server is not hidden behind "offline".
    assert.equal(friendlyErrorKind(firebaseError('permission-denied'), { online: false }), 'permission-denied');
  });

  it('never returns the raw error text', () => {
    const raw = 'FirebaseError: [code=permission-denied]: Missing or insufficient permissions.';
    for (const error of [new Error(raw), firebaseError('weird-code', raw), raw]) {
      const message = friendlyError(error, online);
      assert.ok(!message.includes('Firebase'), message);
      assert.ok(!message.includes('[code='), message);
    }
  });

  it('has a plain-language message and title for every kind', () => {
    for (const kind of Object.keys(FRIENDLY_ERROR_MESSAGES) as FriendlyErrorKind[]) {
      assert.ok(FRIENDLY_ERROR_MESSAGES[kind].length > 10);
      assert.ok(FRIENDLY_ERROR_TITLES[kind].length > 0);
      assert.doesNotMatch(FRIENDLY_ERROR_MESSAGES[kind], /firebase|firestore|code|exception/i);
    }
  });
});

describe('member avatar helpers', () => {
  it('derives one or two initials', () => {
    assert.equal(memberInitials('Sam Lee'), 'SL');
    assert.equal(memberInitials('  sam  '), 'S');
    assert.equal(memberInitials('Mary Kate Olsen'), 'MO');
    assert.equal(memberInitials('sam.lee@example.com'), 'SL');
    assert.equal(memberInitials('(Mom) Ana'), 'MA');
    assert.equal(memberInitials('Émile zola'), 'ÉZ');
    assert.equal(memberInitials(''), '?');
    assert.equal(memberInitials(null), '?');
    assert.equal(memberInitials('!!!'), '?');
  });

  it('pairs every member color with a different token color for the gradient', () => {
    const partners = new Set<number>();
    for (let i = 1; i <= 8; i++) {
      const index = i as MemberColorIndex;
      const partner = avatarGradientPartner(index);
      assert.notEqual(partner, index);
      assert.ok(partner >= 1 && partner <= 8);
      partners.add(partner);
      const css = avatarGradient(index);
      assert.match(css, new RegExp(`--member-${index}\\)`));
      assert.match(css, new RegExp(`--member-${partner}\\)`));
      assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgb\(/i, 'only token colors');
    }
    assert.equal(partners.size, 8, 'partner mapping is a permutation');
  });

  it('uses the member color of the uid', () => {
    const c = memberColor('uid-sam');
    assert.equal(c.index, memberColorIndex('uid-sam'));
    assert.match(avatarGradient(c.index), new RegExp(`^linear-gradient\\(135deg, hsl\\(var\\(--member-${c.index}\\)\\)`));
  });

  it('splits a stack into visible avatars and a +k chip within max circles', () => {
    assert.deepEqual(avatarStackSlots(0, 4), { visible: 0, overflow: 0 });
    assert.deepEqual(avatarStackSlots(3, 4), { visible: 3, overflow: 0 });
    assert.deepEqual(avatarStackSlots(4, 4), { visible: 4, overflow: 0 });
    assert.deepEqual(avatarStackSlots(5, 4), { visible: 3, overflow: 2 });
    assert.deepEqual(avatarStackSlots(9, 1), { visible: 0, overflow: 9 });
    assert.deepEqual(avatarStackSlots(2, 0), { visible: 0, overflow: 2 });
  });

  it('names a group for assistive tech', () => {
    assert.equal(formatMemberNames([]), 'No members');
    assert.equal(formatMemberNames(['Sam']), 'Sam');
    assert.equal(formatMemberNames(['Sam', 'Alex']), 'Sam and Alex');
    assert.equal(formatMemberNames(['Sam', 'Alex', 'Jo']), 'Sam, Alex and Jo');
    assert.equal(formatMemberNames(['Sam', 'Alex', 'Jo', 'Kim', 'Lee']), 'Sam, Alex and 3 others');
  });
});

describe('field errors', () => {
  it('links an invalid field to its message', () => {
    assert.equal(fieldErrorId('list-name'), 'list-name-error');
    assert.deepEqual(fieldErrorProps('list-name', 'Give the list a name.'), {
      id: 'list-name',
      'aria-invalid': true,
      'aria-describedby': 'list-name-error',
    });
    assert.deepEqual(fieldErrorProps('list-name', null), { id: 'list-name' });
    assert.deepEqual(fieldErrorProps('list-name', false), { id: 'list-name' });
  });
});

describe('shared UI sources', () => {
  const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

  it('use tokens only (no raw color literals)', () => {
    for (const file of ['src/components/empty-state.tsx', 'src/components/member-avatar.tsx', 'src/components/field-error.tsx']) {
      assert.doesNotMatch(read(file), /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\((?!var)/, file);
    }
  });

  it('ships one illustration per empty-state kind', () => {
    const source = read('src/components/empty-state.tsx');
    for (const kind of ['chores', 'lists', 'pets', 'assets', 'notifications', 'generic']) {
      assert.match(source, new RegExp(`\\n  ${kind}: \\(`), kind);
    }
    assert.match(source, /aria-hidden="true"/);
  });

  it('keeps the toast viewport at the top, clear of dialog footers and the tab bar', () => {
    const toast = read('src/components/ui/toast.tsx');
    const viewport = toast.match(/"pointer-events-none fixed[^"]*"/)?.[0] ?? '';
    assert.match(viewport, /\btop-0\b/);
    assert.doesNotMatch(viewport, /bottom-0/);
    assert.match(viewport, /safe-area-inset-top/);
    assert.doesNotMatch(toast, /slide-in-from-bottom/);
  });
});
