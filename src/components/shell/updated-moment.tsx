'use client';

import { useEffect, useState } from 'react';
import { toast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { LAST_BUILD_KEY, decideUpdatedMoment, type UpdatedMoment as UpdatedMomentDecision, type WhatsNewEntry } from '@/lib/shell/whats-new';

const PAGE_BUILD_ID = process.env.NEXT_PUBLIC_HOMEHUB_BUILD_ID;
// Once per page, also when an effect runs twice (development's Strict Mode).
let toastedThisPage = false;

const dayLabel = (date: string) => {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(undefined, { month: 'long', day: 'numeric', timeZone: 'UTC' });
};

function readMoment(): UpdatedMomentDecision {
  if (!PAGE_BUILD_ID) return { show: false };
  try {
    return decideUpdatedMoment({ previousBuild: window.localStorage.getItem(LAST_BUILD_KEY), currentBuild: PAGE_BUILD_ID });
  } catch {
    return { show: false }; // Blocked storage: nothing to compare with, say nothing.
  }
}

/**
 * SL-24: once per new build in this browser, "HomeHub updated" with the newest change.
 * Personal accounts get a **What's new** button that opens the list in a dialog (no
 * route, so it also works where routes are limited); registered tablets
 * (`tablet`) get the one-line toast only. The toast never holds the shell busy
 * (`holdsAction: false`), so it never delays a tablet's idle reload.
 */
export function UpdatedMoment({ tablet = false }: { tablet?: boolean }) {
  // Mounted on the client only (a dynamic import without SSR), so storage is readable here.
  const [moment] = useState(readMoment);
  const [open, setOpen] = useState(false);
  const entries: WhatsNewEntry[] | null = moment.show ? moment.entries : null;

  useEffect(() => {
    if (!PAGE_BUILD_ID) return;
    try {
      const previous = window.localStorage.getItem(LAST_BUILD_KEY);
      if (!previous || previous < PAGE_BUILD_ID) window.localStorage.setItem(LAST_BUILD_KEY, PAGE_BUILD_ID);
    } catch {
      // Blocked storage: nothing to remember.
    }
    if (!moment.show || toastedThisPage) return;
    toastedThisPage = true;
    toast({
      title: 'HomeHub updated',
      description: moment.headline,
      holdsAction: false,
      duration: 10_000,
      action: tablet ? undefined : (
        <ToastAction altText="See what's new in HomeHub" onClick={() => setOpen(true)}>
          What&apos;s new
        </ToastAction>
      ),
    });
  }, [moment, tablet]);

  if (tablet || !entries) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md" data-testid="whats-new">
        <DialogHeader>
          <DialogTitle>What&apos;s new in HomeHub</DialogTitle>
          <DialogDescription>Changes since you last opened HomeHub here.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {entries.map((entry) => (
            <section key={entry.date}>
              <h3 className="text-sm font-semibold">{dayLabel(entry.date)}</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {entry.items.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
