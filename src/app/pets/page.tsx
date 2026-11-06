'use client';

import { useAuth } from "@/hooks/use-auth";
import { PetsClient } from "@/components/pets-client";
import { PetsPageHeader } from "@/components/pets/pets-page-header";

export default function PetsPage() {
  const { currentUser } = useAuth();

  return (
    <div className="container mx-auto px-4 py-8">
      {currentUser ? (
        <PetsClient />
      ) : (
        <>
          <PetsPageHeader />
          <p className="text-center py-8">Please log in to manage your pets.</p>
        </>
      )}
    </div>
  );
}
