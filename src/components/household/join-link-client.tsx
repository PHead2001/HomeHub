'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SignInPrompt } from '@/components/profile/sign-in-prompt';
import { useAuth } from '@/hooks/use-auth';
import { JOIN_CODE_EVENT, JOIN_PATH, forgetJoinCode, joinCodeFromSearch, rememberJoinCode } from '@/lib/invite-link';

const session = () => (typeof window === 'undefined' ? null : window.sessionStorage);

/**
 * The /join page (HO-16, HO-23). On load it keeps a well-formed code from the link for
 * this tab only and replaces the address with plain /join, so the code is not left in
 * the history or shared further by accident. Then:
 * - signed out: sign in (the onboarding overlay opens next with the Join form filled);
 * - signed in with no household: the onboarding overlay (HouseholdManager) is already
 *   on top, with the code in the Join form; nothing joins until they press Join;
 * - already in a household: says so, and the code is forgotten.
 */
export function JoinLinkClient() {
  const { currentUser, household, householdLoading, loading } = useAuth();
  const [hadCode, setHadCode] = useState<boolean | null>(null);

  useEffect(() => {
    const code = joinCodeFromSearch(window.location.search);
    rememberJoinCode(session(), code);
    if (code) window.dispatchEvent(new Event(JOIN_CODE_EVENT));
    if (window.location.search) window.history.replaceState(window.history.state, '', JOIN_PATH);
    // The first render cannot know the URL's code (it is read in the browser only).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHadCode(Boolean(code));
  }, []);

  const inHousehold = Boolean(currentUser && household && !householdLoading);
  useEffect(() => {
    if (inHousehold) forgetJoinCode(session());
  }, [inHousehold]);

  if (loading || hadCode === null) return null;
  if (!currentUser) {
    return (
      <div className="mx-auto max-w-lg space-y-4 py-6">
        <p className="text-center text-sm text-muted-foreground">
          {hadCode ? "You've been invited to a household on HomeHub. Sign in, then press Join." : 'Sign in to join a household with an invite code.'}
        </p>
        <SignInPrompt what="join the household" />
      </div>
    );
  }
  if (inHousehold) {
    return (
      <Card className="mx-auto max-w-lg">
        <CardHeader>
          <CardTitle>You&apos;re already in a household</CardTitle>
          <CardDescription>
            To join another one, leave {household?.name || 'your household'} first from Household, Danger Zone. The invite link was not used.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link href="/">Go home</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }
  // Signed in without a household: the onboarding overlay is shown over this page.
  return null;
}
