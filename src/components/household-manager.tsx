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
  return (
    <Card>
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
        />
      </CardContent>
      <CardFooter>
        <Button onClick={() => onCreate(name)} disabled={isCreating || !name}>
          {isCreating && <Loader2 className="mr-2 animate-spin" />}
          Create Household
        </Button>
      </CardFooter>
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
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-headline">Join a Household</CardTitle>
        <CardDescription>
          Enter an invite code to join an existing household.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Label htmlFor="inviteCode">Invite Code</Label>
        <Input
          id="inviteCode"
          placeholder="XXXX-XXXX-XX"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          disabled={isJoining}
          maxLength={12}
        />
      </CardContent>
      <CardFooter>
        <Button onClick={() => onJoin(code)} disabled={isJoining || code.trim().length < 10}>
          {isJoining && <Loader2 className="mr-2 animate-spin" />}
          Join Household
        </Button>
      </CardFooter>
    </Card>
  );
}

export function HouseholdManager({ children }: HouseholdManagerProps) {
  const { currentUser, household, currentMember, createHousehold, joinHousehold, logout } = useAuth();
  const pathname = usePathname();
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);

  if (currentUser && currentMember?.role === 'newuser' && pathname !== '/profile') {
    return (
      <>
        <div className="hidden">{children}</div>
        <Dialog open={true} onOpenChange={() => {}}>
          <DialogContent
            className="max-w-md"
            onInteractOutside={(e) => e.preventDefault()}
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

  // If user is not logged in, or has a household, show the main app.
  if (!currentUser || household !== null) {
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
      <div className="hidden">{children}</div>
      <Dialog open={true} onOpenChange={() => {}}>
        <DialogContent
          className="max-w-4xl"
          onInteractOutside={(e) => e.preventDefault()}
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
