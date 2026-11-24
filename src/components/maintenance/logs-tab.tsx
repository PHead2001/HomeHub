'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TabsContent } from '@/components/ui/tabs';
import { LOG_PAGE_SIZE, pageOfLog, paginateLogs } from '@/lib/maintenance/filters';
import { LogList } from './log-list';
import type { LogPreset } from './page-model';
import type { LogListShared, MaintenanceLog } from './tab-types';

type LogsTabProps = {
  /** The logs that pass the filters (any order: they are sorted here, undated last). */
  logs: MaintenanceLog[];
  /** A filter or search is on (changes the empty copy). */
  filtered: boolean;
  /** Changes whenever the filters do: the list goes back to page 1. */
  filterKey: string;
  highlightedLogId: string | null;
  canCreateLogs: boolean;
  logListProps: LogListShared;
  openLogDialog: (preset?: LogPreset) => void;
};

/**
 * Logs (MA-21): every log that passes the filters, newest first (undated ones last), 20 per
 * page. A `?log=` link opens the page that log is on. Files are opened per log.
 */
export const LogsTab = React.memo(function LogsTab({ logs, filtered, filterKey, highlightedLogId, canCreateLogs, logListProps, openLogDialog }: LogsTabProps) {
  const [page, setPage] = React.useState(() => pageOfLog(logs, highlightedLogId) ?? 1);
  // Back to page 1 when the filters change; to the linked log's page when a link names one.
  const [seen, setSeen] = React.useState({ filterKey, highlightedLogId });
  if (seen.filterKey !== filterKey || seen.highlightedLogId !== highlightedLogId) {
    setSeen({ filterKey, highlightedLogId });
    setPage(pageOfLog(logs, highlightedLogId) ?? 1);
  }
  const current = paginateLogs(logs, page);
  const top = React.useRef<HTMLDivElement | null>(null);
  const go = (next: number) => {
    setPage(next);
    top.current?.scrollIntoView({ block: 'start' });
  };

  return (
    <TabsContent value="logs" className="space-y-4 pt-4">
      <div ref={top} className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground" data-testid="logs-count">
          {current.total === 0 ? 'No logs' : `${current.total.toLocaleString('en-US')} ${current.total === 1 ? 'log' : 'logs'}`}
          {current.pageCount > 1 ? ` · page ${current.page} of ${current.pageCount}` : ''}
        </p>
        {canCreateLogs && (
          <Button onClick={() => openLogDialog()}>
            <Plus className="mr-2 h-4 w-4" />
            Add Maintenance Log
          </Button>
        )}
      </div>

      <LogList
        {...logListProps}
        logs={current.items}
        highlightedLogId={highlightedLogId}
        emptyTitle={filtered ? 'No logs match' : 'No logs yet'}
        emptyDescription={filtered ? 'Try another room, category or search.' : 'Record repairs, service and inspections here as they happen.'}
      />

      {current.pageCount > 1 && (
        <nav aria-label="Log pages" className="flex items-center justify-between gap-2">
          <Button type="button" variant="outline" disabled={!current.hasPrevious} onClick={() => go(current.page - 1)}>
            <ChevronLeft aria-hidden className="mr-1 h-4 w-4" />
            Newer
          </Button>
          <span className="text-sm text-muted-foreground">Page {current.page} of {current.pageCount} · {LOG_PAGE_SIZE} per page</span>
          <Button type="button" variant="outline" disabled={!current.hasNext} onClick={() => go(current.page + 1)}>
            Older
            <ChevronRight aria-hidden className="ml-1 h-4 w-4" />
          </Button>
        </nav>
      )}
    </TabsContent>
  );
});
