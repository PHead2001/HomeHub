'use client';

import { useEffect, useRef, useState, use } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { doc, onSnapshot, type DocumentSnapshot } from 'firebase/firestore';
import { ArrowLeft, CalendarDays, Edit, MoreVertical, Pill, Sparkles, Trash2, Utensils } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/lib/firebase';
import type { ResilientHandle } from '@/lib/dashboard/resilient-listener';
import { liveAnswer, liveFailure, liveNotice, petListenerKey, petSnapshotListener, staleNoticeText, type LiveState } from '@/lib/pets/live-listener';
import { petTabFromParam, PET_TABS, type PetTab } from '@/lib/pets/care';
import { feedingPlan, formatPortion, petPhotoMorphName } from '@/lib/pets/care';
import { morphStyle } from '@/lib/motion';
import type { PetProfile } from '@/lib/pets/types';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FeedingLogClient } from '@/components/feeding-log';
import { MedicationLogClient } from '@/components/medication-log';
import { CareLogClient } from '@/components/care-log';
import { EditPetDialog } from '@/components/edit-pet-dialog';
import { DeletePetAlert } from '@/components/delete-pet-alert';
import { EmptyState } from '@/components/empty-state';
import { PetPhoto } from '@/components/pets/pet-photo';
import { petTypeLabel } from '@/components/pets/living-pet-card';
import { PetCareSummary } from '@/components/pets/pet-care-summary';
import { deletePet, updatePet } from '@/components/pets/pet-profile-api';
import type { PetFields } from '@/components/pets/pet-form';
import { SignInPrompt } from '@/components/profile/sign-in-prompt';
import { returnFocusToPet } from '@/components/pets/focus';

export default function PetDetailPage({ params }: { params: Promise<{ petId: string }> }) {
  const { petId } = use(params);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { toast, toastError } = useToast();
  const { currentUser, permissions, loading: authLoading } = useAuth();
  const householdId = currentUser?.householdId ?? null;
  const canEdit = Boolean(permissions['pets.editProfiles']);

  const [petToEdit, setPetToEdit] = useState<PetProfile | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // The tab follows `?tab=` (PE-8f): a medication reminder tapped while this pet's
  // page is already open switches to its tab; choosing a tab updates the URL.
  const requestedTab = searchParams.get('tab');
  const [tab, setTab] = useState<PetTab>(petTabFromParam(requestedTab));
  const [seenTabParam, setSeenTabParam] = useState(requestedTab);
  if (requestedTab !== seenTabParam) {
    setSeenTabParam(requestedTab);
    if (requestedTab !== null) setTab(petTabFromParam(requestedTab));
  }
  const chooseTab = (next: PetTab) => {
    setTab(next);
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    // The URL catches up on a later render; the param check above then agrees with `tab`.
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  // Live pet document: edits from other members appear without a refresh. Keyed by
  // path so navigating between pets never shows the previous one. A resilient
  // listener (PE-8g): a failed read resubscribes on its own (backoff, `online`,
  // page visible); a refused one is reported as no access, without "Try again" (PE-18c).
  // Keyed by member and pets.view too, so a page refused for lack of access recovers when access returns.
  const docKey = petListenerKey(householdId ? `${householdId}/${petId}` : null, { uid: currentUser?.uid, canView: Boolean(permissions['pets.view']) });
  const [loaded, setLoaded] = useState<LiveState<PetProfile>>({ key: null, value: null, loaded: false, failed: false });
  const petHandle = useRef<ResilientHandle | null>(null);
  useEffect(() => {
    if (!householdId || !docKey) return;
    const handle = petSnapshotListener<DocumentSnapshot>(
      (next, error) => onSnapshot(doc(db, 'households', householdId, 'pets', petId), { includeMetadataChanges: true }, next, error),
      {
        next: (snapshot) => {
          setLoaded(liveAnswer(docKey, snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as PetProfile) : null));
        },
        status: (status) => {
          if (status.kind === 'live') return;
          console.error('Error loading pet:', status.error);
          // A pet already on screen stays, with the failure recorded so the page says
          // it is reconnecting or that access changed (never silently stale).
          setLoaded((previous) => liveFailure(previous, docKey, status.kind));
        },
      },
    );
    petHandle.current = handle;
    return () => {
      handle.stop();
      if (petHandle.current === handle) petHandle.current = null;
    };
  }, [householdId, petId, docKey]);

  const ready = loaded.key === docKey;
  const loading = authLoading || (Boolean(docKey) && !ready);
  const pet = ready ? loaded.value : null;
  // With nothing loaded the failure is the page's state; with a pet on screen it is a notice beside it.
  const loadFailed = ready && !loaded.loaded ? loaded.failed : false;
  const missing = ready && loaded.loaded && !loaded.value;
  const notice = ready && pet ? liveNotice(loaded) : null;

  const handleUpdatePet = async (fields: PetFields, photoFile: File | null, isPhotoRemoved: boolean): Promise<boolean> => {
    if (!householdId || !pet) return false;
    try {
      await updatePet(householdId, pet.id, fields, { file: photoFile, removed: isPhotoRemoved, currentUrl: pet.photoUrl });
      setPetToEdit(null);
      toast({ title: 'Pet updated', description: `${pet.name}'s details are saved.` });
      return true;
    } catch (error) {
      console.error('Error updating pet:', error);
      toastError(error, "Couldn't update the pet");
      return false;
    }
  };

  const handleDeletePet = async () => {
    setConfirmDelete(false);
    if (!householdId || !pet) return;
    try {
      await deletePet(householdId, pet.id);
      toast({ title: 'Pet deleted', description: `${pet.name} has been removed.` });
      router.push('/pets');
    } catch (error) {
      console.error('Error deleting pet:', error);
      toastError(error, "Couldn't delete the pet");
    }
  };

  const backButton = (
    <div className="mb-4">
      <Button asChild variant="outline">
        <Link href="/pets">
          <ArrowLeft aria-hidden className="mr-2" />
          Back to All Pets
        </Link>
      </Button>
    </div>
  );

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8" role="status" aria-label="Loading pet details">
        <Skeleton className="mb-4 h-10 w-44" />
        <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
          <div className="space-y-6 md:col-span-1">
            {/* Lands the /pets card → hero morph (H12) while the pet loads. */}
            <Skeleton className="h-80 w-full rounded-lg" style={morphStyle(petPhotoMorphName(petId))} />
            <Skeleton className="h-32 w-full rounded-lg" />
          </div>
          <div className="space-y-4 md:col-span-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-80 w-full rounded-lg" />
          </div>
        </div>
      </div>
    );
  }

  if (!pet || !householdId) {
    return (
      <div className="container mx-auto px-4 py-8">
        {backButton}
        {currentUser ? (
          <EmptyState
            kind="pets"
            title={missing ? 'This pet isn’t here' : loadFailed === 'unauthorized' ? 'This pet isn’t available to you' : 'This pet is unavailable right now'}
            description={
              missing
                ? 'It may have been removed. Your other pets are still on the Pets page.'
                : loadFailed === 'unauthorized'
                  ? "Your household role doesn't include viewing pets. Ask an owner or admin if you need access."
                  : "We couldn't load this pet. HomeHub keeps trying; check your connection or try again now."
            }
            action={loadFailed === 'retrying' ? { label: 'Try again', onClick: () => petHandle.current?.retryNow() } : loadFailed === 'unauthorized' ? undefined : { label: 'All pets', href: '/pets' }}
          />
        ) : (
          <SignInPrompt what="see your pets" />
        )}
      </div>
    );
  }

  const plan = feedingPlan(pet);

  return (
    <div className="container mx-auto px-4 py-8">
      <EditPetDialog pet={petToEdit} onUpdatePet={handleUpdatePet} onOpenChange={(isOpen) => !isOpen && setPetToEdit(null)} onCloseAutoFocus={returnFocusToPet(pet.id)} />
      <DeletePetAlert isOpen={confirmDelete} petName={pet.name} onConfirm={handleDeletePet} onCancel={() => setConfirmDelete(false)} onCloseAutoFocus={returnFocusToPet(pet.id)} />

      {backButton}
      {notice && (
        <p role="status" className="-mt-2 mb-4 text-sm text-muted-foreground" data-testid="pet-stale">
          {staleNoticeText(notice, pet.name)}
        </p>
      )}

      <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
        <div className="space-y-6 md:col-span-1">
          <Card className="overflow-hidden">
            <CardHeader className="relative p-0">
              {canEdit && (
                <div className="absolute right-2 top-2 z-10">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="secondary" size="icon" aria-label={`Open actions for ${pet.name}`} data-pet-actions={pet.id} className="h-9 w-9 rounded-full bg-background/80 shadow-raised hover:bg-background">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setPetToEdit(pet)}>
                        <Edit className="mr-2 h-4 w-4" />
                        <span>Edit</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setConfirmDelete(true)} className="text-destructive focus:bg-destructive/10 focus:text-destructive">
                        <Trash2 className="mr-2 h-4 w-4" />
                        <span>Delete</span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
              <PetPhoto
                name={pet.name}
                type={pet.type}
                hint={pet.dataAiHint}
                photoUrl={pet.photoUrl}
                sizes="(max-width: 768px) 100vw, 33vw"
                priority
                className="aspect-[4/3] w-full"
                frameStyle={morphStyle(petPhotoMorphName(pet.id))}
                frameTestId="pet-hero"
              />
            </CardHeader>
            <CardContent className="space-y-4 p-4">
              <div>
                <h1 tabIndex={-1} data-pets-heading className="break-words font-headline text-3xl font-bold tracking-tight [overflow-wrap:anywhere] focus:outline-none">{pet.name}</h1>
                <p className="text-sm text-muted-foreground">{petTypeLabel(pet)}</p>
              </div>
              <div className="flex flex-col gap-3">
                <PetCareSummary pet={pet} householdId={householdId} maxMedicationChips={4} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="font-headline text-xl">Info</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-start gap-3">
                <CalendarDays aria-hidden className="mt-1 h-4 w-4 flex-shrink-0 text-muted-foreground" />
                <div>
                  <h2 className="font-semibold">Feeding schedule</h2>
                  <p className="text-muted-foreground">{pet.foodSchedule}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Utensils aria-hidden className="mt-1 h-4 w-4 flex-shrink-0 text-muted-foreground" />
                <div>
                  <h2 className="font-semibold">Usual portion</h2>
                  <p className="text-muted-foreground">
                    {formatPortion(plan.amount, plan.unit)}
                    {plan.perDay ? `, ${plan.perDay} ${plan.perDay === 1 ? 'time' : 'times'} a day` : ''}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="md:col-span-2">
          <Tabs value={tab} onValueChange={(value) => { if ((PET_TABS as readonly string[]).includes(value)) chooseTab(value as PetTab); }}>
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="feeding"><Utensils className="mr-2" /> Feeding</TabsTrigger>
              <TabsTrigger value="medication"><Pill className="mr-2" /> Medication</TabsTrigger>
              <TabsTrigger value="care"><Sparkles className="mr-2" /> Care</TabsTrigger>
            </TabsList>
            <TabsContent value="feeding">
              <FeedingLogClient petId={pet.id} petName={pet.name} plan={plan} />
            </TabsContent>
            <TabsContent value="medication">
              <MedicationLogClient petId={pet.id} />
            </TabsContent>
            <TabsContent value="care">
              <CareLogClient petId={pet.id} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
