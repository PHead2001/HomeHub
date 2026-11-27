'use client';

import { useState } from 'react';
import { Download, Loader2, UserRound } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { auth } from '@/lib/firebase-app';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SignOutButton } from '@/components/sign-out-confirm';
import { exportMyDataAction } from '@/app/profile/account-actions';
import { DeleteAccountSection } from '@/components/profile/delete-account';

const exportFileName = (now: Date) => `homehub-my-data-${now.toISOString().slice(0, 10)}.json`;

/**
 * Profile > Account (PR-16, PR-19, PR-26): who is signed in, shown as plain text
 * rather than a faded disabled field, Sign out with a confirmation, and Download my
 * data (a JSON file built on the server for the signed-in person only).
 */
export function AccountCard() {
  const { currentUser } = useAuth();
  const { toast } = useToast();
  const [exporting, setExporting] = useState(false);
  if (!currentUser) return null;

  const download = async () => {
    const user = auth.currentUser;
    if (!user) return;
    setExporting(true);
    try {
      const result = await exportMyDataAction({ idToken: await user.getIdToken() });
      if (!result.ok) {
        toast({ variant: 'destructive', title: 'Could not export your data', description: result.message });
        return;
      }
      const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = exportFileName(new Date());
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast({ title: 'Your data is downloading', description: 'A JSON file with your profile, membership, chores and notifications.' });
    } catch {
      toast({ variant: 'destructive', title: 'Could not export your data', description: 'We could not reach HomeHub. Try again.' });
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card data-testid="account-card">
      <CardHeader>
        <CardTitle as="h2" className="font-headline flex items-center gap-2"><UserRound aria-hidden /> Account</CardTitle>
        <CardDescription>Your sign-in and your data.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="break-words text-sm">
          Signed in with Google as <span className="font-medium">{currentUser.email}</span>
        </p>
        <SignOutButton className="w-full" />
        <Button type="button" variant="outline" className="w-full" disabled={exporting} onClick={() => void download()} data-testid="export-my-data">
          {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Download className="mr-2 h-4 w-4" aria-hidden />}
          Download my data
        </Button>
        <DeleteAccountSection />
      </CardContent>
    </Card>
  );
}
