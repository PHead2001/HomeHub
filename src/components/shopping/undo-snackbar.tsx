'use client';

import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type SnackbarEntry = {
  key: string;
  message: string;
  note?: string;
  /** Accessible name of the Undo button ("Undo ticking Milk"); it starts with the visible "Undo". */
  undoLabel: string;
  onUndo: () => void;
  onDismiss: () => void;
};

/**
 * The shopping Undo snackbar (SH-15a, UNDO-10s, 16.3): one row per Undo group (the
 * latest tick and the latest delete), near the thumb. While a list is open it sits
 * directly above the quick-add bar (it is rendered inside the bar's sticky dock);
 * elsewhere on /shopping it floats above the phone tab bar (`floating`). The app's
 * toasts are top-placed and show one at a time, so a later "Item added" toast
 * would replace an Undo there; this keeps the Undo reachable for its whole window.
 * Buttons are 44 px (48 px on touch, D-2).
 */
export function UndoSnackbar({ entries, floating = false }: { entries: SnackbarEntry[]; floating?: boolean }) {
  return (
    <div
      aria-live="polite"
      data-testid="undo-snackbar"
      className={cn(
        'space-y-2',
        floating && 'pointer-events-none fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-40 mx-auto w-full max-w-md px-4 md:bottom-4',
      )}
    >
      {entries.map((entry) => (
        <div
          key={entry.key}
          role="status"
          className="pointer-events-auto flex items-center gap-2 rounded-xl border bg-popover py-1 pl-4 pr-1 text-popover-foreground shadow-overlay"
        >
          <div className="min-w-0 flex-1 py-1.5">
            <p className="break-words text-sm font-medium">{entry.message}</p>
            {entry.note && <p className="text-xs text-muted-foreground">{entry.note}</p>}
          </div>
          <Button
            type="button"
            variant="ghost"
            aria-label={entry.undoLabel}
            className="h-11 shrink-0 px-4 font-semibold text-primary [@media(pointer:coarse)]:h-12"
            onClick={entry.onUndo}
          >
            Undo
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Dismiss"
            className="h-11 w-11 shrink-0 text-muted-foreground [@media(pointer:coarse)]:h-12 [@media(pointer:coarse)]:w-12"
            onClick={entry.onDismiss}
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      ))}
    </div>
  );
}
