'use client';

import { Fragment, useEffect, useState, type ReactNode } from 'react';
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
import { deletionNameField, deletionNameSuggestion, finishDeletingError, finishDeletingName } from '@/lib/auth/live-membership';
import { HOUSEHOLD_NAME_MAX, formatInviteInput, householdNameError, inviteCodeError } from '@/components/household/household-model';
import { JOIN_CODE_EVENT, forgetJoinCode, pendingJoinCode } from '@/lib/invite-link';
import { accessUntilMs, guestPassEnded } from '@/lib/guest-pass';
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
  // A code from an invite link (/join?code=…, HO-16) fills the field; the person still presses Join.
  const [code, setCode] = useState(() => pendingJoinCode(typeof window === 'undefined' ? null : window.sessionStorage));
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    // A link opened while this form is already showing: fill an empty field.
    const fill = () => setCode((prev) => prev || pendingJoinCode(window.sessionStorage));
    window.addEventListener(JOIN_CODE_EVENT, fill);
    return () => window.removeEventListener(JOIN_CODE_EVENT, fill);
  }, []);
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

/**
 * The frozen-household screen. "Finish deleting" must send the household's exact name
 * (the server checks it, and the frozen household cannot be read), so the owner always
 * sees an editable name field, prefilled with the best guess (`deletionNameSuggestion`);
 * the action is offered only while the field holds a name, and a refusal is explained
 * under the field, which stays editable.
 */
function DeletingHouseholdDialog({
  isOwner,
  suggestedName,
  onFinish,
  onLeave,
  onSignOut,
}: {
  isOwner: boolean;
  suggestedName: string;
  onFinish: (confirmName: string) => Promise<boolean>;
  /** Everyone but the owner may leave a household that is being deleted (HO-4). */
  onLeave: () => Promise<boolean>;
  onSignOut: () => void;
}) {
  const [finishing, setFinishing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [typedName, setTypedName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const field = deletionNameField(typedName, suggestedName);
  const confirmName = finishDeletingName(field);
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
              ? "Deletion did not finish. Check the household's name, then finish deleting the remaining data."
              : 'The owner is deleting this household. Its data is no longer available. You can leave it now and create or join another household.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3 pt-2"
          noValidate
          onSubmit={async (event) => {
            event.preventDefault();
            if (!isOwner || !confirmName || finishing) return;
            setFinishing(true);
            setError(null);
            try {
              setError(finishDeletingError(await onFinish(confirmName)));
            } finally {
              setFinishing(false);
            }
          }}
        >
          {isOwner && (
            <div className="space-y-2 text-left">
              <Label htmlFor="finishDeleteName">Household name</Label>
              <Input
                {...fieldErrorProps('finishDeleteName', error)}
                value={field}
                onChange={(e) => { setTypedName(e.target.value); setError(null); }}
                disabled={finishing}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                maxLength={HOUSEHOLD_NAME_MAX}
              />
              <FieldError id="finishDeleteName">{error}</FieldError>
            </div>
          )}
          {isOwner && (
            <Button type="submit" variant="destructive" disabled={finishing || !confirmName}>
              {finishing ? 'Deleting…' : 'Finish deleting'}
            </Button>
          )}
          {!isOwner && (
            <Button
              type="button"
              disabled={leaving}
              onClick={async () => {
                setLeaving(true);
                try {
                  await onLeave();
                } finally {
                  setLeaving(false);
                }
              }}
            >
              {leaving && <Loader2 className="mr-2 animate-spin" />}
              Leave this household
            </Button>
          )}
          <Button type="button" variant="link" className="text-primary" onClick={onSignOut}>
            <LogOut className="mr-2 h-4 w-4" />
            Sign Out
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Cancel request" on the waiting screen (HO-3): a pending person who typed the wrong
 * code, or was never answered, withdraws the request (the leave server action) and can
 * then create or join another household. Asks once before cancelling.
 */
function CancelJoinRequest({ householdName, onCancel }: { householdName: string; onCancel: () => Promise<boolean> }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!asking) {
    return (
      <Button variant="outline" onClick={() => setAsking(true)}>
        Cancel request
      </Button>
    );
  }
  return (
    <div role="group" aria-labelledby="cancel-request-question" className="space-y-2 rounded-md border p-3 text-left">
      <p id="cancel-request-question" className="text-sm">
        Cancel your request to join {householdName || 'this household'}? You can ask again with a new invite code.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          variant="destructive"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              if (!(await onCancel())) setAsking(false);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <Loader2 className="mr-2 animate-spin" />}
          Yes, cancel request
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => setAsking(false)}>
          Keep waiting
        </Button>
      </div>
    </div>
  );
}

export function HouseholdManager({ children }: HouseholdManagerProps) {
  const { currentUser, household, currentMember, householdLoading, householdLoadFailed, retryHouseholdLoad, membershipEnded, dismissMembershipEnded, createHousehold, joinHousehold, leaveHousehold, deleteHousehold, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  // Screens are keyed by account and household: another household, or another person in
  // the same household, remounts every screen, so no screen state, listener, Undo offer or
  // pending write of the previous one survives. The first household of a page load keeps
  // the initial key.
  const [scope, setScope] = useState<{ uid: string | null; householdId: string | null; key: number }>({ uid: null, householdId: null, key: 0 });
  const scopeUid = currentUser?.uid ?? null;
  const scopeHouseholdId = currentUser?.householdId ?? null;
  if (scopeUid && scopeHouseholdId && (scopeHouseholdId !== scope.householdId || scopeUid !== scope.uid)) {
    setScope({ uid: scopeUid, householdId: scopeHouseholdId, key: scope.householdId ? scope.key + 1 : scope.key });
  }
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  // Re-render when a guest pass ends (no snapshot arrives when time passes).
  const passUntil = accessUntilMs(currentMember?.accessUntil);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (passUntil === null) return;
    const wait = Math.max(0, passUntil - Date.now() + 250);
    const timer = window.setTimeout(() => setClock(Date.now()), Math.min(wait, 2 ** 31 - 1));
    return () => window.clearTimeout(timer);
  }, [passUntil]);
  const passEnded = Boolean(currentMember && currentMember.status === 'active' && guestPassEnded(currentMember, clock));

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

  // A guest pass that has ended (HO-14): the rules already refuse everything; say so,
  // and let the person leave (the household's sweep removes the record anyway).
  if (currentUser && passEnded && currentMember) {
    return (
      <Dialog open={true} onOpenChange={() => {}}>
        <DialogContent
          className="max-w-md"
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          hideClose
        >
          <DialogHeader>
            <DialogTitle className="font-headline text-2xl text-center">Your guest pass has ended</DialogTitle>
            <DialogDescription className="text-center text-base">
              {`Your access to ${household?.name || 'this household'} was time-limited and has run out. Ask an owner or admin if you need another pass.`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 pt-2">
            <Button onClick={() => { void leaveHousehold(); }}>Continue</Button>
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
              <CancelJoinRequest householdName={household?.name ?? ''} onCancel={leaveHousehold} />
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
    return (
      <DeletingHouseholdDialog
        isOwner={currentMember?.role === 'owner'}
        suggestedName={deletionNameSuggestion(household.name, currentMember?.householdName)}
        onFinish={deleteHousehold}
        onLeave={leaveHousehold}
        onSignOut={logout}
      />
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
      if (await joinHousehold(code)) forgetJoinCode(window.sessionStorage);
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
          className="max-h-[calc(var(--dialog-max-h)_+_2rem_-_var(--keyboard-inset,0px))] max-w-4xl overflow-y-auto"
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
