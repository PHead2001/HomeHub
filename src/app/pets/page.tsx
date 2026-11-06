'use client';

import { useAuth } from "@/hooks/use-auth";
import { PetsClient } from "@/components/pets-client";
import { PetsPageHeader } from "@/components/pets/pets-page-header";
import { SignInPrompt } from '@/components/profile/sign-in-prompt';

export default function PetsPage() {
  const { currentUser } = useAuth();

  return (
    <div className="container mx-auto px-4 py-8">
      {currentUser ? (
        <PetsClient />
      ) : (
        <>
          <PetsPageHeader />
          <SignInPrompt what="manage your pets" />
        </>
      )}
    </div>
  );
}
