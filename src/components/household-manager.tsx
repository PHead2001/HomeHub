'use client';

import { useState, type ReactNode } from 'react';
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
import { useToast } from '@/hooks/use-toast';
import { Loader2, Home, UserPlus, Copy, LogOut } from 'lucide-react';
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
          placeholder="Enter 6-character code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={isJoining}
          maxLength={6}
        />
      </CardContent>
      <CardFooter>
        <Button onClick={() => onJoin(code)} disabled={isJoining || code.length !== 6}>
          {isJoining && <Loader2 className="mr-2 animate-spin" />}
          Join Household
        </Button>
      </CardFooter>
    </Card>
  );
}

export function HouseholdManager({ children }: HouseholdManagerProps) {
  const { currentUser, household, createHousehold, joinHousehold, logout } = useAuth();
  const { toast } = useToast();
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);

  // If user is not logged in, or is loading, or has a household, show the main app
  if (!currentUser || household !== null) {
    return <>{children}</>;
  }

  const handleCreate = async (name: string) => {
    setIsCreating(true);
    await createHousehold(name);
    // onAuthStateChanged will handle updating the state, no need to do it here
    setIsCreating(false);
  };

  const handleJoin = async (code: string) => {
    setIsJoining(true);
    await joinHousehold(code);
    // onAuthStateChanged will handle updating the state
    setIsJoining(false);
  };

  const copyInviteCode = () => {
    if (household?.inviteCode) {
      navigator.clipboard.writeText(household.inviteCode);
      toast({ title: "Copied!", description: "Invite code copied to clipboard." });
    }
  }

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

// A component to display the household info and invite code, could be placed on profile page
export function HouseholdInfo() {
    const { household } = useAuth();
    const { toast } = useToast();

    if (!household) return null;

    const copyInviteCode = () => {
        if (household?.inviteCode) {
          navigator.clipboard.writeText(household.inviteCode);
          toast({ title: "Copied!", description: "Invite code copied to clipboard." });
        }
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="font-headline flex items-center gap-2"><Home /> Household</CardTitle>
                <CardDescription>Your household information and invite code.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <div>
                    <Label>Household Name</Label>
                    <p className="font-semibold text-lg">{household.name}</p>
                </div>
                 <div>
                    <Label>Invite Code</Label>
                    <div className="flex items-center gap-2">
                        <Input readOnly value={household.inviteCode} className="font-mono" />
                        <Button variant="outline" size="icon" onClick={copyInviteCode}>
                            <Copy className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
            </CardContent>
        </Card>
    )
}
