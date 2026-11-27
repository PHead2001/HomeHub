'use client';

import { useMemo } from 'react';
import { Copy, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { inviteJoinUrl } from '@/lib/invite-link';
import { QR_QUIET_ZONE, qrModules, qrSvgPath } from '@/lib/qr-code';
import { copyText } from '@/lib/utils';
import type { InviteCode } from '@/lib/types';
import { roleLabel } from './household-model';

/** A QR code for `text`, drawn as SVG (black on white whatever the theme, so phones can scan it). */
export function QrCode({ text, label, className }: { text: string; label: string; className?: string }) {
  const drawing = useMemo(() => {
    const modules = qrModules(text);
    return { path: qrSvgPath(modules), side: modules.size + QR_QUIET_ZONE * 2 };
  }, [text]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${drawing.side} ${drawing.side}`}
      shapeRendering="crispEdges"
      className={className}
      data-testid="invite-qr"
    >
      <rect width={drawing.side} height={drawing.side} fill="#ffffff" />
      <path d={drawing.path} fill="#000000" />
    </svg>
  );
}

/**
 * Share an invite (HO-16, HO-23): a big QR code of the join link (a new phone scans it
 * from this screen, for example the wall tablet signed in as an adult), the system share
 * sheet where the browser has one, and Copy link. The link only pre-fills the Join form;
 * the code stays single-use and short-lived, and an owner or admin still approves.
 */
export default function InviteShareDialog({
  invite,
  onClose,
}: {
  invite: InviteCode | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const url = invite && typeof window !== 'undefined' ? inviteJoinUrl(window.location.origin, invite.code) : '';
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const household = invite?.householdName || 'our household';

  return (
    <Dialog open={Boolean(invite)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Scan to join</DialogTitle>
          <DialogDescription>
            Point the new phone&apos;s camera at the code, or share the link. It works once and expires in 30 minutes.
            {invite?.suggestedRole ? ` Suggested role: ${roleLabel(invite.suggestedRole)}; you still approve them.` : ' You still approve them.'}
          </DialogDescription>
        </DialogHeader>
        {invite && url && (
          <div className="flex flex-col items-center gap-4">
            <QrCode text={url} label={`QR code for invite ${invite.code}`} className="aspect-square w-full max-w-[18rem] rounded-md border" />
            <p className="font-code text-lg font-semibold tracking-wider" aria-label={`Invite code ${invite.code}`}>{invite.code}</p>
            <div className="flex w-full flex-col gap-2 sm:flex-row">
              {canShare && (
                <Button
                  className="flex-1"
                  onClick={async () => {
                    try {
                      await navigator.share({ title: 'Join our household on HomeHub', text: `Join ${household} on HomeHub`, url });
                    } catch {
                      // Cancelled or blocked: nothing to report.
                    }
                  }}
                >
                  <Share2 className="mr-2 h-4 w-4" aria-hidden /> Share link
                </Button>
              )}
              <Button
                variant={canShare ? 'outline' : 'default'}
                className="flex-1"
                onClick={async () => {
                  const copied = await copyText(url);
                  toast(copied ? { title: 'Link copied', description: 'Send it to the person joining.' } : { title: 'Copy not available', description: url });
                }}
              >
                <Copy className="mr-2 h-4 w-4" aria-hidden /> Copy link
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
