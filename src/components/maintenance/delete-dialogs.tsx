'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { HomeAsset, MaintenanceAttachment, MaintenanceLog, Vehicle } from '@/lib/types';
import { getLogTitle } from './page-model';

/** The page's delete confirmations: attachment, home asset, log and vehicle. */
export const DeleteDialogs = React.memo(function DeleteDialogs({
  attachmentToDelete, setAttachmentToDelete, deleteAttachment, deletingAttachmentId,
  assetToDelete, setAssetToDelete, deleteAsset,
  logToDelete, setLogToDelete, deleteLog,
  vehicleToDelete, setVehicleToDelete, deleteVehicle,
  deletingRecord,
}: {
  attachmentToDelete: MaintenanceAttachment | null;
  setAttachmentToDelete: (attachment: MaintenanceAttachment | null) => void;
  deleteAttachment: (attachment: MaintenanceAttachment) => Promise<void>;
  deletingAttachmentId: string | null;
  assetToDelete: HomeAsset | null;
  setAssetToDelete: (asset: HomeAsset | null) => void;
  deleteAsset: () => Promise<void>;
  logToDelete: MaintenanceLog | null;
  setLogToDelete: (log: MaintenanceLog | null) => void;
  deleteLog: () => Promise<void>;
  vehicleToDelete: Vehicle | null;
  setVehicleToDelete: (vehicle: Vehicle | null) => void;
  deleteVehicle: () => Promise<void>;
  /** `{kind}:{id}` of the record being deleted. */
  deletingRecord: string | null;
}) {
  return (
    <>
    <AlertDialog open={!!attachmentToDelete} onOpenChange={(open) => !open && setAttachmentToDelete(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete attachment {attachmentToDelete?.fileName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes the file and its maintenance attachment record. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={Boolean(deletingAttachmentId)}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={Boolean(deletingAttachmentId)}
            onClick={() => attachmentToDelete && void deleteAttachment(attachmentToDelete)}
          >
            {deletingAttachmentId && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Delete Attachment
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={!!assetToDelete} onOpenChange={(open) => !open && setAssetToDelete(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete home asset {assetToDelete?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the asset and its schedules. Historical logs remain as general maintenance records, and active reminders for this asset are resolved. Remove direct attachments first.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={Boolean(deletingRecord)}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={Boolean(deletingRecord)}
            onClick={() => void deleteAsset()}
          >
            {deletingRecord?.startsWith('home_asset:') && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Delete Home Asset
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={!!logToDelete} onOpenChange={(open) => !open && setLogToDelete(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete maintenance log?</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete &quot;{logToDelete ? getLogTitle(logToDelete) : 'this log'}&quot;. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={Boolean(deletingRecord)}
            onClick={deleteLog}
          >
            {deletingRecord?.startsWith('log:') && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Delete Log
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={!!vehicleToDelete} onOpenChange={(open) => !open && setVehicleToDelete(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete vehicle?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes &quot;{vehicleToDelete?.nickname || 'this vehicle'}&quot; and its schedules. Historical service logs remain as general maintenance records, and active reminders for this vehicle are resolved. Remove direct attachments first.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={Boolean(deletingRecord)}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={Boolean(deletingRecord)}
            onClick={deleteVehicle}
          >
            {deletingRecord?.startsWith('vehicle:') && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Delete Vehicle
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
});
