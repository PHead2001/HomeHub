'use client';

import { useState } from 'react';
import { CalendarPlus, Copy, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { auth } from '@/lib/firebase';
import { copyText } from '@/lib/utils';
import { calendarFeedAction } from '@/app/calendar/feed-actions';

// Phone calendar sync (audit CA-25): owners and admins turn on a secret feed URL that
// phone calendars subscribe to (chores with planned repeats, maintenance, expiries and
// doses), copy it, rotate it (the old URL stops at once) or turn it off. Server:
// src/lib/server/calendar-feed.ts.

const feedUrl = (token: string) => (typeof window === 'undefined' ? '' : `${window.location.origin}/api/calendar-feed/${token}`);

export function CalendarFeedDialog({ householdId }: { householdId: string }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: 'read' | 'rotate' | 'disable') => {
    const user = auth.currentUser;
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      const result = await calendarFeedAction({ idToken: await user.getIdToken(), householdId, action });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setToken(result.data.token);
      if (action === 'rotate') toast({ title: token ? 'New calendar link made' : 'Calendar link ready', description: token ? 'The old link stopped working.' : 'Copy it into your phone calendar.' });
      if (action === 'disable') toast({ title: 'Calendar link turned off' });
    } catch {
      setError("Couldn't reach HomeHub. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const url = token ? feedUrl(token) : '';
  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next && token === undefined) void run('read'); }}>
      <DialogTrigger asChild>
        <Button variant="outline" className="min-h-[var(--target-min)]" data-testid="calendar-feed-open">
          <CalendarPlus aria-hidden className="mr-2 h-4 w-4" /> Phone calendar
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Show HomeHub in phone calendars</DialogTitle>
          <DialogDescription>
            A private link that phone calendars subscribe to: chores (with planned repeats), maintenance, expiry dates and pet doses. Anyone with the link sees the whole household calendar, so share it only with the household.
          </DialogDescription>
        </DialogHeader>
        {token === undefined ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Loading…</p>
        ) : token ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="calendar-feed-url">Calendar link</Label>
              <div className="flex gap-2">
                <Input id="calendar-feed-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
                <Button type="button" variant="outline" className="min-h-[var(--target-min)]" aria-label="Copy calendar link" onClick={() => void copyText(url).then(() => toast({ title: 'Link copied' }))}>
                  <Copy aria-hidden className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">On iPhone: Settings, Calendar, Accounts, Add Subscribed Calendar. In Google Calendar: Other calendars, From URL.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" className="min-h-[var(--target-min)]" disabled={busy} onClick={() => void run('rotate')}>
                <RefreshCw aria-hidden className="mr-2 h-4 w-4" /> Make a new link
              </Button>
              <Button type="button" variant="ghost" className="min-h-[var(--target-min)]" disabled={busy} onClick={() => void run('disable')}>Turn off</Button>
            </div>
          </div>
        ) : (
          <Button type="button" className="min-h-[var(--target-min)]" disabled={busy} onClick={() => void run('rotate')}>
            {busy && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />} Turn on the calendar link
          </Button>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
