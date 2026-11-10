'use client';

import { useEffect, useState, use } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { doc, onSnapshot } from 'firebase/firestore';
import { CalendarDays, Edit, Home, MoreVertical, Pill, Sparkles, Trash2, Utensils } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/lib/firebase';
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

const TABS = ['feeding', 'medication', 'care'] as const;
type PetTab = (typeof TABS)[number];

export default function PetDetailPage({ params }: { params: Promise<{ petId: string }> }) {
  const { petId } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast, toastError } = useToast();
  const { currentUser, permissions, loading: authLoading } = useAuth();
  const householdId = currentUser?.householdId ?? null;
  const canEdit = Boolean(permissions['pets.editProfiles']);

  const [petToEdit, setPetToEdit] = useState<PetProfile | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const requestedTab = searchParams.get('tab');
  const [tab, setTab] = useState<PetTab>(TABS.includes(requestedTab as PetTab) ? (requestedTab as PetTab) : 'feeding');

  // Live pet document: edits from other members appear without a refresh. Keyed by
  // path so navigating between pets never shows the previous one.
  const docKey = householdId ? `${householdId}/${petId}` : null;
  const [loaded, setLoaded] = useState<{ key: string | null; pet: PetProfile | null; failed: boolean }>({ key: null, pet: null, failed: false });
  useEffect(() => {
    if (!householdId || !docKey) return;
    return onSnapshot(
      doc(db, 'households', householdId, 'pets', petId),
      (snapshot) => {
        setLoaded({
          key: docKey,
          pet: snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as PetProfile) : null,
          failed: false,
        });
      },
      (error) => {
        console.error('Error loading pet:', error);
        setLoaded({ key: docKey, pet: null, failed: true });
        toastError(error, "Couldn't load this pet");
      },
    );
  }, [householdId, petId, docKey, toastError]);

  const ready = loaded.key === docKey;
  const loading = authLoading || (Boolean(docKey) && !ready);
  const pet = ready ? loaded.pet : null;
  const loadFailed = ready && loaded.failed;
  const missing = ready && !loaded.failed && !loaded.pet;

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
          <Home className="mr-2" />
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
            title={missing ? 'This pet isn’t here' : 'This pet is unavailable right now'}
            description={missing ? 'It may have been removed. Your other pets are still on the Pets page.' : "We couldn't load this pet. Check your connection and try again."}
            action={loadFailed ? { label: 'Try again', onClick: () => window.location.reload() } : { label: 'All pets', href: '/pets' }}
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
      <EditPetDialog pet={petToEdit} onUpdatePet={handleUpdatePet} onOpenChange={(isOpen) => !isOpen && setPetToEdit(null)} />
      <DeletePetAlert isOpen={confirmDelete} petName={pet.name} onConfirm={handleDeletePet} onCancel={() => setConfirmDelete(false)} />

      {backButton}

      <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
        <div className="space-y-6 md:col-span-1">
          <Card className="overflow-hidden">
            <CardHeader className="relative p-0">
              {canEdit && (
                <div className="absolute right-2 top-2 z-10">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="secondary" size="icon" aria-label={`Open actions for ${pet.name}`} className="h-9 w-9 rounded-full bg-background/80 shadow-raised hover:bg-background">
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
                <h1 className="font-headline text-3xl font-bold tracking-tight">{pet.name}</h1>
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
          <Tabs value={tab} onValueChange={(value) => setTab(value as PetTab)}>
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
