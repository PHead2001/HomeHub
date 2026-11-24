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
import { pickVehiclePhoto } from '@/lib/maintenance/display';
import { healthKey, type HealthResult } from '@/lib/maintenance/health';
import { getVehicleScheduleMode, scheduleKeyFor, type ScheduleCompletionTarget } from '@/lib/maintenance/schedules';
import { morphStyle, sharedId } from '@/lib/motion';
import type { MaintenanceAttachment, MaintenanceAttachmentCategory, MaintenanceAttachmentTargetType } from '@/lib/types';
import { cn, stableSlugify } from '@/lib/utils';
import { AttachmentPanel } from './attachment-panel';
import { DetailActions, missingCount, vehicleFields } from './detail-panel';
import { HealthRing } from './health-ring';
import { LogList } from './log-list';
import { DetailGrid } from './page-parts';
import { formatDate, getAttachmentsForTarget, humanizeLabel, type LogPreset } from './page-model';
import type { HealthTargets, LogListShared, MaintenanceLog, Vehicle } from './tab-types';
import { VehicleCard } from './vehicle-card';

type VehiclesTabProps = {
  vehicles: Vehicle[];
  activeVehicles: Vehicle[];
  inactiveVehicles: Vehicle[];
  attachments: MaintenanceAttachment[];
  health: { targets: HealthTargets };
  selectedVehicle: Vehicle | null;
  vehicleLogs: MaintenanceLog[];
  highlightedScheduleKey: string | null;
  detailMorph: ReturnType<typeof useInPageMorph>;
  showInactiveVehicles: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canComplete: boolean;
  canCreateLogs: boolean;
  uploadingAttachmentTarget: string | null;
  deletingAttachmentId: string | null;
  logListProps: LogListShared;
  setShowInactiveVehicles: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectedVehicleId: (id: string) => void;
  openVehicleDialog: (vehicle?: Vehicle) => void;
  setVehicleToDelete: (vehicle: Vehicle) => void;
  uploadAttachment: (targetType: MaintenanceAttachmentTargetType, targetId: string, category: MaintenanceAttachmentCategory, file: File) => void;
  setAttachmentToDelete: (attachment: MaintenanceAttachment) => void;
  openScheduleCompletionDialog: (target: ScheduleCompletionTarget) => void;
  openLogDialog: (preset?: LogPreset) => void;
};

/** Vehicles: active cards, the sold/retired group and the selected vehicle's detail panel. */
export const VehiclesTab = React.memo(function VehiclesTab({
  vehicles, activeVehicles, inactiveVehicles, attachments, health, selectedVehicle, vehicleLogs, highlightedScheduleKey, detailMorph,
  showInactiveVehicles, canEdit, canDelete, canComplete, canCreateLogs, uploadingAttachmentTarget, deletingAttachmentId, logListProps,
  setShowInactiveVehicles, setSelectedVehicleId, openVehicleDialog, setVehicleToDelete, uploadAttachment, setAttachmentToDelete,
  openScheduleCompletionDialog, openLogDialog,
}: VehiclesTabProps) {
  const healthFor = (targetType: 'home_asset' | 'vehicle', id: string): HealthResult | undefined => health.targets[healthKey(targetType, id)];
  const detailActions = (props: Omit<React.ComponentProps<typeof DetailActions>, 'canEdit' | 'canDelete'>) => (
    <DetailActions canEdit={canEdit} canDelete={canDelete} {...props} />
  );

  const renderVehicleCard = (vehicle: Vehicle, inactive: boolean) => {
    const morph = sharedId('vehicle', vehicle.id);
    const selected = selectedVehicle?.id === vehicle.id;
    return (
      <VehicleCard
        vehicle={vehicle}
        photo={pickVehiclePhoto(attachments, vehicle.id)}
        health={healthFor('vehicle', vehicle.id)}
        selected={selected}
        inactive={inactive}
        statusLabel={inactive ? humanizeLabel(vehicle.status) : undefined}
        style={morphStyle(detailMorph.morphName === morph && !selected ? morph : null)}
        onSelect={(event) => {
          if (selected) return;
          detailMorph.run(morph, () => setSelectedVehicleId(vehicle.id), { sync: true, event });
        }}
      />
    );
  };

  return (
    <TabsContent value="vehicles" className="space-y-4 pt-4">
      {canEdit && vehicles.length > 0 && (
        <div className="flex justify-end">
          <Button onClick={() => openVehicleDialog()}>
            <Plus className="mr-2 h-4 w-4" />
            Add Vehicle
          </Button>
        </div>
      )}

      {vehicles.length === 0 ? (
        <EmptyState
          kind="assets"
          title="No vehicles yet"
          description="Add household vehicles to track mileage, key dates and service."
          action={canEdit ? { label: 'Add Vehicle', icon: <Plus className="h-4 w-4" />, onClick: () => openVehicleDialog() } : undefined}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
          <div className="space-y-4">
            {activeVehicles.length > 0 ? (
              <Stagger className="grid content-start gap-3 sm:grid-cols-2">
                {activeVehicles.map((vehicle) => (
                  <StaggerItem key={vehicle.id} className="flex">
                    {renderVehicleCard(vehicle, false)}
                  </StaggerItem>
                ))}
              </Stagger>
            ) : (
              <EmptyState compact headingLevel={3} title="No active vehicles" description="Sold and retired vehicles are kept out of the main vehicle list." />
            )}

            {inactiveVehicles.length > 0 && (
              <div className="rounded-lg border p-3">
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full justify-between px-2"
                  aria-expanded={showInactiveVehicles}
                  onClick={() => setShowInactiveVehicles(prev => !prev)}
                >
                  <span>Sold / retired vehicles ({inactiveVehicles.length})</span>
                  <span className="text-xs text-muted-foreground">{showInactiveVehicles ? 'Hide' : 'Show'}</span>
                </Button>
                {showInactiveVehicles && (
                  <div className="mt-3 grid content-start gap-3 sm:grid-cols-2">
                    {inactiveVehicles.map((vehicle) => (
                      <div key={vehicle.id} className="flex">{renderVehicleCard(vehicle, true)}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {selectedVehicle && (
            <Card className="min-w-0" data-testid="vehicle-detail" style={morphStyle(detailMorph.morphName === sharedId('vehicle', selectedVehicle.id) ? sharedId('vehicle', selectedVehicle.id) : null)}>
              <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                {/* The make is part of the description below, so the mark is decorative. */}
                <BrandLogo brand={selectedVehicle.make} size="md" decorative className="text-primary" />
                <div className="min-w-0 flex-1">
                  <CardTitle className="font-headline">{selectedVehicle.nickname}</CardTitle>
                  <CardDescription>{[selectedVehicle.year, selectedVehicle.make, selectedVehicle.model, selectedVehicle.trim].filter(Boolean).join(' ') || 'Vehicle details'}</CardDescription>
                </div>
                {healthFor('vehicle', selectedVehicle.id) && (
                  <HealthRing
                    score={healthFor('vehicle', selectedVehicle.id)!.score}
                    band={healthFor('vehicle', selectedVehicle.id)!.band}
                    label={`${selectedVehicle.nickname} health`}
                  />
                )}
              </CardHeader>
              <CardContent className="space-y-5">
                <DetailGrid fields={vehicleFields(selectedVehicle)} />
                {selectedVehicle.notes && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{selectedVehicle.notes}</p>}
                {detailActions({
                  name: selectedVehicle.nickname,
                  kind: 'vehicle',
                  missing: missingCount(vehicleFields(selectedVehicle)),
                  onEdit: () => openVehicleDialog(selectedVehicle),
                  onDelete: () => setVehicleToDelete(selectedVehicle),
                })}
                <AttachmentPanel
                  attachments={getAttachmentsForTarget(attachments, 'vehicle', selectedVehicle.id)}
                  targetType="vehicle"
                  targetId={selectedVehicle.id}
                  uploading={uploadingAttachmentTarget === `vehicle:${selectedVehicle.id}`}
                  deletingId={deletingAttachmentId}
                  canUpload={canEdit}
                  canDelete={canDelete}
                  onUpload={uploadAttachment}
                  onDelete={setAttachmentToDelete}
                />
                {selectedVehicle.serviceSchedules && selectedVehicle.serviceSchedules.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="font-headline font-semibold">Scheduled Maintenance</h3>
                    {selectedVehicle.serviceSchedules.map((schedule, index) => {
                      const key = scheduleKeyFor(selectedVehicle.id, schedule, index, 'vehicle');
                      return (
                        <div
                          key={`${schedule.serviceName}-${index}`}
                          id={`maintenance-schedule-${stableSlugify(key)}`}
                          data-testid={`vehicle-schedule-${schedule.id || index}`}
                          className={cn('rounded-lg border p-3', highlightedScheduleKey === key && 'ring-2 ring-primary')}
                        >
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <p className="text-sm font-medium">{schedule.serviceName || 'Scheduled maintenance'}</p>
                              {getVehicleScheduleMode(schedule) === 'checklist' ? (
                                <p className="text-sm text-muted-foreground">Unscheduled checklist item</p>
                              ) : (
                                <>
                                  <p className="text-sm text-muted-foreground">
                                    {schedule.nextDueDate ? `Next due ${formatDate(schedule.nextDueDate)}` : 'No next date set'}
                                    {typeof schedule.nextDueMileage === 'number' ? `${schedule.nextDueDate ? ' or ' : 'Next due '}${schedule.nextDueMileage.toLocaleString()} miles` : ''}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {schedule.intervalMiles ? `Every ${schedule.intervalMiles.toLocaleString()} miles` : ''}
                                    {schedule.intervalMiles && schedule.intervalMonths ? ' / ' : ''}
                                    {schedule.intervalMonths ? `Every ${schedule.intervalMonths} months` : ''}
                                  </p>
                                </>
                              )}
                            </div>
                            {canComplete && getVehicleScheduleMode(schedule) === 'scheduled' && <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => openScheduleCompletionDialog({
                                targetType: 'vehicle',
                                vehicle: selectedVehicle,
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
                  <h3 className="font-headline font-semibold">Service Logs</h3>
                  {canCreateLogs && (
                    <Button variant="outline" size="sm" onClick={() => openLogDialog({ targetType: 'vehicle', vehicleId: selectedVehicle.id })}>
                      Add Log
                    </Button>
                  )}
                </div>
                <LogList
                  {...logListProps}
                  logs={vehicleLogs}
                  emptyTitle="No service logs yet"
                  emptyDescription="Oil changes, repairs and inspections for this vehicle will show up here."
                />
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </TabsContent>
  );
});
