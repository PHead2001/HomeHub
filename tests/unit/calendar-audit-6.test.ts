import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { weekStartKey, type ChoreRecord } from '../../src/lib/chores/dates';
import { occurrenceChoreId } from '../../functions/src/shared/ids';
import {
  awayEvents, careEvents, choreEvents, skipPlan, withoutSkippedOccurrences, choreHref, filterEvents, foldedOverdueRail, laneRows, monthGrid, monthSelection, moveQuickPicks,
  overdueRail, pantryExpiryEvents, pantryExpiryInputs, plannedRecurringEvents, projectedMaintenanceEvents, weekDays, withUniqueIds,
  type CalendarEvent,
} from '../../src/lib/chores/calendar';
import { highlightPlacement, parseHighlightChore } from '../../src/lib/chores/url-state';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { blend, contrastRatio, hslTokenToRgb } from '../../src/lib/theme/contrast';
import { PRESET_LIST } from '../../src/lib/theme/tokens';

const chore = (overrides: Partial<ChoreRecord>): ChoreRecord => ({
  id: 'c1', task: 'Empty dishwasher', assignedToUid: 'sam', dueDate: '2026-08-01', originalDueDate: '2026-08-01', isCompleted: false, ...overrides,
});
const members = [{ uid: 'sam', name: 'Sam' }, { uid: 'ada', name: 'Ada' }];
const event = (overrides: Partial<CalendarEvent>): CalendarEvent => ({
  id: 'e', kind: 'chore', title: 'T', subtitle: 'S', day: '2026-08-03', overdue: false, completed: false, href: '/chores', ...overrides,
});
describe('week and month grids (CA-16)', () => {
  it('weeks and months start on the household day', () => {
    // Sat Aug 1 2026.
    assert.equal(weekStartKey('2026-08-01'), '2026-07-27');
    assert.equal(weekStartKey('2026-08-01', 0), '2026-07-26');
    assert.equal(weekStartKey('2026-08-02', 0), '2026-08-02', 'a Sunday starts its own week');
    assert.equal(weekStartKey('2026-08-02', 1), '2026-07-27', 'and ends a Monday week');
    assert.deepEqual(weekDays('2026-08-01', 0), ['2026-07-26', '2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01']);
    const grid = monthGrid('2026-08-15', 0);
    assert.equal(grid[0][0], '2026-07-26');
    assert.ok(grid.every(week => week.length === 7));
    assert.ok(grid.flat().includes('2026-08-31'));
  });

});

describe('overdue rail folding (CA-2) and keys (CA-7)', () => {
  it('folds a daily chore missed for 9 days to one chip that says 9', () => {
    const missed = Array.from({ length: 9 }, (_, i) => chore({
      id: occurrenceChoreId('dish', 'general', `2026-07-${String(20 + i).padStart(2, '0')}`), templateId: 'dish',
      originalDueDate: `2026-07-${String(20 + i).padStart(2, '0')}`,
    }));
    const oneOff = chore({ id: 'once', task: 'Call plumber', templateId: undefined, originalDueDate: '2026-07-25' });
    const all = [...missed, oneOff];
    const events = choreEvents(all, members, '2026-08-01');
    assert.equal(overdueRail(events).length, 10);
    const rail = foldedOverdueRail(events, all, [{ id: 'dish', recurrence: { frequency: 'daily' } }], members, '2026-08-01');
    assert.equal(rail.length, 2);
    const folded = rail.find(e => e.title === 'Empty dishwasher')!;
    assert.equal(folded.foldedCount, 9);
    assert.equal(folded.day, '2026-07-28', 'the latest missed day stands for the rest');
    assert.equal(rail.find(e => e.title === 'Call plumber')!.foldedCount, undefined);
    // A template that no longer repeats does not fold.
    assert.equal(foldedOverdueRail(events, all, [{ id: 'dish', recurrence: null }], members, '2026-08-01').length, 10);
  });

  it('gives duplicate ids a suffix so React keys never collide', () => {
    const ids = withUniqueIds([event({ id: 'a' }), event({ id: 'b' }), event({ id: 'a' }), event({ id: 'a' })]).map(e => e.id);
    assert.deepEqual(ids, ['a', 'b', 'a#2', 'a#3']);
  });
});

describe('deep links and planned repeats (CA-15, CA-17)', () => {
  it('chores link to their room with the chore highlighted', () => {
    assert.equal(choreHref('c 1', 'kitchen'), '/chores?room=kitchen&chore=c%201');
    const [ev] = choreEvents([chore({ id: 'k1', roomIds: ['kitchen'] })], members, '2026-08-01');
    assert.equal(ev.href, '/chores?room=kitchen&chore=k1');
    assert.equal(ev.roomId, 'kitchen');
    const [general] = choreEvents([chore({ id: 'g1', roomIds: [] })], members, '2026-08-01');
    assert.equal(general.href, '/chores?room=general&chore=g1');
  });

  it('planned events carry what the server needs to create them', () => {
    const [planned] = plannedRecurringEvents([{ id: 'trash', task: 'Trash', assignedToUid: 'sam', roomIds: ['garage'], recurrence: { frequency: 'daily' } }], [], members, '2026-08-01', '2026-08-05', '2026-08-05');
    assert.equal(planned.templateId, 'trash');
    assert.equal(planned.roomId, 'garage');
    assert.equal(planned.occurrenceKey, 'trash|garage|2026-08-05');
    assert.equal(planned.occurrenceDay, '2026-08-05');
    assert.equal(planned.planned, true);
  });
});

describe('filters, lanes and quick picks (CA-11, CA-21, CA-24)', () => {
  const events = [
    event({ id: 'a', memberUid: 'sam' }),
    event({ id: 'b', memberUid: 'ada' }),
    event({ id: 'c' }),
    event({ id: 'm', kind: 'maintenance' }),
    event({ id: 'p', kind: 'pantry', day: '2026-08-04' }),
    event({ id: 'x', memberUid: 'sam', day: '2026-09-01' }),
  ];

  it('filters by kind and to one person, keeping house items', () => {
    const all = new Set(['chore', 'maintenance', 'medication', 'care', 'pantry'] as const);
    assert.deepEqual(filterEvents(events, { kinds: all, memberUid: 'sam' }).map(e => e.id), ['a', 'm', 'p', 'x']);
    assert.deepEqual(filterEvents(events, { kinds: new Set(['maintenance'] as const), memberUid: null }).map(e => e.id), ['m']);
  });

  it('puts each member on their own lane and the rest in House', () => {
    const days = ['2026-08-03', '2026-08-04'];
    const lanes = laneRows(events, members, days);
    assert.deepEqual(lanes.map(l => l.label), ['Sam', 'Ada', 'House']);
    assert.deepEqual(lanes[0].byDay.get('2026-08-03')!.map(e => e.id), ['a']);
    assert.deepEqual(lanes[2].byDay.get('2026-08-03')!.map(e => e.id).sort(), ['c', 'm']);
    assert.deepEqual(lanes[2].byDay.get('2026-08-04')!.map(e => e.id), ['p']);
    assert.equal([...lanes[0].byDay.values()].flat().some(e => e.id === 'x'), false, 'outside the week');
  });

  it('offers Today, Tomorrow and the next weekdays, never the current day', () => {
    // Sat Aug 1 2026.
    const picks = moveQuickPicks('2026-08-01', '2026-08-02');
    assert.deepEqual(picks.map(p => p.label), ['Today', 'Mon 3', 'Tue 4', 'Wed 5', 'Thu 6', 'Fri 7']);
    assert.equal(picks[0].day, '2026-08-01');
    assert.deepEqual(moveQuickPicks('2026-08-01', '2026-08-01').map(p => p.label).slice(0, 2), ['Tomorrow', 'Mon 3']);
  });

  it('selects today when moving to the current month, else the 1st (CA-18)', () => {
    assert.equal(monthSelection('2026-08-01', '2026-08-17'), '2026-08-17');
    assert.equal(monthSelection('2026-09-01', '2026-08-17'), '2026-09-01');
  });
});

describe('everything with a date (CA-23)', () => {
  it('pantry expiry dates, in stock only, never overdue', () => {
    const events = pantryExpiryEvents([
      { id: 'milk', name: 'Milk', expiryDate: '2026-08-03', packages: 1 },
      { id: 'old', name: 'Yogurt', expiryDate: '2026-07-30' },
      { id: 'gone', name: 'Eggs', expiryDate: '2026-08-05', packages: 0 },
      { id: 'none', name: 'Rice', expiryDate: null },
    ], '2026-08-01');
    assert.deepEqual(events.map(e => e.title), ['Milk expires', 'Yogurt expired']);
    assert.ok(events.every(e => e.kind === 'pantry' && !e.overdue && e.href === '/shopping?tab=pantry'));
  });

  it('logged pet care on the household day', () => {
    const [care] = careEvents([{ id: 'g', petId: 'maple', petName: 'Maple', activity: 'Grooming', date: '2026-08-02T03:00:00.000Z' }], 'America/Chicago');
    assert.equal(care.day, '2026-08-01', '10 pm in Chicago is still Aug 1');
    assert.equal(care.completed, true);
    assert.equal(care.href, '/pets/maple?tab=care');
  });

  it('projects maintenance repeats after the next due day, dashed, inside the range', () => {
    const events = projectedMaintenanceEvents(
      [{ id: 'hvac', name: 'HVAC', schedules: [{ id: 's1', scheduleName: 'Filter', frequencyType: 'months', intervalValue: 1, nextDueDate: '2026-08-10' }, { id: 'c', mode: 'checklist', frequencyType: 'days', intervalValue: 1, nextDueDate: '2026-08-10' }] },
        { id: 'old', name: 'Old', status: 'retired', schedules: [{ frequencyType: 'days', intervalValue: 1, nextDueDate: '2026-08-10' }] }],
      [{ id: 'car', nickname: 'Car', serviceSchedules: [{ id: 'oil', serviceName: 'Oil change', intervalMonths: 3, nextDueDate: '2026-08-15' }] }],
      'America/Chicago', '2026-08-01', '2026-12-31',
    );
    assert.deepEqual(events.filter(e => e.subtitle === 'HVAC').map(e => e.day), ['2026-09-10', '2026-10-10', '2026-11-10', '2026-12-10']);
    assert.deepEqual(events.filter(e => e.subtitle === 'Car').map(e => e.day), ['2026-11-15']);
    assert.ok(events.every(e => e.planned && e.kind === 'maintenance' && !e.overdue));
  });
});

describe('calendar chips (CA-19)', () => {
  it('every status chip colour (text on its 10% tint over a card) meets WCAG AA in all presets', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/chores/calendar/event-chip.tsx'), 'utf8');
    const body = source.slice(source.indexOf('export function chipClasses'), source.indexOf('export function chipName'));
    const tokens = [...new Set([...body.matchAll(/bg-([a-z]+)\/10 text-\1/g)].map(match => match[1]))].sort();
    assert.deepEqual(tokens, ['destructive', 'info', 'primary', 'success', 'warning']);
    for (const preset of PRESET_LIST) {
      for (const token of tokens) {
        const color = hslTokenToRgb((preset.colors as Record<string, string>)[token]);
        const ratio = contrastRatio(color, blend(color, hslTokenToRgb(preset.colors.card), 0.1));
        assert.ok(ratio >= 4.5, `${preset.id} ${token}: ${ratio.toFixed(2)}:1`);
      }
    }
  });

  it('names planned items, dates in the rail, and folded repeats', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/chores/calendar/event-chip.tsx'), 'utf8');
    assert.match(source, /parts\.push\('planned'\)/);
    assert.match(source, /if \(withDate\) parts\.push/);
    assert.match(source, /missed \$\{event\.foldedCount\} times/);
    const page = readFileSync(resolve(process.cwd(), 'src/components/chores/calendar/household-calendar.tsx'), 'utf8');
    // Week days are headings and the month is a grid with one tab stop (roving tabindex).
    assert.match(page, /<h3 className=/);
    assert.match(page, /role="grid"/);
    assert.match(page, /tabIndex=\{day === tabStop \? 0 : -1\}/);
    // Completion and moves go through the shared server actions (CA-8, CA-15).
    assert.match(page, /completeChoresOnServer\(householdId, \[chore\.id\]/);
    assert.match(page, /movePlannedChore\(/);
    // A cancelled drag is reset and only the dragged chore is ever dropped (CA-4).
    assert.match(page, /onDragEnd/);
    assert.match(page, /getData\('text\/plain'\) === event\.id/);
  });
});

describe('skipping days (CA-27) and the Chores highlight (CA-17)', () => {
  const generated = (day: string, extra: Partial<CalendarEvent> = {}) => event({ id: `chore:${day}`, choreId: `trash-${day}`, day, templateId: 'trash', occurrenceKey: `trash|general|${day}`, occurrenceDay: day, ...extra });

  it('plans template keys for today or later and deletes only open generated chores', () => {
    const plan = skipPlan([
      generated('2026-08-03'),
      generated('2026-08-04', { planned: true, choreId: undefined }),
      generated('2026-07-30'),
      generated('2026-08-05', { completed: true }),
      event({ id: 'once', choreId: 'once', day: '2026-08-03' }),
    ], '2026-08-01');
    assert.deepEqual([...plan.keys.entries()], [['trash', ['trash|general|2026-08-03', 'trash|general|2026-08-04']]]);
    // What the server re-checks: each key, and the chore only for a day already on the chart.
    assert.deepEqual(plan.items, [
      { templateId: 'trash', key: 'trash|general|2026-08-03', choreId: 'trash-2026-08-03' },
      { templateId: 'trash', key: 'trash|general|2026-08-04' },
    ]);
  });

  it('away picks every open repeating chore in the range; Undo removes exactly those keys', () => {
    const list = awayEvents([generated('2026-08-02'), generated('2026-08-06'), generated('2026-08-09'), event({ id: 'once', day: '2026-08-06' })], '2026-08-02', '2026-08-06');
    assert.deepEqual(list.map(e => e.day), ['2026-08-02', '2026-08-06']);
    assert.deepEqual(withoutSkippedOccurrences(['a|g|2026-08-02', 'b|g|2026-08-03', 7], ['a|g|2026-08-02']), ['b|g|2026-08-03']);
    assert.deepEqual(withoutSkippedOccurrences(undefined, ['x']), []);
  });

  it('reads ?chore= for the highlight, ignoring junk', () => {
    assert.equal(parseHighlightChore(new URLSearchParams('room=kitchen&chore=abc')), 'abc');
    assert.equal(parseHighlightChore(new URLSearchParams('chore=')), null);
    assert.equal(parseHighlightChore(new URLSearchParams('chore=a/b')), null);
    assert.equal(parseHighlightChore(null), null);
  });
});

describe('review fixes (Codex, PR #234)', () => {
  it('reads legacy pantry expiries (ISO timestamps, quantities) through the pantry reader, on the household day', () => {
    const inputs = pantryExpiryInputs([
      { id: 'milk', data: { name: 'Milk', packages: 1, expiryDate: '2026-08-04T03:00:00.000Z' } },
      { id: 'flour', data: { name: 'Flour', unit: 'items', quantity: 2, expiryDate: '2026-08-10' } },
      { id: 'gone', data: { name: 'Eggs', packages: 0, expiryDate: '2026-08-05' } },
    ], 'America/Chicago');
    const events = pantryExpiryEvents(inputs, '2026-08-01');
    assert.deepEqual(events.map(e => [e.title, e.day]), [['Milk expires', '2026-08-03'], ['Flour expires', '2026-08-10']]);
  });

  it('projects a snoozed calendar schedule from its real cycle, then without the snooze', () => {
    const events = projectedMaintenanceEvents([{ id: 'hvac', name: 'HVAC', schedules: [{
      id: 's1', scheduleName: 'Filter', frequencyType: 'months', intervalValue: 1, anchor: 'calendar',
      nextDueDate: '2026-08-17', snoozedUntil: '2026-08-17', snoozedFrom: '2026-08-10',
    }] }], [], 'America/Chicago', '2026-08-01', '2026-10-31');
    assert.deepEqual(events.map(e => e.day), ['2026-09-10', '2026-10-10']);
  });

  it('places a ?chore= target in its section and says when its range must widen', () => {
    const window = { today: '2026-08-01', weekAhead: '2026-08-08', recentFrom: '2026-07-29' };
    assert.deepEqual(highlightPlacement({ due: '2026-07-30', completedDay: null }, window), { section: 'todo', widen: false });
    assert.deepEqual(highlightPlacement({ due: '2026-08-05', completedDay: null }, window), { section: 'future', widen: false });
    assert.deepEqual(highlightPlacement({ due: '2026-08-20', completedDay: null }, window), { section: 'future', widen: true });
    assert.deepEqual(highlightPlacement({ isCompleted: true, due: '2026-07-30', completedDay: '2026-07-31' }, window), { section: 'completed', widen: false });
    assert.deepEqual(highlightPlacement({ isCompleted: true, due: '2026-07-10', completedDay: '2026-07-11' }, window), { section: 'completed', widen: true });
  });

  it('the chores page reveals its target: controlled sections, widened ranges, rechecked until the row renders', () => {
    const page = readFileSync(resolve(process.cwd(), 'src/components/chore-chart-client.tsx'), 'utf8');
    assert.match(page, /value=\{sectionsOpen\} onValueChange=\{setOpenSections\}/);
    // Derived while revealing (no setState during the effect), committed once the row is found.
    assert.match(page, /const fullFuture = showFullFuture \|\| Boolean\(pendingReveal\?\.widen/);
    assert.match(page, /setShowFullFuture\(true\)/);
    assert.match(page, /setShowFullHistory\(true\)/);
    assert.match(page, /if \(\+\+tries < 40\) timer = window\.setTimeout\(look, 100\)/);
  });

  it('skips and planned-move Undo go through the server, bound to the operation', () => {
    const calendar = readFileSync(resolve(process.cwd(), 'src/components/chores/calendar/household-calendar.tsx'), 'utf8');
    assert.match(calendar, /skipChoreDaysAction\(/);
    assert.match(calendar, /undoPlannedChoreMove\(\{ idToken: await again\.getIdToken\(\), householdId, opId: result\.data\.opId \}\)/);
    assert.doesNotMatch(calendar, /skip-client/);
  });
});

describe('view switch names (CI: chores-ux day agenda)', () => {
  it('no other toggle on the page has a name containing Day, Week or Month', () => {
    const page = readFileSync(resolve(process.cwd(), 'src/components/chores/calendar/household-calendar.tsx'), 'utf8');
    const labels = [...page.matchAll(/<ToggleGroupItem value="([a-z]+)"[^>]*>(?:<[^>]+\/>)?([^<]+)<\/ToggleGroupItem>/g)].map(m => ({ value: m[1], label: m[2].trim() }));
    assert.deepEqual(labels.map(l => l.label), ['Day', 'Week', 'Month', 'By date', 'By person']);
    for (const { value, label } of labels) {
      if (['day', 'week', 'month'].includes(value)) continue;
      assert.doesNotMatch(label, /day|week|month/i, `"${label}" would also match the view switch`);
    }
  });
});
