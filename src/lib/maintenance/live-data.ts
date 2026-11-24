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
 *   record stays on screen, and the page shows its "not shared with you" state, until the
 *   listeners are recreated: every subscription has its own `session`, and the first event of
 *   a new session starts over (so access granted again under the same key recovers).
 * - `confirmed` says every collection has had an answer from the server, not only from the
 *   persistent cache: a deep link to a missing record waits for it before saying it is gone.
 */
import type { HomeAsset, MaintenanceAttachment, MaintenanceLog, Vehicle } from '../types';

export const MAINTENANCE_COLLECTIONS = ['home-assets', 'vehicles', 'maintenance', 'maintenance-attachments'] as const;
export type MaintenanceCollection = typeof MAINTENANCE_COLLECTIONS[number];

/**
 * The order each list is read in. Logs are read unordered (null) and sorted on the page
 * (`sortLogs`, undated last): a Firestore `orderBy('date')` leaves out every log without a
 * `date` field, and such legacy logs are kept (MA-11e).
 */
export const MAINTENANCE_ORDER: Record<MaintenanceCollection, { field: string; direction: 'asc' | 'desc' } | null> = {
  'home-assets': { field: 'name', direction: 'asc' },
  vehicles: { field: 'nickname', direction: 'asc' },
  maintenance: null,
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
  session: number;
  confirmed: Partial<Record<MaintenanceCollection, true>>;
  records: { [K in MaintenanceCollection]: Records[K] | null };
  failures: Partial<Record<MaintenanceCollection, LiveFailure>>;
};

const EMPTY_RECORDS: MaintenanceLiveState['records'] = {
  'home-assets': null,
  vehicles: null,
  maintenance: null,
  'maintenance-attachments': null,
};

export const initialLiveState = (key: string | null = null, session = 0): MaintenanceLiveState => ({ key, session, records: EMPTY_RECORDS, failures: {}, confirmed: {} });

export type LiveEvent =
  | { type: 'answer'; key: string; session: number; collection: MaintenanceCollection; docs: unknown[]; fromCache: boolean }
  | { type: 'failure'; key: string; session: number; collection: MaintenanceCollection; failure: LiveFailure };

export function liveReducer(state: MaintenanceLiveState, event: LiveEvent): MaintenanceLiveState {
  const base = state.key === event.key && state.session === event.session ? state : initialLiveState(event.key, event.session);
  if (event.type === 'answer') {
    // After a refusal nothing is shown again until the listeners are recreated (a new key).
    if (Object.values(base.failures).includes('unauthorized')) return base;
    const failures = { ...base.failures };
    delete failures[event.collection];
    const confirmed = event.fromCache ? base.confirmed : { ...base.confirmed, [event.collection]: true as const };
    return { ...base, records: { ...base.records, [event.collection]: event.docs }, failures, confirmed };
  }
  if (event.failure === 'unauthorized') {
    return { ...base, records: EMPTY_RECORDS, failures: { ...base.failures, [event.collection]: 'unauthorized' }, confirmed: {} };
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
  /** Every collection has answered from the server (not only from the local cache). */
  confirmed: boolean;
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
    confirmed: ready && failure !== 'unauthorized' && MAINTENANCE_COLLECTIONS.every((name) => current.confirmed[name]),
    failure,
  };
}
