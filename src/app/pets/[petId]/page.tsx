
'use client';

import { useState, useEffect, useCallback, use } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { db } from '@/lib/firebase';
import { doc, getDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { v4 as uuidv4 } from 'uuid';
import type { Pet } from '@/lib/types';
import { notFound, useRouter } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FeedingLogClient } from '@/components/feeding-log';
import { MedicationLogClient } from '@/components/medication-log';
import { CareLogClient } from '@/components/care-log';
import { CalendarDays, Utensils, Pill, Sparkles, Home, MoreVertical, Edit, Trash2, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import Image from 'next/image';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EditPetDialog } from '@/components/edit-pet-dialog';
import { DeletePetAlert } from '@/components/delete-pet-alert';
import { useToast } from '@/hooks/use-toast';


export default function PetDetailPage({ params }: { params: { petId: string } }) {
  const resolvedParams = use(params);
  const { petId } = resolvedParams;
  const router = useRouter();
  const { toast } = useToast();

  const { currentUser } = useAuth();
  const [pet, setPet] = useState<Pet | null>(null);
  const [loading, setLoading] = useState(true);

  const [petToEdit, setPetToEdit] = useState<Pet | null>(null);
  const [petToDelete, setPetToDelete] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchPet = useCallback(async () => {
    if (!currentUser?.householdId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const petDocRef = doc(db, 'households', currentUser.householdId, 'pets', petId);
    try {
      const docSnap = await getDoc(petDocRef);
      if (docSnap.exists()) {
        setPet({ id: docSnap.id, ...docSnap.data() } as Pet);
      } else {
        notFound();
      }
    } catch (error) {
      console.error("Error fetching pet:", error);
    } finally {
      setLoading(false);
    }
  }, [currentUser, petId]);

  useEffect(() => {
    if (currentUser) {
      fetchPet();
    }
  }, [currentUser, fetchPet]);

  const uploadPhoto = async (photoFile: File): Promise<string> => {
    if (!currentUser?.householdId) throw new Error("User not in a household");
    const storage = getStorage();
    const fileExtension = photoFile.name.split('.').pop();
    const fileName = `${uuidv4()}.${fileExtension}`;
    const storageRef = ref(storage, `households/${currentUser.householdId}/pets/${fileName}`);
    await uploadBytes(storageRef, photoFile);
    const downloadURL = await getDownloadURL(storageRef);
    return downloadURL;
  };

  const handleUpdatePet = async (updatedPetData: Omit<Pet, 'id'>, photoFile: File | null, isPhotoRemoved: boolean): Promise<boolean> => {
    setIsSubmitting(true);
    if (!currentUser?.householdId || !pet) {
      toast({ variant: "destructive", title: "Error", description: "Could not update pet."});
      setIsSubmitting(false);
      return false;
    }

    const petDocRef = doc(db, 'households', currentUser.householdId, 'pets', pet.id);
    try {
      let photoUrl = updatedPetData.photoUrl;
      
      if (photoFile) {
        photoUrl = await uploadPhoto(photoFile);
      } else if (isPhotoRemoved) {
        photoUrl = 'https://placehold.co/300x300.png';
      }
      
      await updateDoc(petDocRef, { ...updatedPetData, photoUrl });
      await fetchPet(); // Refresh the data on the page
      setPetToEdit(null);
      toast({ title: "Pet Updated", description: `${updatedPetData.name}'s info has been updated.`});
      return true;
    } catch (error) {
      console.error("Error updating pet: ", error);
      toast({ variant: "destructive", title: "Database Error", description: "Could not update pet."});
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }

  const handleDeletePet = async () => {
    if (!currentUser?.householdId || !petToDelete) {
      toast({ variant: "destructive", title: "Error", description: "Could not delete pet."});
      return;
    }

    const petDocRef = doc(db, 'households', currentUser.householdId, 'pets', petToDelete);
    try {
      await deleteDoc(petDocRef);
      setPetToDelete(null);
      toast({ title: "Pet Deleted", description: "The pet has been removed from your family." });
      router.push('/pets'); // Redirect to pets list
    } catch (error) {
      console.error("Error deleting pet: ", error);
      toast({ variant: "destructive", title: "Database Error", description: "Could not delete pet."});
    }
  }


  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8 space-y-8">
        <Skeleton className="h-8 w-1/4" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="md:col-span-1 space-y-4">
             <Skeleton className="h-64 w-full" />
             <Skeleton className="h-32 w-full" />
          </div>
          <div className="md:col-span-2">
            <Skeleton className="h-96 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (!pet) {
    return null; // or a not found component
  }

  const handleEditClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPetToEdit(pet);
  };
  
  const handleDeleteClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPetToDelete(pet.id);
  }


  return (
    <div className="container mx-auto px-4 py-8">
      <EditPetDialog
        pet={petToEdit}
        onUpdatePet={handleUpdatePet}
        onOpenChange={(isOpen) => !isOpen && setPetToEdit(null)}
      />

       <DeletePetAlert
        isOpen={!!petToDelete}
        onConfirm={handleDeletePet}
        onCancel={() => setPetToDelete(null)}
      />

       {isSubmitting && (
        <div className="fixed inset-0 bg-background/80 flex items-center justify-center z-50">
            <div className="flex items-center gap-2 text-lg">
                <Loader2 className="h-6 w-6 animate-spin" />
                <p>Processing...</p>
            </div>
        </div>
      )}

       <div className="mb-4">
          <Button asChild variant="outline">
              <Link href="/pets">
                  <Home className="mr-2" />
                  Back to All Pets
              </Link>
          </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        <div className="md:col-span-1 space-y-6">
           <Card>
            <CardHeader className="p-0">
                 <div className="relative w-full h-64">
                    <div className="absolute top-2 right-2 z-10">
                        <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="secondary" size="icon" className="h-8 w-8 rounded-full bg-background/70 hover:bg-background/90" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
                            <MoreVertical className="h-4 w-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={handleEditClick}>
                            <Edit className="mr-2 h-4 w-4" />
                            <span>Edit</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={handleDeleteClick} className="text-destructive focus:text-destructive focus:bg-destructive/10">
                            <Trash2 className="mr-2 h-4 w-4" />
                            <span>Delete</span>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                    <Image
                        src={pet.photoUrl}
                        alt={`Photo of ${pet.name}`}
                        fill
                        className="object-cover rounded-t-lg"
                    />
                </div>
            </CardHeader>
            <CardContent className="p-4">
                <CardTitle className="font-headline text-3xl">{pet.name}</CardTitle>
                <CardDescription>{pet.type}</CardDescription>
            </CardContent>
           </Card>

           <Card>
                <CardHeader>
                    <CardTitle className="font-headline text-xl">Info</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="flex items-start gap-3 text-sm">
                        <CalendarDays className="h-4 w-4 mt-1 flex-shrink-0 text-muted-foreground" />
                        <div>
                            <h4 className="font-semibold">Feeding Schedule</h4>
                            <p className="text-muted-foreground">{pet.foodSchedule}</p>
                        </div>
                    </div>
                </CardContent>
           </Card>
        </div>

        <div className="md:col-span-2">
            <Tabs defaultValue="feeding">
                <TabsList className="grid w-full grid-cols-3">
                    <TabsTrigger value="feeding"><Utensils className="mr-2"/> Feeding</TabsTrigger>
                    <TabsTrigger value="medication"><Pill className="mr-2"/> Medication</TabsTrigger>
                    <TabsTrigger value="care"><Sparkles className="mr-2"/> Care</TabsTrigger>
                </TabsList>
                <TabsContent value="feeding">
                    <FeedingLogClient petId={pet.id} />
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
