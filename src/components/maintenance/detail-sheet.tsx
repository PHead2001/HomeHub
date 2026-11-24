'use client';

import type { ReactNode } from 'react';
import { useBackCloses } from '@/hooks/use-back-closes';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';

/**
 * The asset or vehicle detail on a phone (MA-17): a full-height sheet opened by tapping a
 * card (or a link to the record). Back closes it (`useBackCloses`), except while a dialog
 * opened from it (Edit, Log, a delete confirmation) is still open: `blocked` keeps the sheet,
 * so Back never pulls the sheet away from under that dialog.
 */
export function DetailSheet({
  open,
  title,
  description,
  blocked,
  onClose,
  testId,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  /** True while a dialog over the sheet is open. */
  blocked: boolean;
  onClose: () => void;
  testId: string;
  children: ReactNode;
}) {
  useBackCloses(open, () => {
    if (blocked) return false;
    onClose();
  });
  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent
        side="bottom"
        data-testid={testId}
        className="h-[100dvh] max-h-[100dvh] gap-0 overflow-y-auto rounded-none p-0 pb-[env(safe-area-inset-bottom)]"
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        {description ? <SheetDescription className="sr-only">{description}</SheetDescription> : null}
        <div className="pt-12">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
