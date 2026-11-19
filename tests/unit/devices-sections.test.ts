import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  PREVIEW_LIMITS,
  SECTION_LIMITS,
  computeChoreFacts,
  computeMaintenanceFacts,
  computePetFacts,
  computeShoppingFacts,
  type DashboardFacts,
} from '../../src/lib/dashboard/facts';
import {
  calendarSection,
  choresSection,
  maintenanceSection,
  petsSection,
  quickAddTargets,
  shoppingListsSection,
} from '../../src/lib/devices/tablet-sections';
import { neededListItems } from '../../src/lib/devices/tablet-shopping';
import { defaultSections } from '../../src/lib/devices/settings';

// A wall tablet's section views never render from a dashboard preview (PR #178 review
// round 2, docs/modules/devices/README.md "Tablet shell"). Every section selector is fed
// more entries than any preview cap; all of them must reach the view model. The previews
// themselves keep their caps.

const zone = 'America/Chicago';
const now = new Date('2026-08-01T17:00:00Z'); // noon in Chicago
const today = '2026-08-01';
const N = 40;
const maxPreview = Math.max(...Object.values(PREVIEW_LIMITS).filter(Number.isFinite));
assert.ok(N > maxPreview, 'the fixtures exceed every preview cap');

const viewer = { uid: '', email: '' };
const rooms = [{ id: 'kitchen', name: 'Kitchen' }];
const choreDocs = [
  ...Array.from({ length: N }, (_, i) => ({ id: `t${i}`, task: `Today ${i}`, dueDate: today, originalDueDate: today, isCompleted: false, roomIds: ['kitchen'] })),
  ...Array.from({ length: N }, (_, i) => ({ id: `w${i}`, task: `Week ${i}`, dueDate: '2026-08-04', originalDueDate: '2026-08-04', isCompleted: false, roomIds: ['kitchen'] })),
];
const maintenanceAssets = [{
  id: 'house', name: 'House', status: 'active',
  schedules: Array.from({ length: N }, (_, i) => ({ scheduleName: `Task ${i}`, nextDueDate: '2026-07-20' })),
}];
const lists = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
const listItems = (prefix: string) => Array.from({ length: N }, (_, i) => ({ id: `${prefix}${i}`, name: `${prefix} ${i}`, status: 'needed', createdAt: `2026-08-01T10:00:${String(i % 60).padStart(2, '0')}.000Z` }));
const pets = Array.from({ length: N }, (_, i) => ({ id: `p${i}`, name: `Pet ${i}`, type: 'Dog', foodSchedule: 'twice daily' }));

const factsWith = (limits: typeof SECTION_LIMITS): DashboardFacts => ({
  chores: computeChoreFacts(choreDocs, rooms, viewer, now, new Set(), zone, [], limits),
  maintenance: computeMaintenanceFacts(maintenanceAssets, [], now, zone, limits),
  shopping: computeShoppingFacts(lists, { a: listItems('a'), b: listItems('b') }, limits),
  pets: computePetFacts(pets, Object.fromEntries(pets.map((pet) => [pet.id, []])), now, zone),
});

const section = factsWith(SECTION_LIMITS);
const preview = factsWith(PREVIEW_LIMITS);

const CASES: Array<{ name: string; expected: number; actual: () => number }> = [
  { name: "Chores: today's work", expected: N, actual: () => { const s = choresSection(section); return s?.kind === 'today' ? s.work.length : -1; } },
  { name: "Chores: one room's chores within the week", expected: 2 * N, actual: () => { const s = choresSection(section, 'kitchen'); return s?.kind === 'room' ? s.room.chores.length : -1; } },
  { name: 'Calendar: chores of the week', expected: 2 * N, actual: () => calendarSection(section, defaultSections()).chores.length },
  { name: 'Calendar: dated maintenance', expected: N, actual: () => calendarSection(section, defaultSections()).maintenance.length },
  { name: 'Maintenance items', expected: N, actual: () => maintenanceSection(section)?.length ?? -1 },
  { name: 'Shopping lists', expected: lists.length, actual: () => shoppingListsSection(section)?.length ?? -1 },
  { name: "Shopping: one list's needed items (its own live items)", expected: N, actual: () => neededListItems(listItems('b')).length },
  { name: 'Pets', expected: N, actual: () => petsSection(section)?.length ?? -1 },
  { name: 'Quick add: pets', expected: N, actual: () => quickAddTargets(section).pets.length },
  { name: 'Quick add: chores of today and the week', expected: 2 * N, actual: () => quickAddTargets(section).chores.length },
];

describe('every tablet section selector shows all entries, past every preview cap', () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      assert.equal(testCase.actual(), testCase.expected);
    });
  }
});

describe("room entries and today's entries carry the same action inputs (round 2 C)", () => {
  const ACTION_INPUTS = ['id', 'task', 'assigneeKey'] as const;
  const inputsOf = (entry: Record<string, unknown>) => Object.fromEntries(ACTION_INPUTS.map((key) => [key, entry[key]]));

  it("every room entry exposes id, task and the assignment identity, equal to the same chore in today's work", () => {
    const assigned = { ...choreDocs[0], id: 'mine', assignedToUid: 'sam', assignedToDisplayName: 'Sam' };
    const facts = computeChoreFacts([...choreDocs, assigned], rooms, viewer, now, new Set(), zone, [{ id: 'sam', uid: 'sam', displayName: 'Sam', role: 'member', status: 'active' }], SECTION_LIMITS);
    const roomSection = choresSection({ chores: facts }, 'kitchen');
    const todaySection = choresSection({ chores: facts });
    assert.ok(roomSection?.kind === 'room' && todaySection?.kind === 'today');
    if (roomSection?.kind !== 'room' || todaySection?.kind !== 'today') return;
    const today = new Map(todaySection.work.map((entry) => [entry.id, entry]));
    for (const entry of roomSection.room.chores) {
      for (const key of ACTION_INPUTS) assert.ok(key in entry, `${entry.id} has ${key}`);
      const same = today.get(entry.id);
      if (same) assert.deepEqual(inputsOf(entry), inputsOf(same as unknown as Record<string, unknown>));
    }
    const unassigned = roomSection.room.chores.find((entry) => entry.id === 't0');
    assert.equal(unassigned?.assigneeKey, '', 'an unassigned chore can be taken from its room');
    assert.equal(roomSection.room.chores.find((entry) => entry.id === 'mine')?.assigneeKey, 'sam');
  });
});

describe('the dashboard previews keep their caps', () => {
  it('previews stay short and hold no section-only list', () => {
    assert.equal(preview.chores?.todayWork?.length, PREVIEW_LIMITS.todayWork);
    assert.equal(preview.chores?.todayWorkTotal, N, 'the preview still counts all of them');
    assert.equal(preview.chores?.rooms.find((r) => r.id === 'kitchen')?.chores.length, PREVIEW_LIMITS.roomChores);
    assert.equal(preview.chores?.nextUp.length, PREVIEW_LIMITS.nextUp);
    assert.deepEqual(preview.chores?.upcoming, []);
    assert.equal(preview.maintenance?.items.length, PREVIEW_LIMITS.maintenanceItems);
    assert.equal(preview.shopping?.firstItems.length, PREVIEW_LIMITS.shoppingItems);
  });
});

describe('guard: tablet views never read the preview facts', () => {
  for (const file of ['src/components/devices/tablet-views.tsx', 'src/components/devices/tablet-quick-add.tsx', 'src/components/devices/tablet-shell.tsx']) {
    it(`${file} reads sectionFacts, never data.facts`, () => {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /\bdata\.facts\b/);
      assert.doesNotMatch(source, /\b(firstItems|nextUp|mineNext)\b/, 'preview-only fields');
    });
  }
});
