'use client';

import * as React from 'react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useBackCloses } from '@/hooks/use-back-closes';
import { cn } from '@/lib/utils';
import { DISCARD_DESCRIPTION, DISCARD_TITLE } from '@/lib/maintenance/form-sections';

/**
 * The shell of the maintenance forms (asset, vehicle, log; MA-15, MA-24f):
 * - phones (under 640 px): a full-screen sheet sized with dynamic viewport units, its footer
 *   (Cancel, Save) a sticky row above the on-screen keyboard (`--keyboard-inset`); larger
 *   screens keep the centred dialog;
 * - an unsaved-changes guard: Cancel, Escape, the close button, a click outside and Back ask
 *   "Discard your changes?" when the form is dirty (the body reports it with `useReportDirty`);
 * - Back closes the form (the shared back stack), never while a save is in flight.
 */
const FORM_SHEET_CLASSES = [
  'flex flex-col overflow-hidden p-0',
  'max-h-[min(90vh,calc(var(--dialog-max-h)_-_var(--keyboard-inset,0px)))]',
  // Phones: full screen above the keyboard; dvh follows the browser's own bars.
  '[@media(max-width:639.98px)]:inset-x-0 [@media(max-width:639.98px)]:top-0 [@media(max-width:639.98px)]:bottom-[var(--keyboard-inset,0px)]',
  '[@media(max-width:639.98px)]:h-auto [@media(max-width:639.98px)]:max-h-none [@media(max-width:639.98px)]:max-w-none',
  '[@media(max-width:639.98px)]:translate-x-0 [@media(max-width:639.98px)]:translate-y-0 [@media(max-width:639.98px)]:left-0',
  '[@media(max-width:639.98px)]:rounded-none [@media(max-width:639.98px)]:border-0',
  '[@media(max-width:639.98px)]:min-h-[calc(100dvh_-_var(--keyboard-inset,0px))]',
  '[@media(max-width:639.98px)]:data-[state=open]:zoom-in-100 [@media(max-width:639.98px)]:data-[state=closed]:zoom-out-100',
  '[@media(max-width:639.98px)]:data-[state=open]:slide-in-from-left-0 [@media(max-width:639.98px)]:data-[state=closed]:slide-out-to-left-0',
  '[@media(max-width:639.98px)]:data-[state=open]:slide-in-from-top-0 [@media(max-width:639.98px)]:data-[state=closed]:slide-out-to-top-0',
].join(' ');

/** The footer of a form sheet: always visible (outside the scrolling body), safe-area aware. */
export const FORM_FOOTER_CLASSES = 'sticky bottom-0 z-10 border-t bg-popover px-6 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:pb-4';

type DirtyReporter = (dirty: boolean) => void;
const DirtyContext = createContext<DirtyReporter>(() => undefined);

/** A form body tells its shell whether it has unsaved changes. */
export function useReportDirty(dirty: boolean) {
  const report = useContext(DirtyContext);
  useEffect(() => { report(dirty); }, [dirty, report]);
  useEffect(() => () => report(false), [report]);
}

export const MaintenanceFormDialog = function MaintenanceFormDialog({
  open,
  busy,
  onOpenChange,
  className,
  children,
  testId,
}: {
  open: boolean;
  /** A save is in flight: the form cannot be closed (its outcome must be known first). */
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
  children: React.ReactNode;
  testId?: string;
}) {
  const dirtyRef = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const report = useCallback((dirty: boolean) => { dirtyRef.current = dirty; }, []);
  useEffect(() => { if (!open) dirtyRef.current = false; }, [open]);

  /** Every way out: true when the form closed. */
  const requestClose = useCallback(() => {
    if (busy) return false;
    setConfirming(false);
    if (dirtyRef.current) {
      setConfirming(true);
      return false;
    }
    onOpenChange(false);
    return true;
  }, [busy, onOpenChange]);

  useBackCloses(open, requestClose);

  const discard = () => {
    dirtyRef.current = false;
    setConfirming(false);
    onOpenChange(false);
  };

  return (
    <DirtyContext.Provider value={report}>
      <Dialog open={open} onOpenChange={(next) => { if (next) onOpenChange(true); else requestClose(); }}>
        <DialogContent className={cn(FORM_SHEET_CLASSES, className)} data-testid={testId} data-form-sheet="">
          <FormCloseContext.Provider value={requestClose}>{children}</FormCloseContext.Provider>
        </DialogContent>
      </Dialog>
      <AlertDialog open={open && confirming} onOpenChange={(next) => { if (!next) setConfirming(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{DISCARD_TITLE}</AlertDialogTitle>
            <AlertDialogDescription>{DISCARD_DESCRIPTION}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={discard}>
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DirtyContext.Provider>
  );
};

const FormCloseContext = createContext<() => boolean>(() => true);

/** The form's Cancel: goes through the unsaved-changes guard. */
export function useGuardedCancel() {
  return useContext(FormCloseContext);
}
