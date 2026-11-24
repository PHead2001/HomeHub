'use client';

import * as React from 'react';
import { BrandLogo } from '@/components/brand/brand-logo';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { costSummary } from '@/lib/maintenance/costs';
import type { HealthResult } from '@/lib/maintenance/health';
import { serviceHistoryLine } from '@/lib/maintenance/history-line';
import { scheduleRef, type StoredSchedule } from '@/lib/maintenance/operations';
import { getAssetScheduleMode, scheduleKeyFor, type ScheduleCompletionTarget } from '@/lib/maintenance/schedules';
import { warrantyClaimChecklist } from '@/lib/maintenance/warranty-claim';
import type { MaintenanceAttachment, MaintenanceAttachmentCategory, MaintenanceAttachmentTargetType } from '@/lib/types';
import { AttachmentPanel } from './attachment-panel';
import { CostSummary } from './cost-summary';
import { DetailActions, assetFields, missingCount } from './detail-panel';
import { DetailSection, LabelSection, ScheduleRow, useScrollToSchedule } from './detail-parts';
import { HealthRing } from './health-ring';
import { LogList } from './log-list';
import { DetailGrid } from './page-parts';
import { formatDate, getAttachmentsForTarget, type LogPreset } from './page-model';
import type { HomeAsset, LogListShared, MaintenanceLog } from './tab-types';
import { WarrantyClaimChecklist } from './warranty-claim-checklist';

export type AssetDetailProps = {
  asset: HomeAsset;
  attachments: MaintenanceAttachment[];
  health?: HealthResult;
  today: string;
  timeZone: string;
  /** The asset's linked logs, newest first. */
  logs: MaintenanceLog[];
  highlightedScheduleKey: string | null;
  canEdit: boolean;
  canDelete: boolean;
  canComplete: boolean;
  canCreateLogs: boolean;
  uploadingAttachmentTarget: string | null;
  deletingAttachmentId: string | null;
  logListProps: LogListShared;
  openAssetDialog: (asset?: HomeAsset) => void;
  setAssetToDelete: (asset: HomeAsset) => void;
  uploadAttachment: (targetType: MaintenanceAttachmentTargetType, targetId: string, category: MaintenanceAttachmentCategory, file: File) => void;
  setAttachmentToDelete: (attachment: MaintenanceAttachment) => void;
  openScheduleCompletionDialog: (target: ScheduleCompletionTarget) => void;
  openLogDialog: (preset?: LogPreset) => void;
  /** The card -> detail morph's style (wide layout only). */
  style?: React.CSSProperties;
  className?: string;
};

const hasWarranty = (asset: HomeAsset) => Boolean(asset.warrantyExpiration || asset.warrantyLifetime || asset.warrantyProvider);

/**
 * One home asset's detail (rendered once: the sticky column on wide screens, the sheet on a
 * phone): health, the service history line, fields, actions and Print label, schedules with
 * their history lines, costs (MA-28), the warranty claim checklist (MA-33c), files and the
 * linked logs.
 */
export const AssetDetail = React.memo(function AssetDetail({
  asset, attachments, health, today, timeZone, logs, highlightedScheduleKey, canEdit, canDelete, canComplete, canCreateLogs,
  uploadingAttachmentTarget, deletingAttachmentId, logListProps, openAssetDialog, setAssetToDelete, uploadAttachment,
  setAttachmentToDelete, openScheduleCompletionDialog, openLogDialog, style, className,
}: AssetDetailProps) {
  const target = React.useMemo(() => ({ type: 'home_asset' as const, id: asset.id }), [asset.id]);
  const fields = assetFields(asset);
  const history = React.useMemo(() => serviceHistoryLine(logs, target, { today, timeZone }), [logs, target, today, timeZone]);
  const costs = React.useMemo(() => costSummary(asset, 'home_asset', logs, timeZone), [asset, logs, timeZone]);
  const claim = React.useMemo(() => (hasWarranty(asset) ? warrantyClaimChecklist(asset, attachments, today) : null), [asset, attachments, today]);
  const schedules = asset.schedules ?? [];
  const highlightedHere = schedules.some((schedule, index) => scheduleKeyFor(asset.id, schedule, index, 'home_asset') === highlightedScheduleKey);
  useScrollToSchedule(highlightedScheduleKey, highlightedHere);

  return (
    <Card className={className} data-testid="asset-detail" style={style}>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        {/* The brand is listed as text in the details below, so the mark is decorative. */}
        <BrandLogo brand={asset.brand} size="md" decorative className="text-primary" />
        <div className="min-w-0 flex-1">
          <CardTitle className="break-words font-headline [overflow-wrap:anywhere]">{asset.name}</CardTitle>
          <CardDescription>{asset.category}</CardDescription>
          {history && <p className="mt-1 text-sm text-muted-foreground" data-testid="detail-history">{history}</p>}
        </div>
        {health && <HealthRing score={health.score} band={health.band} label={`${asset.name} health`} />}
      </CardHeader>
      <CardContent className="space-y-5">
        <DetailGrid fields={fields} />
        {asset.notes && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{asset.notes}</p>}
        <DetailActions
          name={asset.name}
          kind="home asset"
          missing={missingCount(fields)}
          canEdit={canEdit}
          canDelete={canDelete}
          onEdit={() => openAssetDialog(asset)}
          onDelete={() => setAssetToDelete(asset)}
        />
        <LabelSection target={target} name={asset.name} location={asset.location} />
        {schedules.length > 0 && (
          <DetailSection title="Scheduled maintenance">
            {schedules.map((schedule, index) => {
              const key = scheduleKeyFor(asset.id, schedule, index, 'home_asset');
              const name = schedule.scheduleName || 'Scheduled maintenance';
              const checklist = getAssetScheduleMode(schedule) === 'checklist';
              const ids = [schedule.id, scheduleRef(schedule as StoredSchedule, index, 'home_asset')];
              return (
                <ScheduleRow
                  key={`${schedule.id ?? schedule.scheduleName}-${index}`}
                  scheduleKey={key}
                  testId={`asset-schedule-${schedule.id || index}`}
                  highlighted={highlightedScheduleKey === key}
                  name={name}
                  checklist={checklist}
                  dueLine={schedule.nextDueDate ? `Next due ${formatDate(schedule.nextDueDate)}` : 'Next date will be set when completed'}
                  repeatLine={schedule.frequencyType && schedule.intervalValue ? `Every ${schedule.intervalValue} ${schedule.frequencyType}` : undefined}
                  historyLine={serviceHistoryLine(logs, target, { today, timeZone, scheduleName: name, scheduleIds: ids })}
                  onComplete={canComplete && !checklist
                    ? () => openScheduleCompletionDialog({ targetType: 'home_asset', asset, scheduleIndex: index, schedule })
                    : undefined}
                  onAddDueDate={canEdit ? () => openAssetDialog(asset) : undefined}
                />
              );
            })}
          </DetailSection>
        )}
        <DetailSection title="Costs" testId="asset-costs">
          <CostSummary summary={costs} name={asset.name} />
        </DetailSection>
        {claim && <WarrantyClaimChecklist checklist={claim} />}
        <AttachmentPanel
          attachments={getAttachmentsForTarget(attachments, 'home_asset', asset.id)}
          targetType="home_asset"
          targetId={asset.id}
          uploading={uploadingAttachmentTarget === `home_asset:${asset.id}`}
          deletingId={deletingAttachmentId}
          canUpload={canEdit}
          canDelete={canDelete}
          onUpload={uploadAttachment}
          onDelete={setAttachmentToDelete}
        />
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-headline font-semibold">Linked logs</h3>
          {canCreateLogs && (
            <Button variant="outline" size="sm" onClick={() => openLogDialog({ targetType: 'home_asset', assetId: asset.id })}>
              Add Log
            </Button>
          )}
        </div>
        <LogList
          {...logListProps}
          logs={logs}
          emptyTitle="No logs for this asset"
          emptyDescription="Repairs, service and inspections for it will show up here."
        />
      </CardContent>
    </Card>
  );
});
