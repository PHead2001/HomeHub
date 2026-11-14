'use client';

import { Suspense } from 'react';
import { useAuth } from "@/hooks/use-auth";
import { useSessionKnown } from '@/hooks/use-session-known';
import Loading from './loading';
import { PetsClient } from "@/components/pets-client";
import { PetsPageHeader } from "@/components/pets/pets-page-header";
import { PetsListSkeletonBody } from "@/components/pets/pets-skeleton";
import { SignInPrompt } from '@/components/profile/sign-in-prompt';

export default function PetsPage() {
  const { currentUser } = useAuth();
  const sessionKnown = useSessionKnown();
  // SL-11: the route skeleton, not the sign-in prompt, until Auth has answered.
  if (!currentUser && !sessionKnown) return <Loading />;

  return (
    <div className="container mx-auto px-4 py-8">
      {currentUser ? (
        // PetsClient reads useSearchParams (the `?feed=1` shortcut). The fallback is the
        // route's own skeleton, so loading never steps through blank or different placeholders (PE-21g).
        <Suspense fallback={<div role="status" aria-busy="true" aria-label="Loading pets"><PetsListSkeletonBody /></div>}>
          <PetsClient />
        </Suspense>
      ) : (
        <>
          <PetsPageHeader />
          <SignInPrompt what="manage your pets" />
        </>
      )}
    </div>
  );
}
