'use client';

import * as React from 'react';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/field-error';
import { deleteActionLabel } from '@/lib/maintenance/attachments';
import type { HomeAsset, MaintenanceAttachment, MaintenanceLog, Vehicle } from '@/lib/types';
import { getAttachmentsForTarget, getLogTitle } from './page-model';
import type { DeleteOutcome } from './use-maintenance-records';

type DeleteCall = () => Promise<DeleteOutcome | void>;

/**
 * One delete confirmation (MA-11a): the action keeps the dialog open with a spinner until the
 * operation answers; a failure is shown inside the dialog (Cancel and the action stay usable, so
 * it can be retried); only success closes it (the caller clears the record).
 */
function ConfirmDelete({
  open, onClose, title, description, actionLabel, busy, run, testId,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: React.ReactNode;
  actionLabel: string;
  busy: boolean;
  run: DeleteCall;
  testId: string;
}) {
  // The error belongs to one opening: closing clears it (onClose), so a new opening starts clean.
  const [error, setError] = useState('');
  const confirm = async () => {
    setError('');
    const outcome = await run();
    if (outcome && !outcome.ok) setError(outcome.message);
  };
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next && !busy) { setError(''); onClose(); } }}>
      <AlertDialogContent data-testid={testId} onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <FieldError id={`${testId}-error`} role="alert">{error}</FieldError>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          {/* A plain button: AlertDialogAction would close the dialog before the answer. */}
          <Button
            type="button"
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => void confirm()}
          >
            {busy && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
            {actionLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The page's delete confirmations: attachment, home asset, log and vehicle. A record is deleted
 * with its own files in one operation (MA-22, MA-4c); its logs stay as history and keep theirs.
 * `attachments` (optional) lets the action name how many files go with it.
 */
export const DeleteDialogs = React.memo(function DeleteDialogs({
  attachmentToDelete, setAttachmentToDelete, deleteAttachment, deletingAttachmentId,
  assetToDelete, setAssetToDelete, deleteAsset,
  logToDelete, setLogToDelete, deleteLog,
  vehicleToDelete, setVehicleToDelete, deleteVehicle,
  deletingRecord,
  attachments,
}: {
  attachmentToDelete: MaintenanceAttachment | null;
  setAttachmentToDelete: (attachment: MaintenanceAttachment | null) => void;
  deleteAttachment: (attachment: MaintenanceAttachment) => Promise<DeleteOutcome | void>;
  deletingAttachmentId: string | null;
  assetToDelete: HomeAsset | null;
  setAssetToDelete: (asset: HomeAsset | null) => void;
  deleteAsset: DeleteCall;
  logToDelete: MaintenanceLog | null;
  setLogToDelete: (log: MaintenanceLog | null) => void;
  deleteLog: DeleteCall;
  vehicleToDelete: Vehicle | null;
  setVehicleToDelete: (vehicle: Vehicle | null) => void;
  deleteVehicle: DeleteCall;
  /** `{kind}:{id}` of the record being deleted. */
  deletingRecord: string | null;
  /** All attachments (live): the confirmations count the record's own files. */
  attachments?: MaintenanceAttachment[];
}) {
  const count = (targetType: 'home_asset' | 'vehicle' | 'maintenance_log', id: string | undefined) =>
    attachments && id ? getAttachmentsForTarget(attachments, targetType, id).length : 0;
  const assetFiles = count('home_asset', assetToDelete?.id);
  const vehicleFiles = count('vehicle', vehicleToDelete?.id);
  const logFiles = count('maintenance_log', logToDelete?.id);
  const filesLine = (files: number, noun: string) => (attachments
    ? files > 0 ? ` Its ${files} ${files === 1 ? 'attachment is' : 'attachments are'} deleted with the ${noun}.` : ''
    : ` Its attachments are deleted with the ${noun}.`);
  return (
    <>
      <ConfirmDelete
        open={!!attachmentToDelete}
        onClose={() => setAttachmentToDelete(null)}
        title={`Delete attachment ${attachmentToDelete?.fileName ?? ''}?`}
        description="This permanently deletes the file and its maintenance attachment record. This action cannot be undone."
        actionLabel="Delete Attachment"
        busy={Boolean(deletingAttachmentId)}
        run={() => (attachmentToDelete ? deleteAttachment(attachmentToDelete) : Promise.resolve())}
        testId="delete-attachment-dialog"
      />
      <ConfirmDelete
        open={!!assetToDelete}
        onClose={() => setAssetToDelete(null)}
        title={`Delete home asset ${assetToDelete?.name ?? ''}?`}
        description={`This removes the asset and its schedules.${filesLine(assetFiles, 'asset')} Historical logs remain as general maintenance records and keep their files, and active reminders for this asset are resolved. This cannot be undone.`}
        actionLabel={attachments ? deleteActionLabel('home_asset', assetToDelete?.name ?? '', assetFiles) : 'Delete Home Asset'}
        busy={Boolean(deletingRecord?.startsWith('home_asset:'))}
        run={deleteAsset}
        testId="delete-asset-dialog"
      />
      <ConfirmDelete
        open={!!logToDelete}
        onClose={() => setLogToDelete(null)}
        title="Delete maintenance log?"
        description={`This will permanently delete "${logToDelete ? getLogTitle(logToDelete) : 'this log'}".${attachments ? (logFiles > 0 ? ` Its ${logFiles} ${logFiles === 1 ? 'file is' : 'files are'} deleted too.` : '') : ' Its files are deleted too.'} This cannot be undone.`}
        actionLabel={attachments ? deleteActionLabel('maintenance_log', '', logFiles) : 'Delete Log'}
        busy={Boolean(deletingRecord?.startsWith('log:'))}
        run={deleteLog}
        testId="delete-log-dialog"
      />
      <ConfirmDelete
        open={!!vehicleToDelete}
        onClose={() => setVehicleToDelete(null)}
        title="Delete vehicle?"
        description={`This removes "${vehicleToDelete?.nickname || 'this vehicle'}" and its schedules.${filesLine(vehicleFiles, 'vehicle')} Historical service logs remain as general maintenance records and keep their files, and active reminders for this vehicle are resolved. This cannot be undone.`}
        actionLabel={attachments ? deleteActionLabel('vehicle', vehicleToDelete?.nickname ?? '', vehicleFiles) : 'Delete Vehicle'}
        busy={Boolean(deletingRecord?.startsWith('vehicle:'))}
        run={deleteVehicle}
        testId="delete-vehicle-dialog"
      />
    </>
  );
});
