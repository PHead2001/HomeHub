// Which logs belong to an asset or vehicle. Shared by the cost summary, the
// service history line and the filters. Same rule as the health score: a log's
// `targetType` when set, otherwise inferred from its ids (legacy logs). Logs of a
// deleted record are general logs (only `formerTargetName` remains), so they are
// never linked to anything.
import type { MaintenanceLog } from '../types';

export type MaintenanceTarget = { type: 'home_asset' | 'vehicle'; id: string };

export type LinkFields = Pick<MaintenanceLog, 'targetType' | 'assetId' | 'vehicleId'>;

/** A log's target type, inferring it for legacy logs without `targetType`. */
export const logTargetType = (log: LinkFields): 'home_asset' | 'vehicle' | 'general' =>
  log.targetType || (log.assetId ? 'home_asset' : log.vehicleId ? 'vehicle' : 'general');

/** True when the log is linked (live link, not a former one) to the target. */
export const isLinkedTo = (log: LinkFields, target: MaintenanceTarget): boolean => {
  const type = logTargetType(log);
  if (type !== target.type || !target.id) return false;
  return type === 'home_asset' ? log.assetId === target.id : log.vehicleId === target.id;
};

/** The logs linked to the target. */
export const linkedLogs = <T extends LinkFields>(logs: readonly T[], target: MaintenanceTarget): T[] =>
  logs.filter((log) => isLinkedTo(log, target));
