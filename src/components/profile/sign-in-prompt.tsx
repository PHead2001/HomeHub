'use client';

import { LogIn } from 'lucide-react';
import { LoginDialog } from '@/components/login-dialog';
import { EmptyStateIllustration } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Shown on a signed-in-only page to a signed-out visitor: what the page is for and
 * a real Sign in button (opens the Google sign-in dialog), instead of a dead-end
 * "Please log in" line. Other modules can adopt it for their own pages.
 *
 *   {!currentUser && <SignInPrompt what="manage your chores" />}
 */
export function SignInPrompt({ what }: { what: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <EmptyStateIllustration kind="generic" className="h-24 w-[7.5rem]" />
        <h2 className="font-headline text-lg font-semibold">Sign in to {what}</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          HomeHub keeps your household&apos;s chores, lists, pets and home in one place. Sign in with your Google account to continue.
        </p>
        <LoginDialog>
          <Button className="mt-1">
            <LogIn className="mr-2 h-4 w-4" />
            Sign in
          </Button>
        </LoginDialog>
      </CardContent>
    </Card>
  );
}
