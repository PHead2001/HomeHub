'use client';

import type { ReactNode } from 'react';
import { useBackCloses } from '@/hooks/use-back-closes';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';

/**
 * The asset or vehicle detail on a phone (MA-17): a full-height sheet opened by tapping a
 * card (or a link to the record). Its top bar (name and Close) stays put while the detail scrolls. Back closes it (`useBackCloses`), except while a dialog
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
        className="flex h-[100dvh] max-h-[100dvh] flex-col gap-0 overflow-hidden rounded-none p-0"
      >
        {/* A bar that never scrolls away: the record's name and the sheet's Close (top right). */}
        <div className="flex min-h-14 shrink-0 items-center border-b px-4 pr-14">
          <SheetTitle className="min-w-0 truncate font-headline text-base">{title}</SheetTitle>
        </div>
        {description ? <SheetDescription className="sr-only">{description}</SheetDescription> : null}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
