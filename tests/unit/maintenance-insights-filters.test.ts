import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  categoryChips,
  EMPTY_FILTERS,
  filterAssets,
  filterLogs,
  filterReminders,
  filterVehicles,
  locationChips,
  matchesRoom,
  paginateLogs,
  parseFilters,
  serializeFilters,
  sortLogs,
  UNASSIGNED,
  VEHICLE_CATEGORY,
} from '../../src/lib/maintenance/filters';
import type { HomeAsset, MaintenanceLog, Vehicle } from '../../src/lib/types';

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const asset = (id: string, overrides: Partial<HomeAsset> = {}): HomeAsset => ({
  id, householdId: 'h', name: id, category: 'Appliance', status: 'active', createdAt: '', updatedAt: '', ...overrides,
});
const vehicle = (id: string, overrides: Partial<Vehicle> = {}): Vehicle => ({
  id, householdId: 'h', nickname: id, status: 'active', createdAt: '', updatedAt: '', ...overrides,
});

const assets = [
  asset('fridge', { name: 'Fridge', brand: 'Bosch', location: 'Kitchen' }),
  asset('dishwasher', { name: 'Dishwasher', location: '  kitchen ', notes: 'Rinse aid every month' }),
  asset('hvac', { name: 'Main HVAC System', category: 'HVAC', location: 'Garage', model: 'XR16' }),
  asset('drill', { name: 'Drill', category: 'Tool' }),
  asset('router', { name: 'Router', category: 'Network', location: '   ' }),
];
const vehicles = [vehicle('car', { nickname: 'Blue car', make: 'Honda', model: 'Civic', licensePlate: 'ABC 123' })];
const context = { assets, vehicles };

describe('maintenance filters in the URL (MA-21)', () => {
  it('parses and serializes without touching other parameters', () => {
    assert.deepEqual(parseFilters('?tab=assets&location=%20Kitchen%20&category=HVAC&q=%20filter%20'), { location: 'Kitchen', category: 'HVAC', q: 'filter' });
    assert.deepEqual(parseFilters(''), EMPTY_FILTERS);
    assert.deepEqual(parseFilters(new URLSearchParams('location=&q=')), EMPTY_FILTERS);
    assert.equal(parseFilters('?q=' + 'x'.repeat(300)).q.length, 100);
    assert.equal(
      serializeFilters('?tab=assets&asset=a%2Fb&log=l&vehicle=v&schedule=a%3Ab&location=Old', { location: 'Living room', category: null, q: 'air filter' }),
      '?tab=assets&asset=a%2Fb&log=l&vehicle=v&schedule=a%3Ab&location=Living+room&q=air+filter',
    );
    assert.equal(serializeFilters('?location=Kitchen&q=x', EMPTY_FILTERS), '');
    assert.equal(serializeFilters('?tab=logs', EMPTY_FILTERS), '?tab=logs');
  });

  it('round-trips any filters (property)', () => {
    const random = rng(21);
    const pieces = ['Kitchen', ' living  room ', '&', '=', '?', '#', 'ü', '%', '+', 'a/b', ''];
    for (let run = 0; run < 300; run += 1) {
      const text = () => Array.from({ length: Math.floor(random() * 3) }, () => pieces[Math.floor(random() * pieces.length)]).join(' ');
      const filters = { location: text() || null, category: text() || null, q: text() };
      const parsed = parseFilters(serializeFilters('?tab=assets&asset=x', filters));
      assert.deepEqual(parseFilters(serializeFilters('', parsed)), parsed);
      assert.equal(new URLSearchParams(serializeFilters('?tab=assets&asset=x', filters)).get('asset'), 'x');
    }
  });

  it('matches rooms ignoring case and surrounding spaces', () => {
    assert.equal(matchesRoom('  Kitchen ', 'kitchen'), true);
    assert.equal(matchesRoom('Living  room', 'living room'), true);
    assert.equal(matchesRoom('Kitchen', 'Kitchenette'), false);
    assert.equal(matchesRoom('', ''), false);
    assert.equal(matchesRoom(undefined, 'Kitchen'), false);
  });
});

describe('filtering lists (MA-21)', () => {
  it('filters assets by location, Unassigned, category and search', () => {
    const ids = (list: { id: string }[]) => list.map((item) => item.id);
    assert.deepEqual(ids(filterAssets(assets, { ...EMPTY_FILTERS, location: 'KITCHEN' })), ['fridge', 'dishwasher']);
    assert.deepEqual(ids(filterAssets(assets, { ...EMPTY_FILTERS, location: UNASSIGNED })), ['drill', 'router']);
    assert.deepEqual(ids(filterAssets(assets, { ...EMPTY_FILTERS, category: 'hvac' })), ['hvac']);
    assert.deepEqual(ids(filterAssets(assets, { ...EMPTY_FILTERS, q: 'bosch' })), ['fridge']);
    assert.deepEqual(ids(filterAssets(assets, { ...EMPTY_FILTERS, q: 'rinse month' })), ['dishwasher']);
    assert.deepEqual(ids(filterAssets(assets, { ...EMPTY_FILTERS, q: 'xr16 garage' })), ['hvac']);
    assert.deepEqual(ids(filterAssets(assets, { location: 'Kitchen', category: 'Appliance', q: 'fridge' })), ['fridge']);
  });

  it('treats vehicles as the Vehicle category with no location', () => {
    assert.equal(filterVehicles(vehicles, { ...EMPTY_FILTERS, q: 'abc 123' }).length, 1);
    assert.equal(filterVehicles(vehicles, { ...EMPTY_FILTERS, q: 'civic' }).length, 1);
    assert.equal(filterVehicles(vehicles, { ...EMPTY_FILTERS, category: 'vehicle' }).length, 1);
    assert.equal(filterVehicles(vehicles, { ...EMPTY_FILTERS, category: 'HVAC' }).length, 0);
    assert.equal(filterVehicles(vehicles, { ...EMPTY_FILTERS, location: 'Garage' }).length, 0);
  });

  it('filters logs and reminders by the item they belong to', () => {
    const logs: MaintenanceLog[] = [
      { id: 'l1', targetType: 'home_asset', assetId: 'hvac', date: '2026-01-01', title: 'Replace filter', serviceProvider: 'Cool Air Co' },
      { id: 'l2', targetType: 'vehicle', vehicleId: 'car', date: '2026-01-01', title: 'Oil change', partsUsed: '5W-30' },
      { id: 'l3', targetType: 'general', date: '2026-01-01', title: 'Gutters', notes: 'Cleaned the filter screens', formerTargetName: 'Old house' },
      { id: 'l4', assetId: 'fridge', date: '2026-01-01', item: 'Coil clean' },
    ];
    const ids = (list: { id: string }[]) => list.map((item) => item.id);
    assert.deepEqual(ids(filterLogs(logs, { ...EMPTY_FILTERS, location: 'garage' }, context)), ['l1']);
    assert.deepEqual(ids(filterLogs(logs, { ...EMPTY_FILTERS, location: 'kitchen' }, context)), ['l4']);
    assert.deepEqual(ids(filterLogs(logs, { ...EMPTY_FILTERS, category: VEHICLE_CATEGORY }, context)), ['l2']);
    assert.deepEqual(ids(filterLogs(logs, { ...EMPTY_FILTERS, q: 'filter' }, context)), ['l1', 'l3']);
    assert.deepEqual(ids(filterLogs(logs, { ...EMPTY_FILTERS, q: 'cool air' }, context)), ['l1']);
    assert.deepEqual(ids(filterLogs(logs, { ...EMPTY_FILTERS, q: '5w' }, context)), ['l2']);
    assert.deepEqual(ids(filterLogs(logs, EMPTY_FILTERS, context)), ['l1', 'l2', 'l3', 'l4']);

    const reminders = [
      { id: 'r1', targetType: 'home_asset' as const, targetId: 'hvac', title: 'Replace filter', relatedName: 'Main HVAC System' },
      { id: 'r2', targetType: 'vehicle' as const, targetId: 'car', title: 'Oil change', relatedName: 'Blue car' },
      { id: 'r3', targetType: 'home_asset' as const, targetId: 'gone', title: 'Orphan', relatedName: 'Gone' },
    ];
    assert.deepEqual(ids(filterReminders(reminders, { ...EMPTY_FILTERS, location: 'Garage' }, context)), ['r1']);
    assert.deepEqual(ids(filterReminders(reminders, { ...EMPTY_FILTERS, q: 'blue' }, context)), ['r2']);
    assert.deepEqual(ids(filterReminders(reminders, EMPTY_FILTERS, context)), ['r1', 'r2', 'r3']);
  });

  it('lists distinct location and category chips with counts', () => {
    assert.deepEqual(locationChips(assets), [
      { value: 'Garage', label: 'Garage', count: 1 },
      { value: 'Kitchen', label: 'Kitchen', count: 2 },
      { value: UNASSIGNED, label: UNASSIGNED, count: 2 },
    ]);
    assert.deepEqual(categoryChips(assets, vehicles), [
      { value: 'Appliance', label: 'Appliance', count: 2 },
      { value: 'HVAC', label: 'HVAC', count: 1 },
      { value: 'Network', label: 'Network', count: 1 },
      { value: 'Tool', label: 'Tool', count: 1 },
      { value: VEHICLE_CATEGORY, label: VEHICLE_CATEGORY, count: 1 },
    ]);
    assert.deepEqual(categoryChips([], []), []);
  });

  it('chip counts match the filtered lists (property)', () => {
    const random = rng(2121);
    const rooms = ['Kitchen', 'kitchen ', ' KITCHEN', 'Garage', '', undefined, 'Living room', 'living  room'];
    for (let run = 0; run < 200; run += 1) {
      const list = Array.from({ length: Math.floor(random() * 15) }, (_, index) =>
        asset(`a${index}`, { location: rooms[Math.floor(random() * rooms.length)] }));
      const chips = locationChips(list);
      assert.equal(chips.reduce((sum, chip) => sum + chip.count, 0), list.length);
      for (const chip of chips) assert.equal(filterAssets(list, { ...EMPTY_FILTERS, location: chip.value }).length, chip.count, chip.value);
    }
  });
});

describe('log pagination (MA-21)', () => {
  const logs: MaintenanceLog[] = Array.from({ length: 45 }, (_, index) => ({
    id: `log-${String(index).padStart(2, '0')}`,
    date: index % 9 === 0 ? 'unknown' : `2026-0${1 + (index % 5)}-1${index % 3}`,
    createdAt: index % 4 === 0 ? undefined : `2026-06-01T0${index % 7}:00:00Z`,
  }));

  it('orders by date, then createdAt, then id, with undated logs last', () => {
    const sorted = sortLogs([
      { id: 'b', date: '2026-03-01', createdAt: '2026-03-01T10:00:00Z' },
      { id: 'a', date: '2026-03-01', createdAt: '2026-03-01T10:00:00Z' },
      { id: 'c', date: '2026-03-01', createdAt: '2026-03-01T12:00:00Z' },
      { id: 'd', date: '' },
      { id: 'e', date: '2026-03-02' },
      { id: 'f', date: '2026-03-01T23:00:00.000Z' },
    ]);
    assert.deepEqual(sorted.map((log) => log.id), ['e', 'f', 'c', 'a', 'b', 'd']);
  });

  it('pages 20 at a time, clamped, covering every log once', () => {
    const first = paginateLogs(logs, 1);
    assert.equal(first.items.length, 20);
    assert.equal(first.pageCount, 3);
    assert.equal(first.hasPrevious, false);
    assert.equal(first.hasNext, true);
    const last = paginateLogs(logs, 99);
    assert.equal(last.page, 3);
    assert.equal(last.items.length, 5);
    assert.equal(paginateLogs(logs, -2).page, 1);
    assert.equal(paginateLogs(logs, Number.NaN).page, 1);
    assert.deepEqual(paginateLogs([], 1), { items: [], page: 1, pageCount: 1, total: 0, hasPrevious: false, hasNext: false });
    const seen = [1, 2, 3].flatMap((page) => paginateLogs(logs, page).items.map((log) => log.id));
    assert.deepEqual(seen, sortLogs(logs).map((log) => log.id));
    assert.equal(new Set(seen).size, logs.length);
    // The order does not depend on the input order.
    assert.deepEqual(sortLogs([...logs].reverse()).map((log) => log.id), seen);
  });
});
