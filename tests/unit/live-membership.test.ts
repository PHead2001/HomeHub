import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  canWatchHousehold,
  classifyListenerError,
  deletionNameField,
  deletionNameSuggestion,
  finishDeletingError,
  finishDeletingName,
  FINISH_DELETING_FAILED,
  stalePointerFor,
  initialMembershipState,
  liveProfile,
  membershipChangeNotice,
  membershipPhase,
  membershipReducer,
  membershipView,
  type LiveMembershipState,
  type MembershipEvent,
} from '../../src/lib/auth/live-membership';
import { getMemberPermissions } from '../../src/lib/permissions';
import { clearJournal, forgetHouseholdJournal, readJournal, UNDO_JOURNAL_KEY, type UndoEntry } from '../../src/lib/shopping/undo';
import type { HouseholdMember, User } from '../../src/lib/types';
import { forgetHouseholdKeys, HOUSEHOLD_KEY_PREFIXES } from '../../src/lib/auth/household-scope';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const H = 'house-a';
const UID = 'uid-1';

const run = (events: MembershipEvent[], from: LiveMembershipState = initialMembershipState) => events.reduce(membershipReducer, from);
const watch = (householdId: string | null, uid: string | null = UID): MembershipEvent => ({ type: 'watch', uid, householdId });
const member = (data: Record<string, unknown> | null, { fromCache = false, offline = false, householdId = H, uid = UID } = {}): MembershipEvent => ({
  type: 'member', householdId, uid, exists: data !== null, data: data ?? undefined, fromCache, offline,
});
const householdDoc = (data: Record<string, unknown> | null, { fromCache = false, householdId = H } = {}): MembershipEvent => ({
  type: 'household', householdId, exists: data !== null, data: data ?? undefined, fromCache,
});
const active = (role = 'member', extra: Record<string, unknown> = {}) => ({ role, status: 'active', joinedAt: '2026-01-01', ...extra });
const pending = (extra: Record<string, unknown> = {}) => ({ role: 'newuser', status: 'pending', joinedAt: '2026-01-01', householdName: 'The Foxes', ...extra });

/** An approved member with the household document loaded. */
const approved = (role = 'member') => run([watch(H), member(active(role)), householdDoc({ name: 'The Foxes', ownerUid: 'o' })]);
const view = (state: LiveMembershipState, pointer: string | null = state.householdId, confirmed = true, profileUid: string | null = state.uid) =>
  membershipView(state, profileUid, pointer, confirmed);

const profile = (extra: Partial<User> = {}): User => ({
  uid: UID, email: 'pat@example.test', firstName: '', lastName: '', displayName: 'Pat', avatarUrl: null,
  role: 'member', householdId: H, permissions: {}, ...extra,
} as User);

describe('live membership: listener errors', () => {
  test('only a permission denial counts as denied; offline and other errors are transient', () => {
    assert.equal(classifyListenerError({ code: 'permission-denied' }), 'denied');
    assert.equal(classifyListenerError({ code: 'unavailable' }), 'transient');
    assert.equal(classifyListenerError({ code: 'deadline-exceeded' }), 'transient');
    assert.equal(classifyListenerError(new Error('network')), 'transient');
    assert.equal(classifyListenerError(null), 'transient');
  });
});

describe('live membership: phases', () => {
  test('signed out or no household: nothing to watch, onboarding once the profile is confirmed', () => {
    assert.equal(membershipPhase(initialMembershipState), 'none');
    assert.equal(view(initialMembershipState, null, true).phase, 'none');
    // A cached profile is not proof there is no household yet.
    assert.equal(view(initialMembershipState, null, false).phase, 'loading');
  });

  test('loading until the record answers; a new pointer never flashes onboarding', () => {
    const state = run([watch(H)]);
    assert.equal(membershipPhase(state), 'loading');
    assert.equal(view(state).phase, 'loading');
    // The profile already points somewhere the machine does not watch yet.
    assert.equal(view(initialMembershipState, H, true).phase, 'loading');
  });

  test('an approved record waits for the household document, then the member view', () => {
    const recordOnly = run([watch(H), member(active())]);
    assert.equal(view(recordOnly).phase, 'loading');
    assert.equal(canWatchHousehold(recordOnly), true);
    const state = approved();
    const shown = view(state);
    assert.equal(shown.phase, 'member');
    assert.equal(shown.household?.name, 'The Foxes');
    assert.equal(shown.member?.role, 'member');
  });

  test('a cached record and household show at once (repeat visit), the server confirms later', () => {
    const state = run([watch(H), member(active(), { fromCache: true }), householdDoc({ name: 'The Foxes' }, { fromCache: true })]);
    assert.equal(view(state).phase, 'member');
    assert.equal(state.memberFromServer, false);
    const confirmed = membershipReducer(state, member(active()));
    assert.equal(confirmed.memberFromServer, true);
    assert.equal(confirmed.member, state.member, 'unchanged data keeps the same record object');
  });

  test('pending: the waiting view from the own record, never the household document', () => {
    const state = run([watch(H), member(pending())]);
    const shown = view(state);
    assert.equal(shown.phase, 'pending');
    assert.deepEqual(shown.household, { id: H, name: 'The Foxes' });
    assert.equal(shown.member?.role, 'newuser');
    assert.equal(canWatchHousehold(state), false);
    // A late household answer for a pending person is ignored.
    assert.equal(membershipReducer(state, householdDoc({ name: 'x' })), state);
  });
});

describe('live membership: changes while the page is open', () => {
  test('approval: pending, then loading while the household document loads, then the app', () => {
    const waiting = run([watch(H), member(pending())]);
    const approvedRecord = membershipReducer(waiting, member(active('member')));
    assert.equal(view(approvedRecord).phase, 'loading');
    assert.equal(canWatchHousehold(approvedRecord), true);
    const inside = membershipReducer(approvedRecord, householdDoc({ name: 'The Foxes' }));
    assert.equal(view(inside).phase, 'member');
    assert.deepEqual(
      membershipChangeNotice({ uid: UID, householdId: H, phase: 'pending', role: 'newuser' }, { uid: UID, householdId: H, phase: 'member', role: 'member' }),
      { title: "You're in", description: 'An owner or admin approved you as Member.' },
    );
  });

  test('role change: the record, the permissions and the profile follow at once', () => {
    const before = approved('member');
    const after = membershipReducer(before, member(active('child')));
    assert.notEqual(after.member, before.member);
    assert.equal(view(after).member?.role, 'child');
    assert.equal(getMemberPermissions(view(before).member)['shopping.view'], true);
    assert.equal(getMemberPermissions(view(after).member)['shopping.view'], false);
    const user = liveProfile(profile({ role: 'member' }), view(after), H);
    assert.equal(user?.role, 'child');
    assert.equal(user?.householdId, H);
    assert.deepEqual(
      membershipChangeNotice({ uid: UID, householdId: H, phase: 'member', role: 'member' }, { uid: UID, householdId: H, phase: 'member', role: 'child' }),
      { title: 'Your role changed', description: 'Your role is now Child. What you can do here changed with it.' },
    );
  });

  test('permission override change: effective permissions update without a role change', () => {
    const before = approved('member');
    const after = membershipReducer(before, member(active('member', { permissions: { 'shopping.view': false } })));
    assert.equal(getMemberPermissions(view(after).member)['shopping.view'], false);
    assert.deepEqual(liveProfile(profile(), view(after), H)?.permissions, { 'shopping.view': false });
    assert.equal(membershipChangeNotice({ uid: UID, householdId: H, phase: 'member', role: 'member' }, { uid: UID, householdId: H, phase: 'member', role: 'member' }), null);
  });

  test('a snapshot that changes nothing keeps the same state (no re-render, no re-run)', () => {
    const state = approved();
    assert.equal(membershipReducer(state, member(active())), state);
    assert.equal(membershipReducer(state, member(active(), { fromCache: true })), state);
    assert.equal(membershipReducer(state, householdDoc({ ownerUid: 'o', name: 'The Foxes' })), state);
  });

  test('household rename arrives live', () => {
    const renamed = membershipReducer(approved(), householdDoc({ name: 'Fox Den', ownerUid: 'o' }));
    assert.equal(view(renamed).household?.name, 'Fox Den');
  });

  test('no notice on the first load, for another household, or the same role', () => {
    assert.equal(membershipChangeNotice(null, { uid: UID, householdId: H, phase: 'member', role: 'member' }), null);
    assert.equal(membershipChangeNotice({ uid: UID, householdId: 'b', phase: 'pending', role: 'newuser' }, { uid: UID, householdId: H, phase: 'member', role: 'member' }), null);
    assert.equal(membershipChangeNotice({ uid: UID, householdId: H, phase: 'member', role: 'admin' }, { uid: UID, householdId: H, phase: 'none', role: null }), null);
  });
});

describe('live membership: access ends', () => {
  test('removed: the server says the record is gone; everything of the household is dropped', () => {
    const state = membershipReducer(approved(), member(null));
    assert.deepEqual(state.ended, { householdId: H, reason: 'removed' });
    assert.equal(state.member, null);
    assert.equal(state.household, null);
    const shown = view(state);
    assert.equal(shown.phase, 'ended');
    assert.equal(shown.household, null);
    assert.equal(shown.member, null);
    assert.equal(canWatchHousehold(state), false);
    const user = liveProfile(profile({ role: 'member', householdId: H }), shown, state.householdId);
    assert.equal(user?.householdId, null);
    assert.deepEqual(user?.permissions, {});
    assert.equal(getMemberPermissions(shown.member)['household.view'], false);
  });

  test('declined: a pending request removed; deleted: a frozen record removed', () => {
    assert.equal(run([watch(H), member(pending()), member(null)]).ended?.reason, 'declined');
    const frozen = membershipReducer(approved('owner'), member(active('owner', { status: 'deleting' })));
    const shown = view(frozen);
    assert.equal(shown.phase, 'deleting');
    assert.equal(shown.household?.name, 'The Foxes');
    assert.ok(shown.household?.deletingAt);
    assert.equal(canWatchHousehold(frozen), false);
    assert.equal(membershipReducer(frozen, member(null)).ended?.reason, 'deleted');
  });

  test('the profile pointer can be cleared before the record snapshot arrives: still a removal', () => {
    const state = membershipReducer(approved(), watch(null));
    assert.deepEqual(state.ended, { householdId: H, reason: 'removed' });
    // The record's own answer afterwards changes nothing.
    assert.equal(membershipReducer(state, member(null)), state);
    assert.equal(view(state, null).phase, 'ended');
  });

  test('the notice survives the pointer being cleared and goes away when dismissed', () => {
    const ended = run([member(null), watch(null)], approved());
    assert.equal(view(ended, null).phase, 'ended');
    const dismissed = membershipReducer(ended, { type: 'dismissEnded' });
    assert.equal(view(dismissed, null).phase, 'none');
  });

  test('before the profile is confirmed an ended membership shows as loading (the confirmed profile decides)', () => {
    const state = membershipReducer(approved(), member(null));
    assert.equal(view(state, H, false).phase, 'loading');
  });

  test('a stale pointer (never a member here): onboarding, no notice', () => {
    const state = run([watch(H), member(null)]);
    assert.equal(state.ended, null);
    assert.equal(state.memberFromServer, true);
    assert.equal(view(state).phase, 'none');
  });

  test('leaving or deleting on this device needs no notice; a refused attempt keeps the notice working', () => {
    const leaving = membershipReducer(approved(), { type: 'endingHere', householdId: H });
    assert.equal(membershipReducer(leaving, member(null)).ended, null);
    assert.equal(membershipReducer(leaving, watch(null)).ended, null);
    const refused = membershipReducer(leaving, { type: 'endingHereCancelled' });
    assert.equal(membershipReducer(refused, member(null)).ended?.reason, 'removed');
    // The owner deleting here keeps the page until the action answers.
    const deleting = membershipReducer(membershipReducer(approved('owner'), { type: 'endingHere', householdId: H }), member(active('owner', { status: 'deleting' })));
    assert.equal(view(deleting).phase, 'member');
    // "Finish deleting" from the frozen screen stays on that screen.
    const frozen = membershipReducer(approved('owner'), member(active('owner', { status: 'deleting' })));
    assert.equal(view(membershipReducer(frozen, { type: 'endingHere', householdId: H })).phase, 'deleting');
  });

  test('leaving here resets the household but keeps the account; sign-out resets everything, without a notice', () => {
    assert.deepEqual(membershipReducer(approved(), { type: 'reset' }), { ...initialMembershipState, uid: UID });
    assert.deepEqual(membershipReducer(approved(), watch(null, null)), initialMembershipState);
  });
});

describe('live membership: offline is not removal', () => {
  test('a cached "does not exist" is ignored', () => {
    const state = approved();
    assert.equal(membershipReducer(state, member(null, { fromCache: true })), state);
    assert.equal(membershipReducer(run([watch(H)]), member(null, { fromCache: true })).loadFailed, false);
  });

  test('offline with nothing cached: the retry screen, never onboarding', () => {
    const state = membershipReducer(run([watch(H)]), member(null, { fromCache: true, offline: true }));
    assert.equal(view(state).phase, 'failed');
    // A later answer opens the app by itself.
    assert.equal(view(run([member(active()), householdDoc({ name: 'x' })], state)).phase, 'member');
  });

  test('a network error keeps the last known state; with nothing known it offers a retry', () => {
    const state = approved();
    assert.equal(membershipReducer(state, { type: 'memberError', householdId: H, failure: 'transient' }), state);
    const nothing = membershipReducer(run([watch(H)]), { type: 'memberError', householdId: H, failure: 'transient' });
    assert.equal(view(nothing).phase, 'failed');
    assert.equal(view(membershipReducer(nothing, { type: 'retry' })).phase, 'loading');
  });

  test('a denial on the record ends access; a denial on the household document does not', () => {
    const denied = membershipReducer(approved(), { type: 'memberError', householdId: H, failure: 'denied' });
    assert.equal(denied.ended?.reason, 'removed');
    const state = approved();
    assert.equal(membershipReducer(state, { type: 'householdError', householdId: H, failure: 'denied' }), state);
    assert.equal(membershipReducer(state, householdDoc(null)), state, 'a missing household document follows the record');
  });

  test('after access ended, cached copies never bring the record back; the server can', () => {
    const ended = membershipReducer(approved(), { type: 'memberError', householdId: H, failure: 'denied' });
    assert.equal(membershipReducer(ended, member(active(), { fromCache: true })), ended);
    const back = membershipReducer(ended, member(active()));
    assert.equal(back.ended, null);
    assert.equal(back.member?.role, 'member');
  });

  test('loading too long: the retry screen; only while loading', () => {
    const slow = membershipReducer(run([watch(H)]), { type: 'loadTimeout', householdId: H });
    assert.equal(view(slow).phase, 'failed');
    const state = approved();
    assert.equal(membershipReducer(state, { type: 'loadTimeout', householdId: H }), state);
    // An approved record whose household document never arrives also times out.
    assert.equal(view(run([watch(H), member(active()), { type: 'loadTimeout', householdId: H }])).phase, 'failed');
  });
});

describe('live membership: household switched', () => {
  test('a new pointer drops everything of the old household and any notice', () => {
    const switched = membershipReducer(approved(), watch('house-b'));
    assert.deepEqual(switched, { ...initialMembershipState, uid: UID, householdId: 'house-b' });
    const afterNotice = run([member(null), watch('house-b')], approved());
    assert.equal(afterNotice.ended, null);
  });

  test('answers for the old household after a switch are ignored', () => {
    const switched = membershipReducer(approved(), watch('house-b'));
    assert.equal(membershipReducer(switched, member(active('owner'))), switched);
    assert.equal(membershipReducer(switched, householdDoc({ name: 'Old' })), switched);
    assert.equal(membershipReducer(switched, { type: 'memberError', householdId: H, failure: 'denied' }), switched);
  });

  test('a household created or joined here is shown at once', () => {
    // Signed in with no household yet: the account is known.
    const noHousehold = run([watch(null)]);
    const created = membershipReducer(noHousehold, {
      type: 'adopt', householdId: 'new', member: { uid: UID, role: 'owner', status: 'active', joinedAt: 'x' } as HouseholdMember, household: { id: 'new', name: 'New' },
    });
    assert.equal(view(created).phase, 'member');
    const joined = membershipReducer(noHousehold, {
      type: 'adopt', householdId: 'new', member: { uid: UID, role: 'newuser', status: 'pending', joinedAt: 'x' } as HouseholdMember, household: { id: 'new', name: 'New' },
    });
    assert.equal(view(joined).phase, 'pending');
    assert.equal(view(joined).household?.name, 'New');
    // The profile pointer catching up changes nothing.
    assert.equal(membershipReducer(joined, watch('new')), joined);
  });
});

describe('live membership: profile overlay', () => {
  test('keeps the same profile object when nothing differs', () => {
    const p = profile({ role: 'member', permissions: {} });
    assert.equal(liveProfile(p, view(approved('member')), H), p);
    const none = profile({ householdId: null, role: 'member', permissions: {} });
    assert.equal(liveProfile(none, view(initialMembershipState, null), null), none);
    assert.equal(liveProfile(null, view(approved()), H), null);
  });

  test('a stale role or pointer cached on the profile never wins over the record', () => {
    const user = liveProfile(profile({ role: 'owner', permissions: { 'household.delete': true } }), view(approved('guest')), H);
    assert.equal(user?.role, 'guest');
    assert.deepEqual(user?.permissions, {});
  });

  test('while loading the profile pointer is kept (screens show their loading states)', () => {
    const p = profile();
    assert.equal(liveProfile(p, view(run([watch(H)])), H), p);
  });
});

describe('household data on this device', () => {
  const memoryStorage = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
      values,
    };
  };
  const entry = (householdId: string, opId: string): UndoEntry => ({
    group: 'shopping-tick', uid: UID, householdId, listId: 'l', itemId: 'i', name: 'Milk', opId, expiresAt: 10_000,
  });

  test('per-household keys (the pantry recent list) are forgotten for one household, or all', () => {
    const values = new Map<string, string>([
      ['homehub.pantry.recentList.house-a', 'l1'],
      ['homehub.pantry.recentList.house-b', 'l2'],
      ['homehub.appearance', 'keep'],
    ]);
    const storage = {
      get length() { return values.size; },
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => { values.delete(key); },
    };
    forgetHouseholdKeys(storage, H);
    assert.deepEqual([...values.keys()], ['homehub.pantry.recentList.house-b', 'homehub.appearance']);
    forgetHouseholdKeys(storage, null);
    assert.deepEqual([...values.keys()], ['homehub.appearance']);
    // The prefix is the one the pantry writes.
    const pantry = readFileSync(resolve(__dirname, '../../src/components/pantry-inventory-client.tsx'), 'utf8');
    for (const prefix of HOUSEHOLD_KEY_PREFIXES) assert.ok(pantry.includes(`\`${prefix}\${householdId}\``), prefix);
  });

  test('the Undo journal forgets one household, or everything at sign-out', () => {
    const storage = memoryStorage();
    storage.setItem(UNDO_JOURNAL_KEY, JSON.stringify([entry(H, 'a'), { ...entry('house-b', 'b'), group: 'shopping-tick' }]));
    const left = forgetHouseholdJournal(storage, H, 0);
    assert.deepEqual(left.map((e) => e.householdId), ['house-b']);
    assert.deepEqual(readJournal(storage, 0).map((e) => e.opId), ['b']);
    clearJournal(storage);
    assert.equal(storage.values.has(UNDO_JOURNAL_KEY), false);
  });
});

describe('live membership: account switched on an open page', () => {
  const B = 'uid-b';

  test('account A -> account B in the same household: B starts from nothing and gets its own record', () => {
    const a = approved('admin');
    const switched = membershipReducer(a, watch(H, B));
    assert.deepEqual(switched, { ...initialMembershipState, uid: B, householdId: H });
    assert.equal(canWatchHousehold(switched), false, "A's household listener closes until B's record answers");
    // The household stays watched (the old bug: a reset left nothing watched, loading for ever).
    assert.equal(view(switched, H, true, B).phase, 'loading');
    // A late answer from A's listener is ignored.
    assert.equal(membershipReducer(switched, member(active('admin'))), switched);
    // B's own record, then the household document: B's role and permissions, never A's.
    const b = run([member(active('child'), { uid: B }), householdDoc({ name: 'The Foxes' })], switched);
    const shown = view(b, H, true, B);
    assert.equal(shown.phase, 'member');
    assert.equal(shown.member?.role, 'child');
    assert.equal(shown.member?.uid, B);
    assert.equal(getMemberPermissions(shown.member)['household.manageMembers'], false);
    // No "role changed" toast for a different person.
    assert.equal(membershipChangeNotice({ uid: UID, householdId: H, phase: 'member', role: 'admin' }, { uid: B, householdId: H, phase: 'member', role: 'child' }), null);
  });

  test("while the profile already belongs to B, A's membership is never shown", () => {
    assert.equal(view(approved('admin'), H, true, B).phase, 'loading');
    assert.equal(liveProfile(profile({ uid: B, role: 'member' }), view(approved('admin'), H, true, B), H)?.role, 'member');
  });

  test('account A -> account B in another household', () => {
    const switched = membershipReducer(approved(), watch('house-b', B));
    assert.deepEqual(switched, { ...initialMembershipState, uid: B, householdId: 'house-b' });
    const b = run([member(active('member'), { uid: B, householdId: 'house-b' }), householdDoc({ name: 'Otters' }, { householdId: 'house-b' })], switched);
    assert.equal(view(b, 'house-b', true, B).household?.name, 'Otters');
  });

  test("A's access-ended notice is not carried to B", () => {
    const ended = membershipReducer(approved(), member(null));
    assert.ok(ended.ended);
    assert.equal(membershipReducer(ended, watch(H, B)).ended, null);
    assert.equal(membershipReducer(ended, watch(null, B)).ended, null);
  });

  test('account A -> signed out -> account A again: the household is watched afresh', () => {
    const out = membershipReducer(approved(), watch(null, null));
    assert.deepEqual(out, initialMembershipState);
    assert.equal(view(out, null, false, null).phase, 'loading');
    const back = membershipReducer(out, watch(H, UID));
    assert.deepEqual(back, { ...initialMembershipState, uid: UID, householdId: H });
    assert.equal(view(run([member(active()), householdDoc({ name: 'The Foxes' })], back)).phase, 'member');
  });
});

describe('live membership: stale profile pointer', () => {
  const B = 'uid-b';
  const pointer = (uid: string, householdId: string | null = H) => ({ uid, householdId });

  test("A's ended membership with B's profile (same household) is never stale: B's pointer is kept", () => {
    // A's listener is denied once Auth is B, before B's profile arrives.
    const aEnded = membershipReducer(approved(), { type: 'memberError', householdId: H, failure: 'denied' });
    assert.equal(aEnded.uid, UID);
    assert.ok(aEnded.ended);
    assert.equal(stalePointerFor(aEnded, pointer(B), true), null);
    // A pending B, same household: still nothing to clear.
    assert.equal(stalePointerFor(run([member(pending())], { ...initialMembershipState, uid: UID, householdId: H }), pointer(B), true), null);
  });

  test("B's own ended membership with B's profile is stale", () => {
    const bEnded = run([watch(H, B), member(active(), { uid: B }), householdDoc({ name: 'x' }), member(null, { uid: B })]);
    assert.equal(stalePointerFor(bEnded, pointer(B), true), H);
  });

  test('a pointer without a record is stale; nothing is stale before the profile is confirmed or for another pointer', () => {
    const noRecord = run([watch(H), member(null)]);
    assert.equal(stalePointerFor(noRecord, pointer(UID), true), H);
    assert.equal(stalePointerFor(noRecord, pointer(UID), false), null);
    assert.equal(stalePointerFor(noRecord, pointer(UID, 'house-b'), true), null);
    assert.equal(stalePointerFor(noRecord, pointer(UID, null), true), null);
    assert.equal(stalePointerFor(noRecord, null, true), null);
    assert.equal(stalePointerFor(approved(), pointer(UID), true), null);
  });
});

describe('live membership: finishing a deletion after a reload', () => {
  const frozen = (extra: Record<string, unknown> = {}) => active('owner', { status: 'deleting', ...extra });

  test('restored straight into a frozen household: no name until one is recovered', () => {
    const state = run([watch(H), member(frozen())]);
    assert.equal(view(state).phase, 'deleting');
    assert.equal(view(state).household?.name, '');
    assert.equal(canWatchHousehold(state), false, 'the rules do not let a deleting member read the household');
    // The cached household document gives the name.
    const named = membershipReducer(state, { type: 'householdName', householdId: H, name: ' The Foxes ' });
    assert.equal(view(named).household?.name, 'The Foxes');
    // Blank names and other households change nothing; a known name is kept.
    assert.equal(membershipReducer(state, { type: 'householdName', householdId: H, name: '  ' }), state);
    assert.equal(membershipReducer(state, { type: 'householdName', householdId: 'house-b', name: 'Other' }), state);
    assert.equal(membershipReducer(named, { type: 'householdName', householdId: H, name: 'Else' }), named);
  });

  test("renamed after the invite: the record's invitation-time name never counts as known", () => {
    // Joined by invite as 'Old Foxes', later owner; the household was renamed 'The Foxes'.
    const state = run([watch(H), member(frozen({ householdName: 'Old Foxes' }))]);
    assert.equal(view(state).household?.name, '', 'the cached-document lookup still runs');
    // Cached document present: its current name wins over the record's.
    const cached = membershipReducer(state, { type: 'householdName', householdId: H, name: 'The Foxes' });
    assert.equal(deletionNameSuggestion(view(cached).household?.name, 'Old Foxes'), 'The Foxes');
    // Cached document absent: the record's name is only a suggestion in an editable field.
    assert.equal(deletionNameSuggestion(view(state).household?.name, 'Old Foxes'), 'Old Foxes');
    assert.equal(deletionNameField(null, 'Old Foxes'), 'Old Foxes');
    assert.equal(deletionNameField('The Foxes', 'Old Foxes'), 'The Foxes', 'what the owner types replaces it');
    assert.equal(deletionNameField('', 'Old Foxes'), '', 'and can be cleared');
    // Nothing known at all: an empty field.
    assert.equal(deletionNameSuggestion('', undefined), '');
    // A name this session saw live is preferred too.
    assert.equal(deletionNameSuggestion(' The Foxes ', 'Old Foxes'), 'The Foxes');
  });

  test('the name sent is the field; nothing is offered while it is empty; a refusal is explained and the field stays', () => {
    assert.equal(finishDeletingName(' The Foxes '), 'The Foxes');
    assert.equal(finishDeletingName('   '), null);
    assert.equal(finishDeletingName(''), null);
    // A mismatch (or no connection) answers false: a plain message under the field, which
    // keeps the owner's text (the field value is deletionNameField, unchanged by the answer).
    assert.equal(finishDeletingError(false), FINISH_DELETING_FAILED);
    assert.match(FINISH_DELETING_FAILED, /must match the household's name exactly/);
    assert.equal(finishDeletingError(true), null);
    assert.equal(deletionNameField('Old Foxes', 'Old Foxes'), 'Old Foxes');
  });
});
