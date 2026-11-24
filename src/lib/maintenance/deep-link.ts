/**
 * What a Maintenance Center URL asks for (`?tab=`, `?asset=`, `?vehicle=`, `?log=`,
 * `?schedule=`, or the notification form `?targetType=&targetId=`), given the records loaded.
 * Pure: the page applies it once per URL after every live listener has answered once.
 */
export const MAINTENANCE_TABS = ['overview', 'assets', 'vehicles', 'reminders', 'logs'] as const;
export type MaintenanceTab = typeof MAINTENANCE_TABS[number];
export const isMaintenanceTab = (value: string | null): value is MaintenanceTab =>
  Boolean(value && (MAINTENANCE_TABS as readonly string[]).includes(value));

export type DeepLinkPlan = {
  /** The tab to show, or null to keep the current one. */
  tab: MaintenanceTab | null;
  selectAssetId: string | null;
  selectVehicleId: string | null;
  highlightedLogId: string | null;
  highlightedScheduleKey: string | null;
  notice: string | null;
  /** Scroll to the linked schedule (by key) or log (by id). */
  scrollTo: { kind: 'schedule' | 'log'; id: string } | null;
};

const EMPTY: DeepLinkPlan = {
  tab: null, selectAssetId: null, selectVehicleId: null, highlightedLogId: null, highlightedScheduleKey: null, notice: null, scrollTo: null,
};

export function deepLinkPlan(
  search: string,
  records: { assets: { id: string }[]; vehicles: { id: string }[]; logs: { id: string }[] },
): DeepLinkPlan {
  if (!search) return EMPTY;
  const params = new URLSearchParams(search);
  const tab = params.get('tab');
  const assetId = params.get('asset') || (params.get('targetType') === 'home_asset' ? params.get('targetId') : null);
  const vehicleId = params.get('vehicle') || (params.get('targetType') === 'vehicle' ? params.get('targetId') : null);
  const logId = params.get('log');
  const scheduleKey = params.get('schedule');
  const plan: DeepLinkPlan = { ...EMPTY, highlightedScheduleKey: scheduleKey };

  if (assetId) {
    if (!records.assets.some((asset) => asset.id === assetId)) return { ...plan, tab: 'assets', notice: 'The requested home asset is no longer available.' };
    return { ...plan, tab: 'assets', selectAssetId: assetId, scrollTo: scheduleKey ? { kind: 'schedule', id: scheduleKey } : null };
  }
  if (vehicleId) {
    if (!records.vehicles.some((vehicle) => vehicle.id === vehicleId)) return { ...plan, tab: 'vehicles', notice: 'The requested vehicle is no longer available.' };
    return { ...plan, tab: 'vehicles', selectVehicleId: vehicleId, scrollTo: scheduleKey ? { kind: 'schedule', id: scheduleKey } : null };
  }
  if (logId) {
    if (!records.logs.some((log) => log.id === logId)) return { ...plan, tab: 'logs', notice: 'The requested maintenance log is no longer available.' };
    return { ...plan, tab: 'logs', highlightedLogId: logId, scrollTo: { kind: 'log', id: logId } };
  }
  return { ...plan, tab: isMaintenanceTab(tab) ? tab : null };
}
