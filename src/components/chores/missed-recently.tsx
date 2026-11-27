'use client';

import { MISSED_EXPIRY_DAYS, recentMissed, type MissedEntry } from '@functions/shared/missed';
import { format } from 'date-fns';
import { dayFromKey } from '@/lib/chores/dates';

/**
 * CH-7: what was not done stays visible after it leaves To Do. Missed days of a repeating
 * chore expire from To Do after a week (server upkeep, functions/src/shared/missed.ts) and
 * are listed here: "3 missed in the last 2 weeks", with what, whose and which day. The
 * page reads the entries once (`useMissedEntries`) for this list and for fair streaks.
 */
export function MissedRecently({ entries, today, nameOf }: {
  entries: readonly MissedEntry[];
  today: string;
  nameOf: (entry: MissedEntry) => string;
}) {
  const recent = recentMissed(entries, today);
  if (recent.length === 0) return null;
  return (
    <details className="mt-3 rounded-lg border border-dashed px-3 py-2 text-sm" data-testid="chores-missed-recently">
      <summary className="cursor-pointer select-none font-medium text-muted-foreground">
        {recent.length === 1 ? '1 missed' : `${recent.length} missed`} in the last 2 weeks
      </summary>
      <p className="mt-1 text-xs text-muted-foreground">
        A repeating chore&apos;s day that isn&apos;t done within {MISSED_EXPIRY_DAYS} days leaves To Do and is listed here.
      </p>
      <ul className="mt-2 space-y-1">
        {recent.map(entry => (
          <li key={entry.key} className="flex justify-between gap-3">
            <span className="min-w-0 truncate">{entry.task}</span>
            <span className="shrink-0 text-muted-foreground">{nameOf(entry)} · {format(dayFromKey(entry.day), 'EEE, MMM d')}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
