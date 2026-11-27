'use client';

import { useState, type ReactNode } from 'react';
import { Loader2, LogOut } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
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

/** The confirmation's wording, shared by every way to sign out (SL-6). */
export const SIGN_OUT_CONFIRM = {
  title: 'Sign out on this device?',
  description: "Changes still waiting to sync are sent first. To sign back in you'll need your Google account.",
  cancel: 'Stay signed in',
  confirm: 'Sign out',
} as const;

/**
 * The sign-out confirmation as a controlled dialog (SL-6, PR-16, PR-26). Signing back
 * in needs the person's Google account, so a mis-tap never signs a shared screen out
 * on its own. Used by the header's account menu, which opens it from a menu item:
 * the dialog is rendered outside the menu, because the menu unmounts on select.
 */
export function SignOutConfirmDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { logout } = useAuth();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="sign-out-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{SIGN_OUT_CONFIRM.title}</AlertDialogTitle>
          <AlertDialogDescription>{SIGN_OUT_CONFIRM.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11 coarse:min-h-12">{SIGN_OUT_CONFIRM.cancel}</AlertDialogCancel>
          <AlertDialogAction
            className="min-h-11 coarse:min-h-12"
            onClick={() => {
              onOpenChange(false);
              void logout();
            }}
          >
            {SIGN_OUT_CONFIRM.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * A "Sign out" button that asks first (the Profile page's form of SL-6). While the
 * sign-out flushes queued writes the button shows progress and cannot be pressed again.
 */
export function SignOutButton({ children, className }: { children?: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const { logout } = useAuth();
  return (
    <>
      <Button type="button" variant="outline" className={className} disabled={signingOut} onClick={() => setOpen(true)} data-testid="profile-sign-out">
        {signingOut ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <LogOut className="mr-2 h-4 w-4" aria-hidden />}
        {signingOut ? 'Signing out…' : children ?? 'Sign out'}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{SIGN_OUT_CONFIRM.title}</AlertDialogTitle>
            <AlertDialogDescription>{SIGN_OUT_CONFIRM.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{SIGN_OUT_CONFIRM.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setOpen(false);
                setSigningOut(true);
                void Promise.resolve(logout()).finally(() => setSigningOut(false));
              }}
            >
              {SIGN_OUT_CONFIRM.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
