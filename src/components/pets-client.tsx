'use client';

import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { PlusCircle } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/lib/firebase';
import type { PetProfile } from '@/lib/pets/types';
import { AddPetDialog } from './add-pet-dialog';
import { DeletePetAlert } from './delete-pet-alert';
import { EditPetDialog } from './edit-pet-dialog';
import { EmptyState } from './empty-state';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { LivingPetCard } from './pets/living-pet-card';
import { PetsPageHeader } from './pets/pets-page-header';
import { createPet, deletePet, updatePet } from './pets/pet-profile-api';
import type { PetFields } from './pets/pet-form';

const GRID = 'grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4';

function PetSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border bg-card shadow-raised" aria-hidden>
      <Skeleton className="aspect-[4/3] w-full rounded-none" />
      <div className="space-y-3 p-4">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-4 w-1/4" />
        <div className="flex items-center gap-3">
          <Skeleton className="h-12 w-12 rounded-full" />
          <Skeleton className="h-4 flex-1" />
        </div>
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}

export function PetsClient() {
  const { currentUser, permissions } = useAuth();
  const { toast, toastError } = useToast();
  const householdId = currentUser?.householdId ?? null;
  const canEdit = Boolean(permissions['pets.editProfiles']);

  // Keyed by household so a household switch never shows the previous pets.
  const [snapshot, setSnapshot] = useState<{ householdId: string | null; pets: PetProfile[]; failed: boolean }>({
    householdId: null,
    pets: [],
    failed: false,
  });
  const [addOpen, setAddOpen] = useState(false);
  const [petToEdit, setPetToEdit] = useState<PetProfile | null>(null);
  const [petToDelete, setPetToDelete] = useState<PetProfile | null>(null);

  // Live pet list: edits from other members and devices appear without a refresh.
  useEffect(() => {
    if (!householdId) return;
    return onSnapshot(
      collection(db, 'households', householdId, 'pets'),
      (result) => {
        const next = result.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as PetProfile);
        setSnapshot({ householdId, pets: next.sort((a, b) => a.name.localeCompare(b.name)), failed: false });
      },
      (error) => {
        console.error('Error loading pets:', error);
        setSnapshot({ householdId, pets: [], failed: true });
        toastError(error, "Couldn't load your pets");
      },
    );
  }, [householdId, toastError]);

  const ready = snapshot.householdId === householdId;
  const loading = Boolean(householdId) && !ready;
  const pets = useMemo(() => (ready ? snapshot.pets : []), [ready, snapshot.pets]);
  const loadFailed = ready && snapshot.failed;

  const existingNames = useMemo(() => pets.map((pet) => pet.name), [pets]);

  const handleAddPet = async (fields: PetFields, photoFile: File | null): Promise<boolean> => {
    if (!householdId) return false;
    try {
      await createPet(householdId, fields, photoFile);
      toast({ title: 'Pet added', description: `${fields.name} has joined the household.` });
      return true;
    } catch (error) {
      console.error('Error adding pet:', error);
      toastError(error, "Couldn't add the pet");
      return false;
    }
  };

  const handleUpdatePet = async (fields: PetFields, photoFile: File | null, isPhotoRemoved: boolean): Promise<boolean> => {
    if (!householdId || !petToEdit) return false;
    try {
      await updatePet(householdId, petToEdit.id, fields, { file: photoFile, removed: isPhotoRemoved, currentUrl: petToEdit.photoUrl });
      toast({ title: 'Pet updated', description: `${petToEdit.name}'s details are saved.` });
      setPetToEdit(null);
      return true;
    } catch (error) {
      console.error('Error updating pet:', error);
      toastError(error, "Couldn't update the pet");
      return false;
    }
  };

  const handleDeletePet = async () => {
    const target = petToDelete;
    setPetToDelete(null);
    if (!householdId || !target) return;
    try {
      await deletePet(householdId, target.id);
      toast({ title: 'Pet deleted', description: `${target.name} has been removed.` });
    } catch (error) {
      console.error('Error deleting pet:', error);
      toastError(error, "Couldn't delete the pet");
    }
  };

  const addButton = canEdit ? (
    <Button onClick={() => setAddOpen(true)} className="w-full sm:w-auto">
      <PlusCircle className="mr-2" /> Add Pet
    </Button>
  ) : null;

  return (
    <div>
      <PetsPageHeader action={addButton} />

      {canEdit && (
        <AddPetDialog open={addOpen} onOpenChange={setAddOpen} existingNames={existingNames} onAddPet={handleAddPet} />
      )}
      <EditPetDialog pet={petToEdit} onUpdatePet={handleUpdatePet} onOpenChange={(isOpen) => !isOpen && setPetToEdit(null)} />
      <DeletePetAlert
        isOpen={!!petToDelete}
        petName={petToDelete?.name}
        onConfirm={handleDeletePet}
        onCancel={() => setPetToDelete(null)}
      />

      {loading ? (
        <div className={GRID} role="status" aria-label="Loading pets">
          <PetSkeleton />
          <PetSkeleton />
          <PetSkeleton />
        </div>
      ) : pets.length > 0 && householdId ? (
        <div className={GRID}>
          {pets.map((pet, index) => (
            <LivingPetCard
              key={pet.id}
              pet={pet}
              householdId={householdId}
              canEdit={canEdit}
              onEdit={setPetToEdit}
              onDelete={setPetToDelete}
              priority={index === 0}
              index={index}
            />
          ))}
        </div>
      ) : loadFailed ? (
        <EmptyState
          kind="pets"
          title="Pets are unavailable right now"
          description="We couldn't load your pets. Check your connection and try again."
          action={{ label: 'Try again', onClick: () => window.location.reload() }}
        />
      ) : (
        <EmptyState
          kind="pets"
          title="No pets yet"
          description={
            canEdit
              ? 'Add your first pet to track feedings, medication and care in one place.'
              : 'Pets your household adds will show up here.'
          }
          action={canEdit ? { label: 'Add your first pet', icon: <PlusCircle className="mr-2 h-4 w-4" />, onClick: () => setAddOpen(true) } : undefined}
        />
      )}
    </div>
  );
}
