'use client';

import { useState } from 'react';
import { ChevronDown, Edit, ExternalLink, Loader2, Paperclip, Sparkles, Trash2 } from 'lucide-react';
import type { HomeAsset, MaintenanceAttachment, MaintenanceAttachmentCategory, MaintenanceAttachmentTargetType, MaintenanceLog, Vehicle } from '@/lib/types';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { doneByLine, legacyReceiptHref, logDateLabel, shouldOfferAiSummary } from '@/lib/maintenance/display';
import { storedSummaryOf } from '@/lib/maintenance/summary';
import { cn } from '@/lib/utils';
import { AttachmentPanel } from './attachment-panel';
import { formatCurrency, getAttachmentsForTarget, getLogTitle, getLogType, getTargetName } from './page-model';

/**
 * Maintenance logs. Each row shows the title, type, what it belongs to, the date ("Undated"
 * when it has none, MA-11e), who did it ("Done by Sam", MA-20), cost, provider, parts,
 * mileage, notes and an older log's receipt link. Files are not loaded per row (MA-21): a
 * row's "Files" button opens the log to show and upload them; a highlighted (linked) log
 * opens by itself.
 */
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
  /** `regenerate`: a new summary even though the stored one is current (MA-11d). */
  onSummarize: (log: MaintenanceLog, regenerate?: boolean) => void;
  onEdit: (log: MaintenanceLog) => void;
  onDelete: (log: MaintenanceLog) => void;
  onUploadAttachment: (targetType: MaintenanceAttachmentTargetType, targetId: string, category: MaintenanceAttachmentCategory, file: File) => void;
  onDeleteAttachment: (attachment: MaintenanceAttachment) => void;
  highlightedLogId?: string | null;
}) {
  // Logs opened to show their files. A linked log is open without being asked.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());

  if (logs.length === 0) {
    return <EmptyState compact headingLevel={3} title={emptyTitle} description={emptyDescription} />;
  }

  const toggle = (id: string) => setOpened((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <div className="space-y-3">
      {logs.map((log) => {
        const title = getLogTitle(log);
        const files = getAttachmentsForTarget(attachments, 'maintenance_log', log.id);
        const open = opened.has(log.id) !== (highlightedLogId === log.id);
        const doneBy = doneByLine(log);
        const receipt = legacyReceiptHref(log.receiptUrl);
        const panelId = `maintenance-log-files-${log.id}`;
        // MA-11d: the summary stored on the log while its notes are unchanged, else this session's.
        const stored = storedSummaryOf(log);
        const summary = stored.state === 'current' ? stored.summary : summaries[log.id];
        const staleSummary = !summary && stored.state === 'stale' ? stored.summary : null;
        return (
          <Card
            key={log.id}
            id={`maintenance-log-${log.id}`}
            data-testid={`maintenance-log-${log.id}`}
            className={cn(highlightedLogId === log.id && 'ring-2 ring-primary')}
          >
            <CardContent className="p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="min-w-0 break-words font-headline text-base font-semibold [overflow-wrap:anywhere]">{title}</h3>
                    <Badge variant="secondary">{getLogType(log)}</Badge>
                    <Badge variant="outline" className="max-w-full break-words [overflow-wrap:anywhere]">{getTargetName(log, assets, vehicles)}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {logDateLabel(log.date)}
                    {doneBy && <span data-testid="log-done-by"> · {doneBy}</span>}
                  </p>
                </div>
                <div className="flex items-center gap-2 self-start">
                  {typeof log.cost === 'number' && (
                    <Badge variant="outline" className="w-fit">{formatCurrency(log.cost)}</Badge>
                  )}
                  {/* Edit and Delete are kept apart by a divider so a slip cannot hit Delete; Delete still confirms. */}
                  {canEdit && (
                    <Button variant="ghost" size="icon" aria-label={`Edit maintenance log ${title}`} className="h-8 w-8" onClick={() => onEdit(log)}>
                      <Edit className="h-4 w-4" />
                    </Button>
                  )}
                  {canEdit && canDelete && <span aria-hidden className="mx-1 h-5 w-px bg-border" />}
                  {canDelete && (
                    <Button variant="ghost" size="icon" aria-label={`Delete maintenance log ${title}`} className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => onDelete(log)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>

              {log.notes && <p className="mt-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">{log.notes}</p>}

              <div className="mt-3 grid gap-2 text-sm text-muted-foreground sm:grid-cols-3">
                {log.serviceProvider && <span className="break-words">Provider: {log.serviceProvider}</span>}
                {log.partsUsed && <span className="break-words">Parts: {log.partsUsed}</span>}
                {typeof log.mileage === 'number' && <span>Mileage: {log.mileage.toLocaleString()}</span>}
              </div>

              {receipt && (
                <a
                  href={receipt}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-flex min-h-[var(--target-min)] items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
                >
                  <ExternalLink aria-hidden className="h-4 w-4" />
                  Receipt (older upload)
                </a>
              )}

              {summary && (
                <div className="mt-4 rounded-md border border-primary/20 bg-primary/10 p-3" data-testid="log-ai-summary">
                  <h4 className="mb-1 flex items-center gap-2 text-sm font-semibold text-primary">
                    <Sparkles className="h-4 w-4" />
                    AI Summary
                  </h4>
                  <p className="text-sm">{summary}</p>
                </div>
              )}
              {staleSummary && (
                <div className="mt-4 rounded-md border border-dashed p-3 text-muted-foreground" data-testid="log-ai-summary-stale">
                  <p className="text-xs font-medium">Earlier summary (the notes changed since):</p>
                  <p className="text-sm">{staleSummary}</p>
                </div>
              )}

              <div className="mt-4 flex flex-wrap items-center gap-2">
                {shouldOfferAiSummary(log.notes) && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onSummarize(log, Boolean(summary))}
                    disabled={loadingSummaries[log.id]}
                    aria-label={summary && !loadingSummaries[log.id] ? `Regenerate the AI summary of ${title}` : undefined}
                  >
                    {loadingSummaries[log.id] ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generating...</>
                    ) : summary ? (
                      <><Sparkles className="mr-2 h-4 w-4" /> Regenerate</>
                    ) : (
                      <><Sparkles className="mr-2 h-4 w-4" /> Summarize with AI</>
                    )}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded={open}
                  aria-controls={open ? panelId : undefined}
                  aria-label={`Files for ${title} (${files.length})`}
                  onClick={() => toggle(log.id)}
                >
                  <Paperclip aria-hidden className="mr-2 h-4 w-4" />
                  Files ({files.length})
                  <ChevronDown aria-hidden className={cn('ml-1 h-4 w-4 transition-transform', open && 'rotate-180')} />
                </Button>
              </div>

              {open && (
                <div className="mt-3" id={panelId}>
                  <AttachmentPanel
                    title="Log files"
                    attachments={files}
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
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
