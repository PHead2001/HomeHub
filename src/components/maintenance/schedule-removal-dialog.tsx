'use client';

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
import type { ScheduleRemovalTarget } from './page-model';

/** Confirms removing a schedule row from an asset or vehicle form (saved only with the record). */
export function ScheduleRemovalDialog({
  scheduleToRemove,
  setScheduleToRemove,
  confirmScheduleRemoval,
}: {
  scheduleToRemove: ScheduleRemovalTarget | null;
  setScheduleToRemove: (target: ScheduleRemovalTarget | null) => void;
  confirmScheduleRemoval: () => void;
}) {
  return (
    <AlertDialog open={!!scheduleToRemove} onOpenChange={(open) => !open && setScheduleToRemove(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {scheduleToRemove?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the {scheduleToRemove?.targetType === 'home_asset' ? 'asset maintenance item' : 'vehicle service item'} from this edit form. Save the record to persist the change.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={confirmScheduleRemoval}>
            Remove Item
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
