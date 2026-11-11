'use client';

import { Fragment, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
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
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { HOUSEHOLD_NAME_MAX, formatInviteInput, householdNameError, inviteCodeError } from '@/components/household/household-model';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './ui/card';

const NO_DATA = 'Nothing from it is shown on this device any more. You can create a household or join one with an invite code.';

/** What the person is told when access ends (`membershipEnded.reason`). */
const membershipEndedCopy = {
  removed: {
    title: "You're no longer in this household",
    description: `An owner or admin removed you, or you left on another device. ${NO_DATA}`,
  },
  declined: {
    title: 'Your request to join was declined',
    description: `An owner or admin turned down your request. ${NO_DATA}`,
  },
  deleted: {
    title: 'This household was deleted',
    description: `The owner deleted the household and everything in it. ${NO_DATA}`,
  },
} as const;

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
  const [submitted, setSubmitted] = useState(false);
  const error = submitted ? householdNameError(name) : null;
  const left = HOUSEHOLD_NAME_MAX - name.length;
  return (
    <Card>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (!householdNameError(name) && !isCreating) onCreate(name.trim());
        }}
      >
        <CardHeader>
          <CardTitle className="font-headline">Create a Household</CardTitle>
          <CardDescription>
            Give your household a name to get started.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="householdName">Household Name</Label>
          <Input
            {...fieldErrorProps('householdName', error)}
            placeholder="e.g. The Miller Residence"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isCreating}
            maxLength={HOUSEHOLD_NAME_MAX}
            autoComplete="off"
            enterKeyHint="go"
          />
          <FieldError id="householdName">{error}</FieldError>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            You can rename it later.{left <= 15 && ` ${left} ${left === 1 ? 'character' : 'characters'} left.`}
          </p>
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={isCreating}>
            {isCreating && <Loader2 className="mr-2 animate-spin" />}
            Create Household
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function JoinHouseholdForm({
  onJoin,
  isJoining,
}: {
  onJoin: (code: string) => void;
  isJoining: boolean;
}) {
  const [code, setCode] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const error = submitted ? inviteCodeError(code) : null;
  return (
    <Card>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (!inviteCodeError(code) && !isJoining) onJoin(code);
        }}
      >
        <CardHeader>
          <CardTitle className="font-headline">Join a Household</CardTitle>
          <CardDescription>
            Ask someone in the household for an invite code. Codes last 30 minutes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="inviteCode">Invite Code</Label>
          <Input
            {...fieldErrorProps('inviteCode', error)}
            placeholder="ABCD-EFGH-JK"
            value={code}
            onChange={(e) => setCode(formatInviteInput(e.target.value))}
            disabled={isJoining}
            maxLength={12}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            enterKeyHint="go"
            className="font-code tracking-widest"
          />
          <FieldError id="inviteCode">{error}</FieldError>
          <p className="text-xs text-muted-foreground">
            After you join, an owner or admin chooses your role.
          </p>
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={isJoining}>
            {isJoining && <Loader2 className="mr-2 animate-spin" />}
            Join Household
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

export function HouseholdManager({ children }: HouseholdManagerProps) {
  const { currentUser, household, currentMember, householdLoading, householdLoadFailed, retryHouseholdLoad, membershipEnded, dismissMembershipEnded, createHousehold, joinHousehold, deleteHousehold, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  // Screens are keyed by household: moving from one household to another remounts every
  // screen, so no screen state, listener or pending write of the previous household
  // survives the switch. The first household of a page load keeps the initial key.
  const [scope, setScope] = useState<{ householdId: string | null; key: number }>({ householdId: null, key: 0 });
  const scopeHouseholdId = currentUser?.householdId ?? null;
  if (scopeHouseholdId && scopeHouseholdId !== scope.householdId) {
    setScope({ householdId: scopeHouseholdId, key: scope.householdId ? scope.key + 1 : scope.key });
  }
  const [finishingDelete, setFinishingDelete] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);

  // Access ended while this page was open (or since the last visit): the household's
  // data is already gone from this device. Explain it once, then onboarding.
  if (currentUser && membershipEnded) {
    const copy = membershipEndedCopy[membershipEnded.reason];
    return (
      <Dialog open={true} onOpenChange={() => {}}>
        <DialogContent
          className="max-w-md"
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          hideClose
        >
          <DialogHeader>
            <DialogTitle className="font-headline text-2xl text-center">{copy.title}</DialogTitle>
            <DialogDescription className="text-center text-base">{copy.description}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 pt-2">
            <Button
              onClick={() => {
                dismissMembershipEnded();
                if (pathname !== '/') router.replace('/');
              }}
            >
              Continue
            </Button>
            <Button variant="link" className="text-primary" onClick={logout}>
              <LogOut className="mr-2 h-4 w-4" />
              Sign Out
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

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
                {household?.name
                  ? `You asked to join ${household.name}. An owner or admin will choose your role, and then everything opens up.`
                  : 'An owner or admin will choose your role, and then everything opens up.'}
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
    return <Fragment key={scope.key}>{children}</Fragment>;
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
          className="max-h-[100dvh] max-w-4xl overflow-y-auto"
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
