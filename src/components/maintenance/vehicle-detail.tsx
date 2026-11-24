'use client';

import * as React from 'react';
import { Loader2, RotateCw } from 'lucide-react';
import { BrandLogo } from '@/components/brand/brand-logo';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { costSummary } from '@/lib/maintenance/costs';
import type { HealthResult } from '@/lib/maintenance/health';
import { serviceHistoryLine } from '@/lib/maintenance/history-line';
import { scheduleRef, type RenewableDocument, type StoredSchedule } from '@/lib/maintenance/operations';
import { getVehicleScheduleMode, scheduleKeyFor, type ScheduleCompletionTarget } from '@/lib/maintenance/schedules';
import type { MaintenanceAttachment, MaintenanceAttachmentCategory, MaintenanceAttachmentTargetType } from '@/lib/types';
import { AttachmentPanel } from './attachment-panel';
import { CostSummary } from './cost-summary';
import { DetailActions, missingCount, vehicleFields } from './detail-panel';
import { DetailSection, LabelSection, ScheduleRow, useScrollToSchedule } from './detail-parts';
import { HealthRing } from './health-ring';
import { LogList } from './log-list';
import { UpdateMileageButton } from './update-mileage';
import { DetailGrid } from './page-parts';
import { formatDate, getAttachmentsForTarget, type LogPreset } from './page-model';
import type { LogListShared, MaintenanceLog, Vehicle } from './tab-types';

export type VehicleDetailProps = {
  vehicle: Vehicle;
  attachments: MaintenanceAttachment[];
  health?: HealthResult;
  today: string;
  timeZone: string;
  /** The vehicle's linked logs, newest first. */
  logs: MaintenanceLog[];
  highlightedScheduleKey: string | null;
  canEdit: boolean;
  canDelete: boolean;
  canComplete: boolean;
  canCreateLogs: boolean;
  uploadingAttachmentTarget: string | null;
  deletingAttachmentId: string | null;
  logListProps: LogListShared;
  /** The document being renewed right now (its button shows a spinner), or null. */
  renewing: RenewableDocument | null;
  onRenew: (vehicle: Vehicle, field: RenewableDocument) => void;
  openVehicleDialog: (vehicle?: Vehicle) => void;
  setVehicleToDelete: (vehicle: Vehicle) => void;
  uploadAttachment: (targetType: MaintenanceAttachmentTargetType, targetId: string, category: MaintenanceAttachmentCategory, file: File) => void;
  setAttachmentToDelete: (attachment: MaintenanceAttachment) => void;
  openScheduleCompletionDialog: (target: ScheduleCompletionTarget) => void;
  openLogDialog: (preset?: LogPreset) => void;
  style?: React.CSSProperties;
  className?: string;
};

const DOCUMENTS: { field: RenewableDocument; label: string }[] = [
  { field: 'registrationExpiration', label: 'Registration' },
  { field: 'inspectionExpiration', label: 'Inspection' },
];

/**
 * One vehicle's detail (the sticky column on wide screens, the sheet on a phone): health, the
 * service history line, fields, registration and inspection with "Renewed (+1 year)" (MA-33a),
 * actions and Print label, service schedules with their history lines, costs with cost per
 * mile (MA-28), files and the service logs.
 */
export const VehicleDetail = React.memo(function VehicleDetail({
  vehicle, attachments, health, today, timeZone, logs, highlightedScheduleKey, canEdit, canDelete, canComplete, canCreateLogs,
  uploadingAttachmentTarget, deletingAttachmentId, logListProps, renewing, onRenew, openVehicleDialog, setVehicleToDelete,
  uploadAttachment, setAttachmentToDelete, openScheduleCompletionDialog, openLogDialog, style, className,
}: VehicleDetailProps) {
  const target = React.useMemo(() => ({ type: 'vehicle' as const, id: vehicle.id }), [vehicle.id]);
  const fields = vehicleFields(vehicle);
  // Registration and inspection have their own block (with Renewed), so the grid leaves them out.
  const gridFields = fields.filter((field) => field.label !== 'Registration Expires' && field.label !== 'Inspection Expires');
  const history = React.useMemo(() => serviceHistoryLine(logs, target, { today, timeZone }), [logs, target, today, timeZone]);
  const costs = React.useMemo(() => costSummary(vehicle, 'vehicle', logs, timeZone), [vehicle, logs, timeZone]);
  const schedules = vehicle.serviceSchedules ?? [];
  const highlightedHere = schedules.some((schedule, index) => scheduleKeyFor(vehicle.id, schedule, index, 'vehicle') === highlightedScheduleKey);
  useScrollToSchedule(highlightedScheduleKey, highlightedHere);
  const documents = DOCUMENTS.filter((document) => canEdit || vehicle[document.field]);

  return (
    <Card className={className} data-testid="vehicle-detail" style={style}>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        {/* The make is part of the description below, so the mark is decorative. */}
        <BrandLogo brand={vehicle.make} size="md" decorative className="text-primary" />
        <div className="min-w-0 flex-1">
          <CardTitle className="break-words font-headline [overflow-wrap:anywhere]">{vehicle.nickname}</CardTitle>
          <CardDescription>{[vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' ') || 'Vehicle details'}</CardDescription>
          {history && <p className="mt-1 text-sm text-muted-foreground" data-testid="detail-history">{history}</p>}
        </div>
        {health && <HealthRing score={health.score} band={health.band} label={`${vehicle.nickname} health`} />}
      </CardHeader>
      <CardContent className="space-y-5">
        <DetailGrid fields={gridFields} />
        {vehicle.status !== 'sold' && vehicle.status !== 'retired' && (
          <DetailSection title="Mileage" testId="vehicle-mileage">
            <UpdateMileageButton vehicle={vehicle} today={today} showFreshness />
          </DetailSection>
        )}
        {documents.length > 0 && (
          <DetailSection title="Registration and inspection" testId="vehicle-documents">
            {canEdit && <p className="text-sm text-muted-foreground">Renewed moves the expiry date one year on. You can undo it for 10 seconds.</p>}
            <ul className="space-y-2">
              {documents.map(({ field, label }) => {
                const value = vehicle[field];
                const busy = renewing === field;
                return (
                  <li key={field} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
                    <span className="min-w-0 text-sm">
                      <span className="block font-medium">{label}</span>
                      <span className="block text-muted-foreground">{value ? `Expires ${formatDate(value)}` : 'No date set'}</span>
                    </span>
                    {canEdit && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={Boolean(renewing)}
                        aria-label={`Renewed (+1 year): ${label.toLowerCase()} for ${vehicle.nickname}`}
                        onClick={() => onRenew(vehicle, field)}
                      >
                        {busy ? <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" /> : <RotateCw aria-hidden className="mr-2 h-4 w-4" />}
                        Renewed (+1 year)
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </DetailSection>
        )}
        {vehicle.notes && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{vehicle.notes}</p>}
        <DetailActions
          name={vehicle.nickname}
          kind="vehicle"
          missing={missingCount(fields)}
          canEdit={canEdit}
          canDelete={canDelete}
          onEdit={() => openVehicleDialog(vehicle)}
          onDelete={() => setVehicleToDelete(vehicle)}
        />
        <LabelSection target={target} name={vehicle.nickname} />
        {schedules.length > 0 && (
          <DetailSection title="Scheduled maintenance">
            {schedules.map((schedule, index) => {
              const key = scheduleKeyFor(vehicle.id, schedule, index, 'vehicle');
              const name = schedule.serviceName || 'Scheduled maintenance';
              const checklist = getVehicleScheduleMode(schedule) === 'checklist';
              const ids = [schedule.id, scheduleRef(schedule as StoredSchedule, index, 'vehicle')];
              const mileage = typeof schedule.nextDueMileage === 'number' ? `${schedule.nextDueMileage.toLocaleString('en-US')} miles` : '';
              const due = schedule.nextDueDate
                ? `Next due ${formatDate(schedule.nextDueDate)}${mileage ? ` or at ${mileage}` : ''}`
                : mileage ? `Next due at ${mileage}` : 'No next date set';
              const repeat = [
                schedule.intervalMiles ? `Every ${schedule.intervalMiles.toLocaleString('en-US')} miles` : '',
                schedule.intervalMonths ? `Every ${schedule.intervalMonths} months` : '',
              ].filter(Boolean).join(' or ');
              return (
                <ScheduleRow
                  key={`${schedule.id ?? schedule.serviceName}-${index}`}
                  scheduleKey={key}
                  testId={`vehicle-schedule-${schedule.id || index}`}
                  highlighted={highlightedScheduleKey === key}
                  name={name}
                  checklist={checklist}
                  dueLine={due}
                  repeatLine={repeat || undefined}
                  historyLine={serviceHistoryLine(logs, target, { today, timeZone, scheduleName: name, scheduleIds: ids })}
                  onComplete={canComplete && !checklist
                    ? () => openScheduleCompletionDialog({ targetType: 'vehicle', vehicle, scheduleIndex: index, schedule })
                    : undefined}
                  onAddDueDate={canEdit ? () => openVehicleDialog(vehicle) : undefined}
                />
              );
            })}
          </DetailSection>
        )}
        <DetailSection title="Costs" testId="vehicle-costs">
          <CostSummary summary={costs} name={vehicle.nickname} />
        </DetailSection>
        <AttachmentPanel
          attachments={getAttachmentsForTarget(attachments, 'vehicle', vehicle.id)}
          targetType="vehicle"
          targetId={vehicle.id}
          uploading={uploadingAttachmentTarget === `vehicle:${vehicle.id}`}
          deletingId={deletingAttachmentId}
          canUpload={canEdit}
          canDelete={canDelete}
          onUpload={uploadAttachment}
          onDelete={setAttachmentToDelete}
        />
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-headline font-semibold">Service logs</h3>
          {canCreateLogs && (
            <Button variant="outline" size="sm" onClick={() => openLogDialog({ targetType: 'vehicle', vehicleId: vehicle.id })}>
              Add Log
            </Button>
          )}
        </div>
        <LogList
          {...logListProps}
          logs={logs}
          emptyTitle="No service logs yet"
          emptyDescription="Oil changes, repairs and inspections for this vehicle will show up here."
        />
      </CardContent>
    </Card>
  );
});
