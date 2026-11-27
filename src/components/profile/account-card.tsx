'use client';

import { UserRound } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SignOutButton } from '@/components/sign-out-confirm';

/**
 * Profile > Account (PR-16, PR-19, PR-26): who is signed in, shown as plain text
 * rather than a faded disabled field, and Sign out with a confirmation.
 */
export function AccountCard() {
  const { currentUser } = useAuth();
  if (!currentUser) return null;
  return (
    <Card data-testid="account-card">
      <CardHeader>
        <CardTitle as="h2" className="font-headline flex items-center gap-2"><UserRound aria-hidden /> Account</CardTitle>
        <CardDescription>Your sign-in and what happens to your data.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="break-words text-sm">
          Signed in with Google as <span className="font-medium">{currentUser.email}</span>
        </p>
        <SignOutButton className="w-full" />
      </CardContent>
    </Card>
  );
}
