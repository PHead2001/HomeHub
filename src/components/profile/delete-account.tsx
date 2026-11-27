'use client';

import { useState } from 'react';
import { GoogleAuthProvider, reauthenticateWithPopup } from 'firebase/auth';
import { Loader2, Trash2 } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { auth } from '@/lib/firebase-app';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { deleteMyAccountAction } from '@/app/profile/account-actions';
import { DELETE_CONFIRMATION, DELETION_BLOCKER_COPY } from '@/lib/profile/account-data';

/**
 * PR-26: Delete my account. The UI mirrors the server: an owner is told to hand the
 * household on (or delete it) first and gets no delete button. Everyone else types
 * DELETE, confirms with Google again (the server needs a sign-in in the last five
 * minutes), and is signed out once the server has removed the account.
 */
export function DeleteAccountSection() {
  const { currentMember, household, logout } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const owner = Boolean(household && currentMember?.role === 'owner');

  const run = async () => {
    const user = auth.currentUser;
    if (!user || typed !== DELETE_CONFIRMATION) return;
    setBusy(true);
    try {
      try {
        await reauthenticateWithPopup(user, new GoogleAuthProvider());
      } catch {
        toast({ variant: 'destructive', title: 'Not deleted', description: 'Confirm with Google to delete your account.' });
        return;
      }
      const result = await deleteMyAccountAction({ idToken: await user.getIdToken(true), confirm: typed });
      if (!result.ok) {
        toast({ variant: 'destructive', title: 'Could not delete your account', description: result.message });
        return;
      }
      setOpen(false);
      toast({ title: 'Your account was deleted', description: 'You are being signed out.' });
      void logout();
    } catch {
      toast({ variant: 'destructive', title: 'Could not delete your account', description: 'We could not reach HomeHub. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-destructive/50 p-4" data-testid="delete-account">
      <p className="font-medium text-destructive">Delete my account</p>
      {owner ? (
        <p className="text-sm text-muted-foreground" data-testid="delete-account-blocked">{DELETION_BLOCKER_COPY.owner_with_members} If nobody else has an account here, delete the household instead.</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Removes your profile, photos and sign-in for good{household ? `, and takes you out of ${household.name}` : ''}. Chores you finished stay in the household&apos;s history.
          </p>
          <Button type="button" variant="destructive" className="w-full" onClick={() => { setTyped(''); setOpen(true); }}>
            <Trash2 className="mr-2 h-4 w-4" aria-hidden />
            Delete my account
          </Button>
        </>
      )}
      <AlertDialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete your account?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone. Download your data first if you want a copy. You will be asked to confirm with Google.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="delete-account-confirm">Type {DELETE_CONFIRMATION} to confirm</Label>
            <Input id="delete-account-confirm" value={typed} autoComplete="off" onChange={(event) => setTyped(event.target.value)} disabled={busy} />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep my account</AlertDialogCancel>
            <Button type="button" variant="destructive" disabled={busy || typed !== DELETE_CONFIRMATION} onClick={() => void run()}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              Delete my account
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
