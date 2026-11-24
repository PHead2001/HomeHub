'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TabsContent } from '@/components/ui/tabs';
import { LogList } from './log-list';
import type { LogListShared, MaintenanceLog } from './tab-types';

/** Logs: every log, newest first, with the deep-linked one highlighted. */
export const LogsTab = React.memo(function LogsTab({
  logs, highlightedLogId, canCreateLogs, logListProps, openLogDialog,
}: {
  logs: MaintenanceLog[];
  highlightedLogId: string | null;
  canCreateLogs: boolean;
  logListProps: LogListShared;
  openLogDialog: () => void;
}) {
  return (
    <TabsContent value="logs" className="space-y-4 pt-4">
      {canCreateLogs && (
        <div className="flex justify-end">
          <Button onClick={() => openLogDialog()}>
            <Plus className="mr-2 h-4 w-4" />
            Add Maintenance Log
          </Button>
        </div>
      )}
      <LogList {...logListProps} logs={logs} highlightedLogId={highlightedLogId} />
    </TabsContent>
  );
});
