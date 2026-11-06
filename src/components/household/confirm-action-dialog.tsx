'use client';

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

export type ConfirmRequest = {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Runs on confirm; the dialog stays open (busy) until it settles. */
  onConfirm: () => Promise<unknown>;
};

/** Replaces `window.confirm` for remove, deny, transfer and leave. */
export function ConfirmActionDialog({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog open={Boolean(request)} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{request?.title}</AlertDialogTitle>
          <AlertDialogDescription>{request?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{request?.cancelLabel ?? 'Cancel'}</AlertDialogCancel>
          <Button
            variant={request?.destructive ? 'destructive' : 'default'}
            disabled={busy}
            onClick={async () => {
              if (!request) return;
              setBusy(true);
              try {
                await request.onConfirm();
              } finally {
                setBusy(false);
                onClose();
              }
            }}
          >
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {request?.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
