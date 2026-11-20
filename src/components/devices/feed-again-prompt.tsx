'use client';

// "Feed again?" on a wall tablet (docs/modules/devices/README.md, "Device actions: pets";
// PE-23g, D-P5), and "Already given?" for a dose (F4b-2, PE-24k). The server's check, shown
// by the shell; "Feed again" ("Record again") sends the answer back with the same opId,
// Cancel writes nothing. 48 px targets on the tablet's coarse pointer.

import { useRef } from 'react';
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
import { useBackCloses } from '@/hooks/use-back-closes';
import { usePromptTapGuard } from './use-prompt-tap-guard';

export function FeedAgainPrompt({ title, body, onAnswer, yesLabel = 'Feed again' }: { title: string; body: string; onAnswer: (yes: boolean) => void; yesLabel?: string }) {
  // One answer: the dialog's own close after "Feed again" is not a Cancel.
  const answered = useRef(false);
  const answer = (yes: boolean) => {
    if (answered.current) return;
    answered.current = true;
    onAnswer(yes);
  };
  // Android Back closes this first (emulator evidence D4).
  useBackCloses(true, () => answer(false));
  // The tap that asked never answers (the tap guard).
  const tap = usePromptTapGuard();

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) answer(false); }}>
      <AlertDialogContent data-testid="tablet-feed-again" data-tap-ready={tap.ready ? 'true' : 'false'}>
        <AlertDialogHeader>
          <AlertDialogTitle className="font-headline text-2xl">{title}</AlertDialogTitle>
          <AlertDialogDescription className="text-base">{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-12 min-w-24 text-base" onClick={(event) => { tap.allow(event); }} data-testid="tablet-feed-again-cancel">Cancel</AlertDialogCancel>
          <AlertDialogAction className="min-h-12 min-w-24 text-base" onClick={(event) => { if (tap.allow(event)) answer(true); }} data-testid="tablet-feed-again-yes">{yesLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
