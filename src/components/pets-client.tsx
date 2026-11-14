'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { collection, onSnapshot, type QuerySnapshot } from 'firebase/firestore';
import { PlusCircle } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/lib/firebase';
import type { ResilientHandle } from '@/lib/dashboard/resilient-listener';
import { petSnapshotListener, staleNoticeText } from '@/lib/pets/live-listener';
import type { PetProfile } from '@/lib/pets/types';
import { FEED_SHORTCUT_PARAM, quickFeedDecision, wantsQuickFeed } from '@/lib/pets/care';
import { Stagger, StaggerItem } from './motion/stagger';
import { FeedPickerDialog } from './pets/feed-picker-dialog';
import { AddPetDialog } from './add-pet-dialog';
import { DeletePetAlert } from './delete-pet-alert';
import { EditPetDialog } from './edit-pet-dialog';
import { EmptyState } from './empty-state';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { LivingPetCard } from './pets/living-pet-card';
import { PetsPageHeader } from './pets/pets-page-header';
import { createPet, deletePet, updatePet } from './pets/pet-profile-api';
import { returnFocusToPet } from './pets/focus';
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
  const { currentUser, currentMember, permissions, loading: authLoading, householdLoading } = useAuth();
  const { toast, toastError } = useToast();
  const householdId = currentUser?.householdId ?? null;
  const canEdit = Boolean(permissions['pets.editProfiles']);

  // Keyed by household so a household switch never shows the previous pets.
  // `failed`: the list could not be read (`retrying`: it resubscribes on its own;
  // `unauthorized`: access was refused, so no "Try again" is offered, PE-18c).
  const [snapshot, setSnapshot] = useState<{ householdId: string | null; pets: PetProfile[]; loaded: boolean; failed: false | 'retrying' | 'unauthorized' }>({
    householdId: null,
    pets: [],
    loaded: false,
    failed: false,
  });
  const listHandle = useRef<ResilientHandle | null>(null);
  // The pet whose menu opened Edit or Delete: focus returns to its actions button (PE-20e).
  const menuPet = useRef<string | null>(null);
  const backToMenu = (event: Event) => returnFocusToPet(menuPet.current)(event);
  const [addOpen, setAddOpen] = useState(false);
  const [petToEdit, setPetToEdit] = useState<PetProfile | null>(null);
  const [petToDelete, setPetToDelete] = useState<PetProfile | null>(null);

  // Live pet list: edits from other members and devices appear without a refresh.
  // A resilient listener (PE-8g): a failed read resubscribes with bounded backoff
  // and on `online` / page visible; already loaded pets stay while it retries.
  useEffect(() => {
    if (!householdId) return;
    const handle = petSnapshotListener<QuerySnapshot>(
      (next, error) => onSnapshot(collection(db, 'households', householdId, 'pets'), { includeMetadataChanges: true }, next, error),
      {
        next: (result) => {
          const next = result.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as PetProfile);
          setSnapshot({ householdId, pets: next.sort((a, b) => a.name.localeCompare(b.name)), loaded: true, failed: false });
        },
        status: (status) => {
          if (status.kind === 'live') return;
          console.error('Error loading pets:', status.error);
          setSnapshot((previous) => previous.householdId === householdId && previous.loaded
            ? { ...previous, failed: status.kind }
            : { householdId, pets: [], loaded: false, failed: status.kind });
        },
      },
    );
    listHandle.current = handle;
    return () => {
      handle.stop();
      if (listHandle.current === handle) listHandle.current = null;
    };
  }, [householdId]);

  const ready = snapshot.householdId === householdId && (snapshot.loaded || snapshot.failed !== false);
  const loading = Boolean(householdId) && !ready;
  const pets = useMemo(() => (ready ? snapshot.pets : []), [ready, snapshot.pets]);
  const loadFailed = ready && !snapshot.loaded ? snapshot.failed : false;

  const existingNames = useMemo(() => pets.map((pet) => pet.name), [pets]);

  // "Log feeding" home-screen shortcut (`/pets?feed=1`): once both the pet list and
  // the member's permissions have loaded, open the feeding picker (straight to the
  // confirm step with one pet) or ignore the request, then drop the param so a
  // reload or Back does not reopen it. Nothing is decided, or removed, before that.
  const searchParams = useSearchParams();
  const feedRequested = wantsQuickFeed(searchParams);
  const canFeed = Boolean(permissions['pets.addLogs']);
  const [feedPickerOpen, setFeedPickerOpen] = useState(false);
  const [handledFeedRequest, setHandledFeedRequest] = useState(false);
  const feedDecision = quickFeedDecision({
    requested: feedRequested && !handledFeedRequest,
    permissionsReady: !authLoading && !householdLoading && Boolean(currentMember),
    petsReady: ready && !loading,
    canFeed,
    petCount: pets.length,
  });
  if (feedDecision === 'open' || feedDecision === 'ignore') {
    setHandledFeedRequest(true);
    if (feedDecision === 'open') setFeedPickerOpen(true);
  }
  useEffect(() => {
    if (!handledFeedRequest || !feedRequested) return;
    const url = new URL(window.location.href);
    url.searchParams.delete(FEED_SHORTCUT_PARAM);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, [handledFeedRequest, feedRequested]);

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
      {ready && snapshot.loaded && snapshot.failed && (
        <p role="status" className="-mt-4 mb-4 text-sm text-muted-foreground" data-testid="pets-list-stale">
          {staleNoticeText(snapshot.failed === 'unauthorized' ? 'access-changed' : 'reconnecting', 'the pet list')}
        </p>
      )}

      {canEdit && (
        <AddPetDialog open={addOpen} onOpenChange={setAddOpen} existingNames={existingNames} onAddPet={handleAddPet} />
      )}
      {canFeed && householdId && (
        <FeedPickerDialog open={feedPickerOpen} onOpenChange={setFeedPickerOpen} pets={pets} householdId={householdId} />
      )}
      <EditPetDialog pet={petToEdit} onUpdatePet={handleUpdatePet} onOpenChange={(isOpen) => !isOpen && setPetToEdit(null)} onCloseAutoFocus={backToMenu} />
      <DeletePetAlert
        isOpen={!!petToDelete}
        petName={petToDelete?.name}
        onConfirm={handleDeletePet}
        onCancel={() => setPetToDelete(null)}
        onCloseAutoFocus={backToMenu}
      />

      {loading ? (
        <div className={GRID} role="status" aria-label="Loading pets">
          <PetSkeleton />
          <PetSkeleton />
          <PetSkeleton />
        </div>
      ) : pets.length > 0 && householdId ? (
        <Stagger className={GRID}>
          {pets.map((pet, index) => (
            <StaggerItem key={pet.id} className="min-w-0">
              <LivingPetCard
                pet={pet}
                householdId={householdId}
                canEdit={canEdit}
                onEdit={(target) => { menuPet.current = target.id; setPetToEdit(target); }}
                onDelete={(target) => { menuPet.current = target.id; setPetToDelete(target); }}
                priority={index === 0}
                index={index}
              />
            </StaggerItem>
          ))}
        </Stagger>
      ) : loadFailed === 'unauthorized' ? (
        <EmptyState
          kind="pets"
          title="Pets aren't available to you"
          description="Your household role doesn't include viewing pets. Ask an owner or admin if you need access."
        />
      ) : loadFailed ? (
        <EmptyState
          kind="pets"
          title="Pets are unavailable right now"
          description="We couldn't load your pets. HomeHub keeps trying; check your connection or try again now."
          action={{ label: 'Try again', onClick: () => listHandle.current?.retryNow() }}
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
