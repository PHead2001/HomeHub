// Service history line (MA-32): "<Title> last done <relative time> by <name>"
// for an asset or vehicle, optionally for one of its schedules. Pure, unit
// tested (tests/unit/maintenance-insights-history.test.ts).
//
// `doneByName` is written on new logs by the server; legacy logs have none and
// the line then leaves out "by …" rather than guessing. Names go through
// `publicDisplayName`, so an email is never shown.
import { diffDays, toDay } from '../../../functions/src/shared/calendar';
import { publicDisplayName } from '../member-directory';
import type { MaintenanceLog } from '../types';
import { linkedLogs, type LinkFields, type MaintenanceTarget } from './links';
import { spanLabel } from './reminder-copy';

export type HistoryLog = LinkFields &
  Pick<MaintenanceLog, 'id' | 'date'> &
  Partial<Pick<MaintenanceLog, 'title' | 'item' | 'createdAt'>> & {
    /** Who did the work, as written by the server on new logs. */
    doneByName?: string | null;
    /** On a completion's log (server-written): the schedule it completed. */
    completion?: { scheduleId?: unknown } | null;
  };

/** Which schedule's history: its name (title match) and the ids it is stored under (its id or legacy key). */
export type HistorySchedule = { name?: string | null; ids?: readonly (string | null | undefined)[] };

const completionScheduleId = (log: Pick<HistoryLog, 'completion'>) =>
  typeof log.completion?.scheduleId === 'string' && log.completion.scheduleId ? log.completion.scheduleId : null;

/**
 * True when the log belongs to the schedule. A completion's log names its
 * schedule (`completion.scheduleId`): when the schedule's ids are known, only
 * that id counts, whatever the title says (an edited Log service title still
 * matches; a log titled like another schedule does not). Other logs, or no ids
 * given, match by title (or legacy `item`), ignoring case and spacing.
 */
export const logMatchesSchedule = (log: Pick<HistoryLog, 'completion' | 'title' | 'item'>, schedule: HistorySchedule) => {
  const id = completionScheduleId(log);
  const ids = (schedule.ids ?? []).filter(Boolean);
  if (id && ids.length > 0) return ids.includes(id);
  const wanted = normalizeTitle(schedule.name);
  return Boolean(wanted) && normalizeTitle(logTitle(log)) === wanted;
};

/** Lower-case, trimmed, single-spaced: how a log title is matched to a schedule name. */
const normalizeTitle = (value: unknown) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '');

const logTitle = (log: Pick<HistoryLog, 'title' | 'item'>) => (log.title || log.item || '').trim();

/** "today", "yesterday", "5 days ago", "3 weeks ago", "3 months ago", "2 years ago". */
export function relativeDayText(day: string, today: string): string {
  const days = diffDays(today, day);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${spanLabel(days)} ago`;
}

/**
 * The newest log linked to the target (dated on or before today in the household
 * zone), optionally only those for one schedule (`logMatchesSchedule`: the
 * completion's schedule id when the log has one, otherwise the title).
 * `scheduleName` alone matches by title only. Ties on the day go to the later
 * `createdAt`, then the id.
 */
export function latestServiceLog<T extends HistoryLog>(
  logs: readonly T[],
  target: MaintenanceTarget,
  options: { today: string; timeZone: string; scheduleName?: string | null; scheduleIds?: readonly (string | null | undefined)[] },
): { log: T; day: string } | null {
  const perSchedule = Boolean(normalizeTitle(options.scheduleName)) || Boolean(options.scheduleIds?.some(Boolean));
  const schedule: HistorySchedule = { name: options.scheduleName, ids: options.scheduleIds };
  let best: { log: T; day: string } | null = null;
  for (const log of linkedLogs(logs, target)) {
    if (perSchedule && !logMatchesSchedule(log, schedule)) continue;
    const day = toDay(log.date, options.timeZone);
    if (!day || day > options.today) continue;
    if (
      !best ||
      day > best.day ||
      (day === best.day && ((log.createdAt || '') > (best.log.createdAt || '') ||
        ((log.createdAt || '') === (best.log.createdAt || '') && log.id > best.log.id)))
    ) {
      best = { log, day };
    }
  }
  return best;
}

/**
 * "Replace air filter last done 3 months ago by Sam", or without "by Sam" when the
 * log has no usable name. The title is the schedule name when one is given,
 * otherwise the log's title. Null when nothing has been logged.
 */
export function serviceHistoryLine(
  logs: readonly HistoryLog[],
  target: MaintenanceTarget,
  options: { today: string; timeZone: string; scheduleName?: string | null; scheduleIds?: readonly (string | null | undefined)[] },
): string | null {
  const latest = latestServiceLog(logs, target, options);
  if (!latest) return null;
  const title = options.scheduleName?.trim() || logTitle(latest.log) || 'Maintenance';
  const name = publicDisplayName(latest.log.doneByName, '');
  return `${title} last done ${relativeDayText(latest.day, options.today)}${name ? ` by ${name}` : ''}`;
}
