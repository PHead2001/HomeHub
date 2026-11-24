'use client';

import { Edit, Loader2, Sparkles, Trash2 } from 'lucide-react';
import type { HomeAsset, MaintenanceAttachment, MaintenanceAttachmentCategory, MaintenanceAttachmentTargetType, MaintenanceLog, Vehicle } from '@/lib/types';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { shouldOfferAiSummary } from '@/lib/maintenance/display';
import { cn } from '@/lib/utils';
import { AttachmentPanel } from './attachment-panel';
import { formatCurrency, formatDate, getAttachmentsForTarget, getLogTitle, getLogType, getTargetName } from './page-model';

export function LogList({
  logs,
  assets,
  vehicles,
  attachments,
  summaries,
  loadingSummaries,
  uploadingAttachmentTarget,
  deletingAttachmentId,
  onSummarize,
  onEdit,
  onDelete,
  onUploadAttachment,
  onDeleteAttachment,
  highlightedLogId,
  canEdit,
  canDelete,
  emptyTitle = 'No logs yet',
  emptyDescription = 'Record repairs, service and inspections here as they happen.',
}: {
  canEdit: boolean;
  canDelete: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  logs: MaintenanceLog[];
  assets: HomeAsset[];
  vehicles: Vehicle[];
  attachments: MaintenanceAttachment[];
  summaries: Record<string, string>;
  loadingSummaries: Record<string, boolean>;
  uploadingAttachmentTarget?: string | null;
  deletingAttachmentId?: string | null;
  onSummarize: (log: MaintenanceLog) => void;
  onEdit: (log: MaintenanceLog) => void;
  onDelete: (log: MaintenanceLog) => void;
  onUploadAttachment: (targetType: MaintenanceAttachmentTargetType, targetId: string, category: MaintenanceAttachmentCategory, file: File) => void;
  onDeleteAttachment: (attachment: MaintenanceAttachment) => void;
  highlightedLogId?: string | null;
}) {
  if (logs.length === 0) {
    return <EmptyState compact headingLevel={3} title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <div className="space-y-3">
      {logs.map((log) => (
        <Card
          key={log.id}
          id={`maintenance-log-${log.id}`}
          data-testid={`maintenance-log-${log.id}`}
          className={cn(highlightedLogId === log.id && 'ring-2 ring-primary')}
        >
          <CardContent className="p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-headline text-base font-semibold">{getLogTitle(log)}</h3>
                  <Badge variant="secondary">{getLogType(log)}</Badge>
                  <Badge variant="outline">{getTargetName(log, assets, vehicles)}</Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{formatDate(log.date)}</p>
              </div>
              <div className="flex items-center gap-2 self-start">
                {typeof log.cost === 'number' && (
                  <Badge variant="outline" className="w-fit">{formatCurrency(log.cost)}</Badge>
                )}
                {/* Edit and Delete are kept apart by a divider so a slip cannot hit Delete; Delete still confirms. */}
                {canEdit && (
                  <Button variant="ghost" size="icon" aria-label={`Edit maintenance log ${getLogTitle(log)}`} className="h-8 w-8" onClick={() => onEdit(log)}>
                    <Edit className="h-4 w-4" />
                  </Button>
                )}
                {canEdit && canDelete && <span aria-hidden className="mx-1 h-5 w-px bg-border" />}
                {canDelete && (
                  <Button variant="ghost" size="icon" aria-label={`Delete maintenance log ${getLogTitle(log)}`} className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => onDelete(log)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>

            {log.notes && <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">{log.notes}</p>}

            <div className="mt-3 grid gap-2 text-sm text-muted-foreground sm:grid-cols-3">
              {log.serviceProvider && <span>Provider: {log.serviceProvider}</span>}
              {log.partsUsed && <span>Parts: {log.partsUsed}</span>}
              {typeof log.mileage === 'number' && <span>Mileage: {log.mileage.toLocaleString()}</span>}
            </div>

            {summaries[log.id] && (
              <div className="mt-4 rounded-md border border-primary/20 bg-primary/10 p-3">
                <h4 className="mb-1 flex items-center gap-2 text-sm font-semibold text-primary">
                  <Sparkles className="h-4 w-4" />
                  AI Summary
                </h4>
                <p className="text-sm">{summaries[log.id]}</p>
              </div>
            )}

            {shouldOfferAiSummary(log.notes) && (
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => onSummarize(log)}
                disabled={loadingSummaries[log.id]}
              >
                {loadingSummaries[log.id] ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generating...</>
                ) : (
                  <><Sparkles className="mr-2 h-4 w-4" /> Summarize with AI</>
                )}
              </Button>
            )}

            <div className="mt-4">
              <AttachmentPanel
                title="Log Attachments"
                attachments={getAttachmentsForTarget(attachments, 'maintenance_log', log.id)}
                targetType="maintenance_log"
                targetId={log.id}
                uploading={uploadingAttachmentTarget === `maintenance_log:${log.id}`}
                deletingId={deletingAttachmentId}
                canUpload={canEdit}
                canDelete={canDelete}
                onUpload={onUploadAttachment}
                onDelete={onDeleteAttachment}
              />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
