
'use client';

import { useAuth } from "@/hooks/use-auth";
import { PetsClient } from "@/components/pets-client";

export default function PetsPage() {
  const { currentUser } = useAuth();

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="font-headline text-3xl font-bold tracking-tight">Your Pets</h1>
          <p className="text-muted-foreground">Manage your pets&apos; info, schedules, and records.</p>
        </div>
      </div>
      
      {!currentUser && <p className="text-center py-8">Please log in to manage your pets.</p>}

      {currentUser && (
        <PetsClient />
      )}

    </div>
  );
}
