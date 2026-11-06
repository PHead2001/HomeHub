'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, LogOut } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './ui/card';

const HOUSEHOLD_NAME_MAX = 80;

interface HouseholdManagerProps {
  children: ReactNode;
}

function CreateHouseholdForm({
  onCreate,
  isCreating,
}: {
  onCreate: (name: string) => void;
  isCreating: boolean;
}) {
  const [name, setName] = useState('');
  const trimmed = name.trim();
  return (
    <Card>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed && !isCreating) onCreate(trimmed);
        }}
      >
        <CardHeader>
          <CardTitle className="font-headline">Create a Household</CardTitle>
          <CardDescription>
            Give your household a name to get started.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Label htmlFor="householdName">Household Name</Label>
          <Input
            id="householdName"
            placeholder="e.g. The Miller Residence"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isCreating}
            maxLength={HOUSEHOLD_NAME_MAX}
            autoComplete="off"
          />
          <p className="mt-2 text-xs text-muted-foreground">
            You can rename it later. {name.length > HOUSEHOLD_NAME_MAX - 15 && `${HOUSEHOLD_NAME_MAX - name.length} characters left.`}
          </p>
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={isCreating || !trimmed}>
            {isCreating && <Loader2 className="mr-2 animate-spin" />}
            Create Household
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

// Show invite codes as XXXX-XXXX-XX while people type, with or without dashes.
const formatInviteInput = (value: string) => {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  return [compact.slice(0, 4), compact.slice(4, 8), compact.slice(8)].filter(Boolean).join('-');
};

function JoinHouseholdForm({
  onJoin,
  isJoining,
}: {
  onJoin: (code: string) => void;
  isJoining: boolean;
}) {
  const [code, setCode] = useState('');
  const complete = code.replace(/-/g, '').length === 10;
  return (
    <Card>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (complete && !isJoining) onJoin(code);
        }}
      >
        <CardHeader>
          <CardTitle className="font-headline">Join a Household</CardTitle>
          <CardDescription>
            Ask someone in the household for an invite code. Codes last 30 minutes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Label htmlFor="inviteCode">Invite Code</Label>
          <Input
            id="inviteCode"
            placeholder="ABCD-EFGH-JK"
            value={code}
            onChange={(e) => setCode(formatInviteInput(e.target.value))}
            disabled={isJoining}
            maxLength={12}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="font-code tracking-widest"
          />
          <p className="mt-2 text-xs text-muted-foreground">
            After you join, an owner or admin chooses your role.
          </p>
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={isJoining || !complete}>
            {isJoining && <Loader2 className="mr-2 animate-spin" />}
            Join Household
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

export function HouseholdManager({ children }: HouseholdManagerProps) {
  const { currentUser, household, currentMember, householdLoading, householdLoadFailed, retryHouseholdLoad, createHousehold, joinHousehold, deleteHousehold, logout } = useAuth();
  const pathname = usePathname();
  const [finishingDelete, setFinishingDelete] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);

  if (currentUser && currentMember?.role === 'newuser' && pathname !== '/profile') {
    return (
      <>
        {/* Module pages are not mounted until membership is approved, so they never fetch. */}
        <Dialog open={true} onOpenChange={() => {}}>
          <DialogContent
            className="max-w-md"
            onInteractOutside={(e) => e.preventDefault()}
            onEscapeKeyDown={(e) => e.preventDefault()}
            hideClose
          >
            <DialogHeader>
              <DialogTitle className="font-headline text-2xl text-center">
                Waiting for approval
              </DialogTitle>
              <DialogDescription className="text-center text-base">
                An owner or admin needs to assign your household role before you can access HomeHub household data.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3 pt-2">
              <Button asChild variant="outline">
                <Link href="/profile">Open Profile</Link>
              </Button>
              <Button variant="link" className="text-primary" onClick={logout}>
                <LogOut className="mr-2 h-4 w-4" />
                Sign Out
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  // The owner started deleting this household; its data is frozen. If a run failed
  // partway, the owner can finish it from here.
  if (currentUser && household?.deletingAt) {
    const isOwner = currentMember?.role === 'owner';
    return (
      <Dialog open={true} onOpenChange={() => {}}>
        <DialogContent
          className="max-w-md"
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          hideClose
        >
          <DialogHeader>
            <DialogTitle className="font-headline text-2xl text-center">This household is being deleted</DialogTitle>
            <DialogDescription className="text-center text-base">
              {isOwner
                ? 'Deletion did not finish. Finish deleting to remove the remaining data.'
                : 'The owner is deleting this household. Its data is no longer available.'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 pt-2">
            {isOwner && (
              <Button
                variant="destructive"
                disabled={finishingDelete}
                onClick={async () => {
                  setFinishingDelete(true);
                  try {
                    await deleteHousehold(household.name);
                  } finally {
                    setFinishingDelete(false);
                  }
                }}
              >
                {finishingDelete ? 'Deleting…' : 'Finish deleting'}
              </Button>
            )}
            <Button variant="link" className="text-primary" onClick={logout}>
              <LogOut className="mr-2 h-4 w-4" />
              Sign Out
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // Membership could not be loaded (offline, timeout): offer a retry, never onboarding.
  if (currentUser?.householdId && householdLoadFailed && !householdLoading) {
    return (
      <Dialog open={true} onOpenChange={() => {}}>
        <DialogContent
          className="max-w-md"
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          hideClose
        >
          <DialogHeader>
            <DialogTitle className="font-headline text-2xl text-center">Couldn&apos;t load your household</DialogTitle>
            <DialogDescription className="text-center text-base">
              HomeHub couldn&apos;t be reached. Check your connection and try again.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 pt-2">
            <Button onClick={retryHouseholdLoad}>Try again</Button>
            <Button variant="link" className="text-primary" onClick={logout}>
              <LogOut className="mr-2 h-4 w-4" />
              Sign Out
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // If user is not logged in, is still resolving household state, or has a household, show the main app.
  if (!currentUser || householdLoading || household !== null) {
    return <>{children}</>;
  }

  const handleCreate = async (name: string) => {
    setIsCreating(true);
    try {
      await createHousehold(name);
    } finally {
      setIsCreating(false);
    }
  };

  const handleJoin = async (code: string) => {
    setIsJoining(true);
    try {
      await joinHousehold(code);
    } finally {
      setIsJoining(false);
    }
  };

  // Display this overlay if user is logged in but has no household
  return (
    <>
      {/* Module pages are not mounted until membership is approved, so they never fetch. */}
      <Dialog open={true} onOpenChange={() => {}}>
        <DialogContent
          className="max-w-4xl"
          onInteractOutside={(e) => e.preventDefault()}
            onEscapeKeyDown={(e) => e.preventDefault()}
            hideClose
        >
          <DialogHeader>
            <DialogTitle className="font-headline text-3xl text-center">
              Welcome to HomeHub!
            </DialogTitle>
            <DialogDescription className="text-center text-base">
              To get started, create a new household for your family or join one
              that already exists.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 pt-4">
            <CreateHouseholdForm onCreate={handleCreate} isCreating={isCreating} />
            <JoinHouseholdForm onJoin={handleJoin} isJoining={isJoining} />
          </div>
           <div className="mt-6 text-center">
            <p className="text-sm text-muted-foreground">
              Signed in as {currentUser.email}. Not the right account?
            </p>
            <Button variant="link" className="text-primary" onClick={logout}>
              <LogOut className="mr-2 h-4 w-4" />
              Sign Out
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
