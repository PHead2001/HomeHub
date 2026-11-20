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
import { buttonVariants } from '@/components/ui/button';

type LogType = 'feeding' | 'medication' | 'care' | 'note' | 'weight';

/** Notes and weights (P5) share the logs' delete confirmation (PE-29e) with their own wording. */
const TITLES: Partial<Record<LogType, { title: string; body: string; action: string }>> = {
  note: { title: 'Delete note?', body: 'This permanently removes the note.', action: 'Delete Note' },
  weight: { title: 'Delete weight entry?', body: 'This permanently removes the weight entry.', action: 'Delete Entry' },
};

export function PetLogDeleteAlert({
  open,
  logType,
  onCancel,
  onConfirm,
  onCloseAutoFocus,
}: {
  open: boolean;
  logType: LogType;
  onCancel: () => void;
  onConfirm: () => void;
  /** Where focus goes when the dialog closes (PE-20e). */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const copy = TITLES[logType] ?? {
    title: `Delete ${logType} log?`,
    body: `This permanently removes the ${logType} history entry.`,
    action: 'Delete Log',
  };
  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => !nextOpen && onCancel()}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>
            {copy.body} This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} onClick={onConfirm}>
            {copy.action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
