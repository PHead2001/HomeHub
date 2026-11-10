import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { computeChoreFacts, computePetFacts, memberName, type ChoreEntry } from '../../src/lib/dashboard/facts';
import { householdSummary, summaryPhrase } from '../../src/lib/dashboard/household-summary';
import { houseCleanReady } from '../../src/lib/dashboard/celebration';
import { buildMorningBrief } from '../../src/lib/dashboard/brief';
import { choresFilteredHref } from '../../src/lib/dashboard/links';
import { applyAnswer, emptyStore, sectionStates } from '../../src/lib/dashboard/dashboard-store';
import { choresFiltersHref, parseChoresFilters } from '../../src/lib/chores/url-state';
import { houseCleanShown, houseCleanStorageKey, markHouseCleanShown } from '../../src/lib/chores/house-clean';

// Local noon on 2026-08-01 (the E2E seed's day in any time zone).
const now = new Date(2026, 7, 1, 12, 0, 0);
const viewer = { uid: 'alex-uid', email: 'alex@example.test' };
const rooms = [{ id: 'kitchen', name: 'Kitchen', icon: 'CookingPot' }, { id: 'garage', name: 'Garage' }];
const members = [
  { id: 'alex-uid', uid: 'alex-uid', email: 'alex@example.test', displayName: 'Alex Owner', role: 'owner' },
  { id: 'sam-uid', uid: 'sam-uid', email: 'sam@example.test', displayName: 'Sam', role: 'member' },
  { id: 'pat-uid', uid: 'pat-uid', email: 'pat@example.test', displayName: 'pat@example.test', role: 'member' },
  { id: 'new-uid', uid: 'new-uid', email: 'new@example.test', displayName: 'Newbie', role: 'newuser' },
];
const chore = (id: string, data: Record<string, unknown>) => ({ id, task: id, isCompleted: false, roomIds: ['kitchen'], ...data });

describe('HP-32a: chore entries carry names, never emails', () => {
  const chores = [
    chore('dishes', { originalDueDate: '2026-07-30', assignedToEmail: 'sam@example.test', assignedToDisplayName: 'Samuel' }),
    chore('trash', { originalDueDate: '2026-08-01', assignedToEmail: 'alex@example.test' }),
    // A uid assignee without an email (member privacy release A) resolves by uid.
    chore('mop', { originalDueDate: '2026-08-01', assignedToEmail: '', assignedToUid: 'sam-uid', roomIds: [] }),
    // A member whose display name is an email: never shown.
    chore('sweep', { originalDueDate: '2026-08-01', assignedToEmail: 'pat@example.test', assignedToDisplayName: 'pat@example.test' }),
    chore('unassigned', { originalDueDate: '2026-08-01', assignedToEmail: '' }),
    chore('later', { originalDueDate: '2026-08-04', assignedToEmail: 'sam@example.test' }),
  ];
  const facts = computeChoreFacts(chores, rooms, viewer, now, new Set(), null, members);
  const byId = new Map(facts.todayWork!.map((entry) => [entry.id, entry]));

  it('lists every open chore overdue or due today, most overdue first', () => {
    assert.deepEqual(facts.todayWork!.map((entry) => entry.id), ['dishes', 'trash', 'mop', 'sweep', 'unassigned']);
    assert.equal(facts.todayWorkTotal, 5);
    assert.equal(byId.get('dishes')!.due, 'overdue');
    assert.equal(byId.get('trash')!.due, 'today');
  });

  it('names the assignee from the member record (uid or email), else the stored name', () => {
    assert.equal(byId.get('dishes')!.assignee, 'Sam', 'the member record wins over the stored name');
    assert.equal(byId.get('mop')!.assignee, 'Sam', 'uid assignee');
    assert.equal(byId.get('mop')!.room, 'Around the house');
    assert.equal(byId.get('trash')!.mine, true);
    assert.equal(byId.get('sweep')!.assignee, null, 'an email is never a name');
    assert.equal(byId.get('unassigned')!.assigneeKey, '');
    assert.equal(facts.nextUp[0].assignee, 'Sam', 'next up carries the assignee too');
    for (const entry of [...facts.todayWork!, ...facts.nextUp]) assert.doesNotMatch(String(entry.assignee ?? ''), /@/);
  });

  it('keeps the room icon for the celebration', () => {
    assert.equal(facts.rooms.find((room) => room.id === 'kitchen')!.icon, 'CookingPot');
  });

  it('memberName drops emails and blanks', () => {
    assert.equal(memberName('  Sam  Member '), 'Sam Member');
    assert.equal(memberName('sam@example.test'), null);
    assert.equal(memberName(''), null);
    assert.equal(memberName(undefined), null);
  });

  it('counts folded missed instances of a repeating chore and names them on the row', () => {
    const series = [
      chore('reset-0729', { templateId: 'reset', originalDueDate: '2026-07-29', assignedToEmail: 'sam@example.test' }),
      chore('reset-0730', { templateId: 'reset', originalDueDate: '2026-07-30', assignedToEmail: 'sam@example.test' }),
      chore('reset-0801', { templateId: 'reset', originalDueDate: '2026-08-01', assignedToEmail: 'sam@example.test' }),
    ];
    const folded = computeChoreFacts(series, rooms, viewer, now, new Set(['reset']), null, members);
    assert.equal(folded.missed, 2);
    assert.deepEqual(folded.todayWork!.map((entry) => [entry.id, entry.missed]), [['reset-0801', 2]]);
  });
});

const entry = (id: string, data: Partial<ChoreEntry>): ChoreEntry => ({ id, task: id, dueLabel: 'due today', overdue: false, mine: false, due: 'today', ...data });

describe('HP-32a: householdSummary', () => {
  it('reads "Sam: Dishes (overdue) · Alex: Trash (today)" with overdue people first', () => {
    const summary = householdSummary([
      entry('Trash', { assignee: 'Alex', assigneeKey: 'alex' }),
      entry('Dishes', { assignee: 'Sam', assigneeKey: 'sam', overdue: true, due: 'overdue' }),
    ]);
    assert.equal(summary.text, 'Sam: Dishes (overdue) · Alex: Trash (today)');
  });

  it('never hides overdue or missed work behind the first chore', () => {
    const summary = householdSummary([
      entry('Dishes', { assignee: 'Sam', assigneeKey: 'sam', overdue: true, due: 'overdue' }),
      entry('Vacuum', { assignee: 'Sam', assigneeKey: 'sam', overdue: true, due: 'overdue', missed: 2 }),
      entry('Laundry', { assignee: 'Sam', assigneeKey: 'sam' }),
    ]);
    assert.equal(summary.text, 'Sam: Dishes (overdue) and 2 more (1 overdue), 2 earlier missed');
  });

  it('leads with an overdue chore even when it comes after a today one', () => {
    const summary = householdSummary([
      entry('Laundry', { assignee: 'Sam', assigneeKey: 'sam' }),
      entry('Dishes', { assignee: 'Sam', assigneeKey: 'sam', overdue: true, due: 'overdue' }),
    ]);
    assert.equal(summaryPhrase(summary.parts[0]), 'Sam: Dishes (overdue) and 1 more');
  });

  it('says You for the reader, Unassigned last and Someone for a name it cannot show', () => {
    const summary = householdSummary([
      entry('Mop', { assigneeKey: '' }),
      entry('Sweep', { assigneeKey: 'pat', assignee: null }),
      entry('Trash', { mine: true, assigneeKey: 'alex', assignee: 'Alex' }),
    ]);
    assert.deepEqual(summary.parts.map((part) => part.name), ['You', 'Someone', 'Unassigned']);
    assert.doesNotMatch(summary.text, /@/);
  });

  it('ignores later chores', () => {
    assert.equal(householdSummary([entry('Later', { due: 'later', assigneeKey: 'sam', assignee: 'Sam' })]).text, '');
  });
});

describe('HP-33a: the pet feed request comes from the loaded history', () => {
  it('uses the usual portion and the latest food type, with the duplicate check fallback', () => {
    const pets = [{ id: 'maple', name: 'Maple', type: 'Dog', foodSchedule: '1.5 cups twice daily' }];
    const logs = [
      { id: 'a', date: new Date(2026, 7, 1, 7, 0), foodType: 'Wet', loggedByUid: 'sam-uid', loggedByName: 'Sam' },
      { id: 'b', date: new Date(2026, 6, 31, 18, 0), foodType: 'Dry' },
    ];
    const facts = computePetFacts(pets, { maple: logs }, now);
    const feed = facts.pets[0].feed!;
    assert.equal(facts.pets[0].fed, false);
    assert.deepEqual([feed.amount, feed.unit, feed.perDay, feed.foodType], [1.5, 'Cups', 2, 'Wet']);
    assert.equal(feed.known.countToday, 1);
    assert.equal(feed.known.lastFedByName, 'Sam');
  });

  it('has no request when the history could not be read, and Dry without history', () => {
    const pets = [{ id: 'pixel', name: 'Pixel', type: 'Cat' }];
    assert.equal(computePetFacts(pets, { pixel: null }, now).pets[0].feed, undefined);
    assert.equal(computePetFacts(pets, { pixel: [] }, now).pets[0].feed!.foodType, 'Dry');
  });
});

describe('HP-34: houseCleanReady', () => {
  const live = { status: 'ready' as const, updatedAt: 1 };
  const allDone = { todayTotal: 3, todayDone: 3, overdueTotal: 0, missed: 0 };

  it('celebrates only on live data with all of today done', () => {
    assert.equal(houseCleanReady(live, allDone), true);
  });

  it('never on cached, stale, failed or loading data', () => {
    assert.equal(houseCleanReady({ ...live, cached: true }, allDone), false);
    assert.equal(houseCleanReady({ status: 'stale', reason: 'offline', updatedAt: 1 }, allDone), false);
    assert.equal(houseCleanReady({ status: 'failed', updatedAt: null }, allDone), false);
    assert.equal(houseCleanReady({ status: 'loading', updatedAt: null }, allDone), false);
    assert.equal(houseCleanReady(undefined, allDone), false);
    assert.equal(houseCleanReady(live, undefined), false);
  });

  it('never for an empty day, unfinished work, overdue work or folded missed instances', () => {
    assert.equal(houseCleanReady(live, { ...allDone, todayTotal: 0, todayDone: 0 }), false);
    assert.equal(houseCleanReady(live, { ...allDone, todayDone: 2 }), false);
    assert.equal(houseCleanReady(live, { ...allDone, overdueTotal: 1 }), false);
    assert.equal(houseCleanReady(live, { ...allDone, missed: 1 }), false);
    assert.equal(houseCleanReady(live, { ...allDone, missed: undefined }), false, 'a saved snapshot without the count');
  });

  it('a section is cached while any listener last answered from the device cache', () => {
    const expected = { chores: ['a', 'b'] };
    let store = applyAnswer(emptyStore('c'), 'c', 'a', 'chores', (raw) => raw, { fromCache: false, at: 1 });
    store = applyAnswer(store, 'c', 'b', 'chores', (raw) => raw, { fromCache: true, at: 2 });
    assert.equal(sectionStates(store, expected, false).chores.status, 'ready');
    assert.equal(sectionStates(store, expected, false).chores.cached, true);
    store = applyAnswer(store, 'c', 'b', 'chores', (raw) => raw, { fromCache: false, at: 3 });
    assert.equal(sectionStates(store, expected, false).chores.cached, undefined);
  });

  it('shows once per household per day, shared with the Chores page, even with storage blocked', () => {
    const saved = new Map<string, string>();
    const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
    const key = houseCleanStorageKey('house-1', '2026-08-01');
    assert.equal(houseCleanShown(key, storage), false);
    markHouseCleanShown(key, storage);
    assert.equal(saved.get(key), '1');
    assert.equal(houseCleanShown(houseCleanStorageKey('house-1', '2026-08-02'), storage), false);
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const other = houseCleanStorageKey('house-2', '2026-08-01');
    markHouseCleanShown(other, blocked);
    assert.equal(houseCleanShown(other, blocked), true, 'the in-memory flag holds');
  });
});

describe('HP-25 + GOAL-filters: Chores filters in the URL', () => {
  const params = (search: string) => new URLSearchParams(search);

  it('parses ?due=overdue and ?who=me, ignoring anything else', () => {
    assert.deepEqual(parseChoresFilters(params('due=overdue&who=me&room=kitchen')), { room: 'kitchen', due: 'overdue', who: 'me' });
    assert.deepEqual(parseChoresFilters(params('due=soon&who=sam')), { room: 'all', due: 'all', who: 'all' });
    assert.deepEqual(parseChoresFilters(null), { room: 'all', due: 'all', who: 'all' });
  });

  it('writes filters in a stable order and keeps the others', () => {
    assert.equal(choresFiltersHref('/chores', params('who=me'), { due: 'overdue' }), '/chores?due=overdue&who=me');
    assert.equal(choresFiltersHref('/chores', params('due=overdue&who=me'), { room: 'kitchen' }), '/chores?room=kitchen&due=overdue&who=me');
    assert.equal(choresFiltersHref('/chores', params('room=kitchen&due=overdue&x=1'), { due: 'all' }), '/chores?room=kitchen&x=1');
    assert.equal(choresFiltersHref('/chores', params('room=kitchen'), { room: 'all' }), '/chores');
  });

  it('the dashboard links match what the page writes', () => {
    assert.equal(choresFilteredHref({ overdue: true }), '/chores?due=overdue');
    assert.equal(choresFilteredHref({ overdue: true, mine: true }), '/chores?due=overdue&who=me');
    assert.equal(choresFilteredHref({ mine: true }), '/chores?who=me');
  });

  it('the brief links the household overdue count to /chores?due=overdue', () => {
    const facts = { chores: { mineOpen: 0, mineOverdue: 0, mineDueToday: 0, todayTotal: 2, todayDone: 0, overdueTotal: 1, rooms: [], nextUp: [], mineNext: [] } };
    const brief = buildMorningBrief(facts, { greeting: 'Hi' });
    assert.equal(brief.text, 'Hi. 2 household chores today (1 overdue).');
    assert.deepEqual(brief.segments.filter((segment) => segment.href).map((segment) => [segment.text, segment.href]), [
      ['2 household chores today', '/chores'],
      ['1 overdue', '/chores?due=overdue'],
    ]);
    const onlyOverdue = buildMorningBrief({ chores: { ...facts.chores, todayTotal: 0 } }, { greeting: 'Hi' });
    assert.equal(onlyOverdue.segments.find((segment) => segment.href)!.href, '/chores?due=overdue');
  });
});

describe('HP-33: one-tap actions use the shared operations', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/components/dashboard/one-tap.tsx'), 'utf8');

  it('Done goes through the server completion client with the 10 s Undo', () => {
    assert.match(source, /from '@\/lib\/chores\/complete-client'/);
    assert.match(source, /completeChoresOnServer\(/);
    assert.match(source, /undoCompletionOnServer\(/);
    assert.match(source, /group: 'chore-complete'/);
    assert.match(source, /duration: CHORE_UNDO_MS/);
    assert.doesNotMatch(source, /firebase\/firestore/, 'no direct chore writes');
  });

  it('Fed goes through the shared feed action (Feed again?, Undo)', () => {
    assert.match(source, /useFeedAction\(/);
    assert.match(source, /<FeedAgainDialog/);
    assert.doesNotMatch(source, /feedPet\(|addDoc\(/, 'no second feeding writer');
  });

  it('controls meet the touch target and sit outside the tile links', () => {
    assert.match(source, /styles\.target/);
    const grid = readFileSync(resolve(process.cwd(), 'src/components/dashboard/bento-grid.tsx'), 'utf8');
    assert.match(grid, /data-testid=\{`\$\{testId\}-link`\}/);
  });
});
