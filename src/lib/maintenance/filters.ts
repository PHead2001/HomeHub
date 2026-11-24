// Location, category and search filters for the Maintenance Center (MA-21), kept
// in the URL (`?location=`, `?category=`, `?q=`) next to the existing
// `?tab=`, `?asset=`, `?vehicle=`, `?log=` and `?schedule=` parameters, which
// these helpers never touch. Pure, unit tested
// (tests/unit/maintenance-insights-filters.test.ts).
//
// Vehicles have no location and no category field: they count as the category
// "Vehicle" and are hidden while a location filter is on. Logs and reminders
// follow the asset or vehicle they belong to; general logs (including logs of a
// deleted record) have no location or category and are hidden while either
// filter is on. Search is separate per list: assets by name, brand, model,
// location and notes; vehicles by nickname, make, model and plate; logs by
// title, provider, parts and notes; reminders by title and the item's name.
import type { HomeAsset, MaintenanceLog, Vehicle } from '../types';
import { logTargetType, type LinkFields } from './links';

export type MaintenanceFilters = {
  /** A location label, `UNASSIGNED` for assets without one, or null for all. */
  location: string | null;
  /** An asset category, `VEHICLE_CATEGORY`, or null for all. */
  category: string | null;
  /** Free-text search, trimmed ('' for none). */
  q: string;
};

export const UNASSIGNED = 'Unassigned';
export const VEHICLE_CATEGORY = 'Vehicle';
export const LOG_PAGE_SIZE = 20;
/** Longest search text kept from the URL. */
export const MAX_QUERY_LENGTH = 100;

export const EMPTY_FILTERS: MaintenanceFilters = { location: null, category: null, q: '' };

const tidy = (value: string) => value.trim().replace(/\s+/g, ' ');

/** Case-insensitive, trimmed, single-spaced key for comparing labels. */
export const labelKey = (value: unknown) => (typeof value === 'string' ? tidy(value).toLowerCase() : '');

const cleanParam = (value: string | null) => {
  const text = value ? tidy(value) : '';
  return text ? text : null;
};

/** Reads the filters from a query string (with or without "?") or URLSearchParams. */
export function parseFilters(search: string | URLSearchParams): MaintenanceFilters {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  return {
    location: cleanParam(params.get('location')),
    category: cleanParam(params.get('category')),
    q: (params.get('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH),
  };
}

/**
 * The query string with these filters: a copy of `current` with only
 * `location`, `category` and `q` set or removed, every other parameter kept in
 * place. Returns "" or a string starting with "?".
 */
export function serializeFilters(current: string | URLSearchParams, filters: MaintenanceFilters): string {
  const params = new URLSearchParams(typeof current === 'string' ? current : current.toString());
  const set = (key: string, value: string | null) => {
    const text = value?.trim();
    if (text) params.set(key, text);
    else params.delete(key);
  };
  set('location', filters.location);
  set('category', filters.category);
  set('q', filters.q.slice(0, MAX_QUERY_LENGTH));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export const hasActiveFilters = (filters: MaintenanceFilters) => Boolean(filters.location || filters.category || filters.q);

/**
 * True when an asset's location is the room: same text ignoring case and
 * surrounding or repeated spaces. Empty values never match. Used by the location
 * filter and by MA-26 (a registered tablet's room name).
 */
export const matchesRoom = (location: unknown, roomName: unknown) => {
  const key = labelKey(location);
  return Boolean(key) && key === labelKey(roomName);
};

const locationMatches = (location: unknown, wanted: string) =>
  labelKey(wanted) === labelKey(UNASSIGNED) ? !labelKey(location) || matchesRoom(location, UNASSIGNED) : matchesRoom(location, wanted);

/** Every word of the query appears in one of the fields (case-insensitive). */
export const matchesSearch = (fields: readonly unknown[], q: string) => {
  const words = labelKey(q).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  const values = fields.map(labelKey).filter(Boolean);
  return words.every((word) => values.some((value) => value.includes(word)));
};

type AssetLike = Pick<HomeAsset, 'id' | 'name' | 'category'> & Partial<Pick<HomeAsset, 'location' | 'brand' | 'model' | 'notes'>>;
type VehicleLike = Pick<Vehicle, 'id' | 'nickname'> & Partial<Pick<Vehicle, 'make' | 'model' | 'licensePlate'>>;

const assetPasses = (asset: AssetLike, filters: MaintenanceFilters, withSearch: boolean) =>
  (!filters.location || locationMatches(asset.location, filters.location)) &&
  (!filters.category || labelKey(asset.category || 'Other') === labelKey(filters.category)) &&
  (!withSearch || matchesSearch([asset.name, asset.brand, asset.model, asset.location, asset.notes], filters.q));

const vehiclePasses = (vehicle: VehicleLike, filters: MaintenanceFilters, withSearch: boolean) =>
  !filters.location &&
  (!filters.category || labelKey(filters.category) === labelKey(VEHICLE_CATEGORY)) &&
  (!withSearch || matchesSearch([vehicle.nickname, vehicle.make, vehicle.model, vehicle.licensePlate], filters.q));

export const filterAssets = <T extends AssetLike>(assets: readonly T[], filters: MaintenanceFilters): T[] =>
  assets.filter((asset) => assetPasses(asset, filters, true));

export const filterVehicles = <T extends VehicleLike>(vehicles: readonly T[], filters: MaintenanceFilters): T[] =>
  vehicles.filter((vehicle) => vehiclePasses(vehicle, filters, true));

type FilterContext = { assets: readonly AssetLike[]; vehicles: readonly VehicleLike[] };

/** Whether the asset or vehicle a log or reminder belongs to passes the location and category filters. */
const targetPasses = (
  type: 'home_asset' | 'vehicle' | 'general',
  id: string | undefined,
  context: FilterContext,
  filters: MaintenanceFilters,
) => {
  if (!filters.location && !filters.category) return true;
  if (type === 'home_asset') {
    const asset = context.assets.find((item) => item.id === id);
    return asset ? assetPasses(asset, filters, false) : false;
  }
  if (type === 'vehicle') {
    const vehicle = context.vehicles.find((item) => item.id === id);
    return vehicle ? vehiclePasses(vehicle, filters, false) : false;
  }
  return false;
};

type LogLike = LinkFields & Partial<Pick<MaintenanceLog, 'title' | 'item' | 'serviceProvider' | 'partsUsed' | 'notes'>>;

export const filterLogs = <T extends LogLike>(logs: readonly T[], filters: MaintenanceFilters, context: FilterContext): T[] =>
  logs.filter((log) => {
    const type = logTargetType(log);
    return targetPasses(type, type === 'home_asset' ? log.assetId : log.vehicleId, context, filters) &&
      matchesSearch([log.title || log.item, log.serviceProvider, log.partsUsed, log.notes], filters.q);
  });

type ReminderLike = { targetType: 'home_asset' | 'vehicle'; targetId: string; title: string; relatedName?: string };

export const filterReminders = <T extends ReminderLike>(reminders: readonly T[], filters: MaintenanceFilters, context: FilterContext): T[] =>
  reminders.filter((reminder) =>
    targetPasses(reminder.targetType, reminder.targetId, context, filters) &&
    matchesSearch([reminder.title, reminder.relatedName], filters.q));

export type FilterChip = { value: string; label: string; count: number };

const byLabel = (a: FilterChip, b: FilterChip) => a.label.localeCompare(b.label, 'en-US', { sensitivity: 'base' });

/**
 * One chip per distinct asset location (case and spacing ignored; the label is
 * the first spelling seen, tidied), sorted by name, then "Unassigned" for
 * assets without a location. Counts are assets.
 */
export function locationChips(assets: readonly AssetLike[]): FilterChip[] {
  const chips = new Map<string, FilterChip>();
  let unassigned = 0;
  for (const asset of assets) {
    const key = labelKey(asset.location);
    if (!key || key === labelKey(UNASSIGNED)) {
      unassigned += 1;
      continue;
    }
    const chip = chips.get(key);
    if (chip) chip.count += 1;
    else {
      const label = tidy(asset.location as string);
      chips.set(key, { value: label, label, count: 1 });
    }
  }
  const list = [...chips.values()].sort(byLabel);
  if (unassigned) list.push({ value: UNASSIGNED, label: UNASSIGNED, count: unassigned });
  return list;
}

/** One chip per asset category in use, sorted by name, then "Vehicle" when there are vehicles. */
export function categoryChips(assets: readonly AssetLike[], vehicles: readonly VehicleLike[] = []): FilterChip[] {
  const chips = new Map<string, FilterChip>();
  for (const asset of assets) {
    const label = tidy(asset.category || 'Other');
    const chip = chips.get(labelKey(label));
    if (chip) chip.count += 1;
    else chips.set(labelKey(label), { value: label, label, count: 1 });
  }
  const list = [...chips.values()].sort(byLabel);
  if (vehicles.length) list.push({ value: VEHICLE_CATEGORY, label: VEHICLE_CATEGORY, count: vehicles.length });
  return list;
}

type SortableLog = Pick<MaintenanceLog, 'id' | 'date'> & Partial<Pick<MaintenanceLog, 'createdAt'>>;

const dateKey = (value: unknown) => {
  if (typeof value !== 'string' || !value) return null;
  return Number.isNaN(new Date(value).getTime()) ? null : value;
};

/**
 * Logs in a stable order: date newest first (logs with no readable date last),
 * then `createdAt` newest first, then id. Returns a new array.
 */
export function sortLogs<T extends SortableLog>(logs: readonly T[]): T[] {
  return [...logs].sort((a, b) => {
    const da = dateKey(a.date);
    const db = dateKey(b.date);
    if (da !== db) {
      if (da === null) return 1;
      if (db === null) return -1;
      const byDate = db.slice(0, 10).localeCompare(da.slice(0, 10)) || db.localeCompare(da);
      if (byDate) return byDate;
    }
    const byCreated = (b.createdAt || '').localeCompare(a.createdAt || '');
    if (byCreated) return byCreated;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * The 1-based page (`LOG_PAGE_SIZE` per page, `sortLogs` order) that holds the
 * log, so a `?log=` deep link opens the page it is on. Null when it is not in the list.
 */
export function pageOfLog<T extends SortableLog>(logs: readonly T[], logId: string | null | undefined, pageSize = LOG_PAGE_SIZE): number | null {
  if (!logId) return null;
  const index = sortLogs(logs).findIndex((log) => log.id === logId);
  if (index < 0) return null;
  return Math.floor(index / Math.max(1, Math.floor(pageSize) || LOG_PAGE_SIZE)) + 1;
}

export type LogPage<T> = { items: T[]; page: number; pageCount: number; total: number; hasPrevious: boolean; hasNext: boolean };

/**
 * One page (1-based, clamped to the pages that exist) of the logs in
 * `sortLogs` order, `LOG_PAGE_SIZE` (20) per page.
 */
export function paginateLogs<T extends SortableLog>(logs: readonly T[], page: number, pageSize = LOG_PAGE_SIZE): LogPage<T> {
  const size = Math.max(1, Math.floor(pageSize) || LOG_PAGE_SIZE);
  const total = logs.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = Math.min(pageCount, Math.max(1, Math.floor(Number.isFinite(page) ? page : 1)));
  const items = sortLogs(logs).slice((current - 1) * size, current * size);
  return { items, page: current, pageCount, total, hasPrevious: current > 1, hasNext: current < pageCount };
}
