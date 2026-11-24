'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';
import { BrandLogo } from '@/components/brand/brand-logo';
import { EmptyState } from '@/components/empty-state';
import { Stagger, StaggerItem } from '@/components/motion/stagger';
import type { useInPageMorph } from '@/components/shopping/use-in-page-morph';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TabsContent } from '@/components/ui/tabs';
import { pickAssetPhoto } from '@/lib/maintenance/display';
import { healthKey, type HealthResult } from '@/lib/maintenance/health';
import { getAssetScheduleMode, scheduleKeyFor, type ScheduleCompletionTarget } from '@/lib/maintenance/schedules';
import { warrantyCountdown } from '@/lib/maintenance/warranty';
import { morphStyle, sharedId } from '@/lib/motion';
import type { MaintenanceAttachment, MaintenanceAttachmentCategory, MaintenanceAttachmentTargetType } from '@/lib/types';
import { cn, stableSlugify } from '@/lib/utils';
import { AssetCard } from './asset-card';
import { AttachmentPanel } from './attachment-panel';
import { DetailActions, assetFields, missingCount } from './detail-panel';
import { HealthRing } from './health-ring';
import { LogList } from './log-list';
import { DetailGrid } from './page-parts';
import { formatDate, getAttachmentsForTarget, type LogPreset } from './page-model';
import type { HealthTargets, HomeAsset, LogListShared, MaintenanceLog } from './tab-types';

type AssetsTabProps = {
  assets: HomeAsset[];
  attachments: MaintenanceAttachment[];
  health: { targets: HealthTargets };
  today: string;
  selectedAsset: HomeAsset | null;
  assetLogs: MaintenanceLog[];
  highlightedScheduleKey: string | null;
  detailMorph: ReturnType<typeof useInPageMorph>;
  canEdit: boolean;
  canDelete: boolean;
  canComplete: boolean;
  canCreateLogs: boolean;
  uploadingAttachmentTarget: string | null;
  deletingAttachmentId: string | null;
  logListProps: LogListShared;
  setSelectedAssetId: (id: string) => void;
  openAssetDialog: (asset?: HomeAsset) => void;
  setAssetToDelete: (asset: HomeAsset) => void;
  uploadAttachment: (targetType: MaintenanceAttachmentTargetType, targetId: string, category: MaintenanceAttachmentCategory, file: File) => void;
  setAttachmentToDelete: (attachment: MaintenanceAttachment) => void;
  openScheduleCompletionDialog: (target: ScheduleCompletionTarget) => void;
  openLogDialog: (preset?: LogPreset) => void;
};

/** Home Assets: the photo-first card grid and the selected asset's detail panel. */
export const AssetsTab = React.memo(function AssetsTab({
  assets, attachments, health, today, selectedAsset, assetLogs, highlightedScheduleKey, detailMorph, canEdit, canDelete, canComplete,
  canCreateLogs, uploadingAttachmentTarget, deletingAttachmentId, logListProps, setSelectedAssetId, openAssetDialog, setAssetToDelete,
  uploadAttachment, setAttachmentToDelete, openScheduleCompletionDialog, openLogDialog,
}: AssetsTabProps) {
  const healthFor = (targetType: 'home_asset' | 'vehicle', id: string): HealthResult | undefined => health.targets[healthKey(targetType, id)];
  const detailActions = (props: Omit<React.ComponentProps<typeof DetailActions>, 'canEdit' | 'canDelete'>) => (
    <DetailActions canEdit={canEdit} canDelete={canDelete} {...props} />
  );

  return (
    <TabsContent value="assets" className="space-y-4 pt-4">
      {canEdit && assets.length > 0 && (
        <div className="flex justify-end">
          <Button onClick={() => openAssetDialog()}>
            <Plus className="mr-2 h-4 w-4" />
            Add Home Asset
          </Button>
        </div>
      )}

      {assets.length === 0 ? (
        <EmptyState
          kind="assets"
          title="No home assets yet"
          description="Add HVAC, appliances, tools and other things you look after to build your registry."
          action={canEdit ? { label: 'Add Home Asset', icon: <Plus className="h-4 w-4" />, onClick: () => openAssetDialog() } : undefined}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
          {/* content-start: cards keep their own height instead of stretching to the detail panel (B7). */}
          <Stagger className="grid content-start gap-3 sm:grid-cols-2">
            {assets.map((asset) => {
              const morph = sharedId('asset', asset.id);
              const selected = selectedAsset?.id === asset.id;
              return (
                <StaggerItem key={asset.id} className="flex" style={morphStyle(detailMorph.morphName === morph && !selected ? morph : null)}>
                  <AssetCard
                    asset={asset}
                    photo={pickAssetPhoto(attachments, asset.id)}
                    health={healthFor('home_asset', asset.id)}
                    warranty={warrantyCountdown(asset, today)}
                    selected={selected}
                    onSelect={(event) => {
                      if (selected) return;
                      detailMorph.run(morph, () => setSelectedAssetId(asset.id), { sync: true, event });
                    }}
                  />
                </StaggerItem>
              );
            })}
          </Stagger>

          {selectedAsset && (
            <Card className="min-w-0" data-testid="asset-detail" style={morphStyle(detailMorph.morphName === sharedId('asset', selectedAsset.id) ? sharedId('asset', selectedAsset.id) : null)}>
              <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                {/* The brand is listed as text in the details below, so the mark is decorative. */}
                <BrandLogo brand={selectedAsset.brand} size="md" decorative className="text-primary" />
                <div className="min-w-0 flex-1">
                  <CardTitle className="font-headline">{selectedAsset.name}</CardTitle>
                  <CardDescription>{selectedAsset.category}</CardDescription>
                </div>
                {healthFor('home_asset', selectedAsset.id) && (
                  <HealthRing
                    score={healthFor('home_asset', selectedAsset.id)!.score}
                    band={healthFor('home_asset', selectedAsset.id)!.band}
                    label={`${selectedAsset.name} health`}
                  />
                )}
              </CardHeader>
              <CardContent className="space-y-5">
                <DetailGrid fields={assetFields(selectedAsset)} />
                {selectedAsset.notes && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{selectedAsset.notes}</p>}
                {detailActions({
                  name: selectedAsset.name,
                  kind: 'home asset',
                  missing: missingCount(assetFields(selectedAsset)),
                  onEdit: () => openAssetDialog(selectedAsset),
                  onDelete: () => setAssetToDelete(selectedAsset),
                })}
                <AttachmentPanel
                  attachments={getAttachmentsForTarget(attachments, 'home_asset', selectedAsset.id)}
                  targetType="home_asset"
                  targetId={selectedAsset.id}
                  uploading={uploadingAttachmentTarget === `home_asset:${selectedAsset.id}`}
                  deletingId={deletingAttachmentId}
                  canUpload={canEdit}
                  canDelete={canDelete}
                  onUpload={uploadAttachment}
                  onDelete={setAttachmentToDelete}
                />
                {selectedAsset.schedules && selectedAsset.schedules.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="font-headline font-semibold">Scheduled Maintenance</h3>
                    {selectedAsset.schedules.map((schedule, index) => {
                      const key = scheduleKeyFor(selectedAsset.id, schedule, index, 'home_asset');
                      return (
                        <div
                          key={`${schedule.scheduleName}-${index}`}
                          id={`maintenance-schedule-${stableSlugify(key)}`}
                          data-testid={`asset-schedule-${schedule.id || index}`}
                          className={cn('rounded-lg border p-3', highlightedScheduleKey === key && 'ring-2 ring-primary')}
                        >
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <p className="text-sm font-medium">{schedule.scheduleName || 'Scheduled maintenance'}</p>
                              {getAssetScheduleMode(schedule) === 'checklist' ? (
                                <p className="text-sm text-muted-foreground">Unscheduled checklist item</p>
                              ) : (
                                <>
                                  <p className="text-sm text-muted-foreground">
                                    {schedule.nextDueDate ? `Next due ${formatDate(schedule.nextDueDate)}` : 'Next date will be set when completed'}
                                  </p>
                                  {schedule.frequencyType && schedule.intervalValue && (
                                    <p className="text-xs text-muted-foreground">
                                      Every {schedule.intervalValue} {schedule.frequencyType}
                                    </p>
                                  )}
                                </>
                              )}
                            </div>
                            {canComplete && getAssetScheduleMode(schedule) === 'scheduled' && <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => openScheduleCompletionDialog({
                                targetType: 'home_asset',
                                asset: selectedAsset,
                                scheduleIndex: index,
                                schedule,
                              })}
                            >
                              Complete
                            </Button>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="flex justify-between gap-2">
                  <h3 className="font-headline font-semibold">Linked Logs</h3>
                  {canCreateLogs && (
                    <Button variant="outline" size="sm" onClick={() => openLogDialog({ targetType: 'home_asset', assetId: selectedAsset.id })}>
                      Add Log
                    </Button>
                  )}
                </div>
                <LogList
                  {...logListProps}
                  logs={assetLogs}
                  emptyTitle="No logs for this asset"
                  emptyDescription="Repairs, service and inspections for it will show up here."
                />
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </TabsContent>
  );
});
