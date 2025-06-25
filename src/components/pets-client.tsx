

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { db } from '@/lib/firebase';
import { collection, doc, getDocs, setDoc, getDoc, deleteDoc, updateDoc } from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { v4 as uuidv4 } from 'uuid';
import type { Pet } from '@/lib/types';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/card';
import Image from 'next/image';
import { AddPetDialog } from './add-pet-dialog';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { CalendarDays, MoreVertical, Edit, Trash2, Loader2, ArrowRight } from 'lucide-react';
import { EditPetDialog } from './edit-pet-dialog';
import { DeletePetAlert } from './delete-pet-alert';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import Link from 'next/link';
import { slugify } from '@/lib/utils';


function PetCard({ pet, onEdit, onDelete }: { pet: Pet, onEdit: (pet: Pet) => void, onDelete: (petId: string) => void }) {
  const handleEditClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onEdit(pet);
  };
  
  const handleDeleteClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onDelete(pet.id);
  }

  return (
    <Link href={`/pets/${pet.id}`} className="block hover:shadow-lg transition-shadow rounded-lg">
      <Card className="flex flex-col h-full">
        <CardHeader className="p-0 relative">
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
          <div className="relative w-full h-48">
              <Image
                  src={pet.photoUrl || 'https://placehold.co/300x300.png'}
                  alt={`Photo of ${pet.name}`}
                  fill
                  className="object-cover rounded-t-lg"
                  data-ai-hint={pet.dataAiHint}
              />
          </div>
        </CardHeader>
        <CardContent className="p-4 flex-grow">
          <CardTitle className="font-headline text-xl">{pet.name}</CardTitle>
          <CardDescription>{pet.type}</CardDescription>
          <div className="flex items-start gap-2 text-sm text-muted-foreground mt-4">
              <CalendarDays className="h-4 w-4 mt-1 flex-shrink-0" />
              <div>
                  <h4 className="font-semibold text-foreground">Feeding Schedule</h4>
                  <p className="line-clamp-2">{pet.foodSchedule}</p>
              </div>
          </div>
        </CardContent>
        <CardFooter className="p-4 pt-0">
          <Button variant="secondary" className="w-full">
            View Details <ArrowRight className="ml-2" />
          </Button>
        </CardFooter>
      </Card>
    </Link>
  )
}

function PetSkeleton() {
    return (
        <Card>
            <CardHeader className="p-0">
                <Skeleton className="h-48 w-full rounded-t-lg" />
            </CardHeader>
            <CardContent className="p-4 space-y-2">
                <Skeleton className="h-6 w-1/2" />
                <Skeleton className="h-4 w-1/4" />
                <div className="pt-4 space-y-2">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-4 w-3/4" />
                </div>
            </CardContent>
             <CardFooter className="p-4">
                 <Skeleton className="h-10 w-full" />
            </CardFooter>
        </Card>
    );
}

export function PetsClient() {
  const { currentUser } = useAuth();
  const [pets, setPets] = useState<Pet[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();
  const [petToEdit, setPetToEdit] = useState<Pet | null>(null);
  const [petToDelete, setPetToDelete] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const getPetsCollectionRef = useCallback(() => {
    if (!currentUser?.householdId) return null;
    return collection(db, 'households', currentUser.householdId, 'pets');
  }, [currentUser]);

  const fetchPets = useCallback(async () => {
    const petsCollection = getPetsCollectionRef();
    if (!petsCollection) {
        setPets([]);
        setLoading(false);
        return;
    }
    setLoading(true);
    try {
        const querySnapshot = await getDocs(petsCollection);
        const petsData = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Pet));
        setPets(petsData.sort((a,b) => a.name.localeCompare(b.name)));
    } catch (error) {
        console.error("Error fetching pets:", error);
        toast({ variant: 'destructive', title: 'Error', description: 'Could not fetch your pets.' });
    } finally {
        setLoading(false);
    }
  }, [getPetsCollectionRef, toast]);

  useEffect(() => {
    if (currentUser?.householdId) {
      fetchPets();
    } else {
      setLoading(false);
    }
  }, [currentUser, fetchPets]);

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

  const handleAddPet = async (newPetData: Omit<Pet, 'id'>, photoFile: File | null): Promise<boolean> => {
    setIsSubmitting(true);
    const petsCollection = getPetsCollectionRef();
    if (!petsCollection) {
        toast({ variant: 'destructive', title: 'Error', description: 'User not in a household.' });
        setIsSubmitting(false);
        return false;
    }

    const petId = slugify(newPetData.name);
    const petDocRef = doc(petsCollection, petId);

    try {
        const docSnap = await getDoc(petDocRef);
        if (docSnap.exists()) {
            toast({ variant: 'destructive', title: 'Duplicate Name', description: 'A pet with this name already exists. Please choose a unique name.' });
            setIsSubmitting(false);
            return false;
        }

        let photoUrl = 'https://placehold.co/300x300.png';
        if (photoFile) {
            photoUrl = await uploadPhoto(photoFile);
        }

        await setDoc(petDocRef, { ...newPetData, photoUrl });
        await fetchPets(); // Refresh the list
        return true;
    } catch(error) {
        console.error("Error adding pet:", error);
        toast({ variant: 'destructive', title: 'Database Error', description: 'Could not add the new pet.' });
        return false;
    } finally {
        setIsSubmitting(false);
    }
  };

  const handleUpdatePet = async (updatedPetData: Omit<Pet, 'id'>, photoFile: File | null, isPhotoRemoved: boolean): Promise<boolean> => {
    setIsSubmitting(true);
    const petsCollection = getPetsCollectionRef();
    if (!petsCollection || !petToEdit) {
      toast({ variant: "destructive", title: "Error", description: "Could not update pet."});
      setIsSubmitting(false);
      return false;
    }

    const petDocRef = doc(petsCollection, petToEdit.id);
    try {
      let photoUrl = updatedPetData.photoUrl;

      if (photoFile) {
        // New photo uploaded, replace old one
        photoUrl = await uploadPhoto(photoFile);
      } else if (isPhotoRemoved) {
        // Photo was removed by user
        photoUrl = 'https://placehold.co/300x300.png';
      }
      
      await updateDoc(petDocRef, { ...updatedPetData, photoUrl });
      await fetchPets();
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
    const petsCollection = getPetsCollectionRef();
    if (!petsCollection || !petToDelete) {
      toast({ variant: "destructive", title: "Error", description: "Could not delete pet."});
      return;
    }

    const petDocRef = doc(petsCollection, petToDelete);
    try {
      // Here you might want to delete the photo from storage before deleting the doc
      await deleteDoc(petDocRef);
      await fetchPets();
      setPetToDelete(null);
      toast({ title: "Pet Deleted", description: "The pet has been removed from your family." });
    } catch (error) {
      console.error("Error deleting pet: ", error);
      toast({ variant: "destructive", title: "Database Error", description: "Could not delete pet."});
    }
  }


  if (loading) {
    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            <PetSkeleton />
            <PetSkeleton />
            <PetSkeleton />
        </div>
    )
  }

  return (
    <div>
      <div className="flex justify-end mb-4">
        <AddPetDialog onAddPet={handleAddPet} />
      </div>

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

      {pets.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {pets.map(pet => (
            <PetCard key={pet.id} pet={pet} onEdit={setPetToEdit} onDelete={setPetToDelete} />
          ))}
        </div>
      ) : (
        <div className="text-center py-16 border-2 border-dashed rounded-lg">
          <h2 className="text-xl font-semibold">No Pets Yet</h2>
          <p className="text-muted-foreground mt-2">Click "Add Pet" to get started!</p>
        </div>
      )}
    </div>
  );
}
