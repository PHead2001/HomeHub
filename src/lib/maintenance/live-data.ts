/**
 * What the Maintenance Center holds from its four live listeners (MA-2): home assets,
 * vehicles, logs and attachment metadata of one household. Framework-free and unit tested;
 * `useMaintenanceLiveData` (src/components/maintenance/use-maintenance-data.ts) drives it.
 *
 * - The state is keyed by the listener key (household and member). An answer or failure for
 *   another key starts over, so one household's records are never shown in another's.
 * - The page is `ready` once every collection has answered once for the key (the first-load
 *   skeleton shows until then, and deep links wait for it).
 * - A transient failure keeps what loaded and lets the listener retry with backoff; before
 *   anything loaded it is the page's error state.
 * - A refusal (`unauthorized`: access lost) clears every collection, so no stale protected
 *   record stays on screen, and the page shows its "not shared with you" state.
 */
import type { HomeAsset, MaintenanceAttachment, MaintenanceLog, Vehicle } from '../types';

export const MAINTENANCE_COLLECTIONS = ['home-assets', 'vehicles', 'maintenance', 'maintenance-attachments'] as const;
export type MaintenanceCollection = typeof MAINTENANCE_COLLECTIONS[number];

/** The order each list is read in (what the one-time reads used). */
export const MAINTENANCE_ORDER: Record<MaintenanceCollection, { field: string; direction: 'asc' | 'desc' }> = {
  'home-assets': { field: 'name', direction: 'asc' },
  vehicles: { field: 'nickname', direction: 'asc' },
  maintenance: { field: 'date', direction: 'desc' },
  'maintenance-attachments': { field: 'createdAt', direction: 'desc' },
};

type Records = {
  'home-assets': HomeAsset[];
  vehicles: Vehicle[];
  maintenance: MaintenanceLog[];
  'maintenance-attachments': MaintenanceAttachment[];
};

export type LiveFailure = 'retrying' | 'unauthorized';

export type MaintenanceLiveState = {
  key: string | null;
  records: { [K in MaintenanceCollection]: Records[K] | null };
  failures: Partial<Record<MaintenanceCollection, LiveFailure>>;
};

const EMPTY_RECORDS: MaintenanceLiveState['records'] = {
  'home-assets': null,
  vehicles: null,
  maintenance: null,
  'maintenance-attachments': null,
};

export const initialLiveState = (key: string | null = null): MaintenanceLiveState => ({ key, records: EMPTY_RECORDS, failures: {} });

export type LiveEvent =
  | { type: 'answer'; key: string; collection: MaintenanceCollection; docs: unknown[] }
  | { type: 'failure'; key: string; collection: MaintenanceCollection; failure: LiveFailure };

export function liveReducer(state: MaintenanceLiveState, event: LiveEvent): MaintenanceLiveState {
  const base = state.key === event.key ? state : initialLiveState(event.key);
  if (event.type === 'answer') {
    // After a refusal nothing is shown again until the listeners are recreated (a new key).
    if (Object.values(base.failures).includes('unauthorized')) return base;
    const failures = { ...base.failures };
    delete failures[event.collection];
    return { ...base, records: { ...base.records, [event.collection]: event.docs }, failures };
  }
  if (event.failure === 'unauthorized') {
    return { key: event.key, records: EMPTY_RECORDS, failures: { ...base.failures, [event.collection]: 'unauthorized' } };
  }
  if (base.failures[event.collection] === 'unauthorized') return base;
  return { ...base, failures: { ...base.failures, [event.collection]: 'retrying' } };
}

export type MaintenanceLiveView = {
  assets: HomeAsset[];
  vehicles: Vehicle[];
  logs: MaintenanceLog[];
  attachments: MaintenanceAttachment[];
  /** Every collection has answered once for this key. */
  ready: boolean;
  /** `unauthorized` when any collection was refused; `retrying` when one failed before the page was ready. */
  failure: LiveFailure | null;
};

const NONE: never[] = [];

/** The view of `state` for the listener key in use: nothing of another key, ever. */
export function liveView(state: MaintenanceLiveState, key: string | null): MaintenanceLiveView {
  const current = state.key === key ? state : initialLiveState(key);
  const { records } = current;
  const ready = MAINTENANCE_COLLECTIONS.every((name) => records[name] !== null);
  const failures = Object.values(current.failures);
  const failure: LiveFailure | null = failures.includes('unauthorized')
    ? 'unauthorized'
    : !ready && failures.includes('retrying') ? 'retrying' : null;
  return {
    assets: records['home-assets'] ?? NONE,
    vehicles: records.vehicles ?? NONE,
    logs: records.maintenance ?? NONE,
    attachments: records['maintenance-attachments'] ?? NONE,
    ready: ready && failure !== 'unauthorized',
    failure,
  };
}
