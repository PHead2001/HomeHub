"use client"

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { Pet } from "@/lib/types";
import { useToast } from "@/hooks/use-toast";
import { ImageUpload } from "./image-upload";


interface EditPetDialogProps {
    pet: Pet | null;
    onUpdatePet: (pet: Omit<Pet, 'id'>, photoFile: File | null, isPhotoRemoved: boolean) => Promise<boolean>;
    onOpenChange: (isOpen: boolean) => void;
}

export function EditPetDialog({ pet, onUpdatePet, onOpenChange }: EditPetDialogProps) {
  const { toast } = useToast();

  const [name, setName] = useState('');
  const [type, setType] = useState<Pet['type']>('Dog');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [existingPhotoUrl, setExistingPhotoUrl] = useState('');
  const [foodSchedule, setFoodSchedule] = useState('');
  const [isPhotoRemoved, setIsPhotoRemoved] = useState(false);

  useEffect(() => {
    if (pet) {
        setName(pet.name);
        setType(pet.type);
        setExistingPhotoUrl(pet.photoUrl);
        setFoodSchedule(pet.foodSchedule);
        setPhotoFile(null); // Reset file on new pet
        setIsPhotoRemoved(false); // Reset photo removal flag
    }
  }, [pet]);

  const handlePhotoChange = (file: File | null) => {
    setPhotoFile(file);
    // If a new file is selected, it means photo wasn't removed.
    // If file is null, it means it was removed.
    setIsPhotoRemoved(file === null);
  }

  const handleSubmit = async () => {
    if (!name || !type || !foodSchedule) {
        toast({
            variant: "destructive",
            title: "Missing Information",
            description: "Please fill out all fields before saving.",
        });
        return;
    }

    const wasUpdated = await onUpdatePet({
        name,
        type,
        photoUrl: existingPhotoUrl,
        dataAiHint: `${type.toLowerCase()}`,
        foodSchedule,
    }, photoFile, isPhotoRemoved);

    if (wasUpdated) {
        onOpenChange(false);
    }
  };

  return (
    <Dialog open={!!pet} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="font-headline">Edit {pet?.name}</DialogTitle>
          <DialogDescription>
            Update the details for your pet.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
           <div className="grid grid-cols-4 items-center gap-4">
             <Label className="text-right">
              Photo
            </Label>
            <div className="col-span-3">
                <ImageUpload onFileChange={handlePhotoChange} existingImageUrl={existingPhotoUrl} />
            </div>
           </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="name" className="text-right">
              Name
            </Label>
            <Input id="name" value={name} className="col-span-3" disabled />
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="type" className="text-right">
              Type
            </Label>
            <Select onValueChange={(value: Pet['type']) => setType(value)} value={type}>
              <SelectTrigger className="col-span-3">
                <SelectValue placeholder="Select a type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Dog">Dog</SelectItem>
                <SelectItem value="Cat">Cat</SelectItem>
                <SelectItem value="Other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
           <div className="grid grid-cols-4 items-start gap-4">
            <Label htmlFor="schedule" className="text-right pt-2">
              Food Schedule
            </Label>
            <Textarea id="schedule" value={foodSchedule} onChange={e => setFoodSchedule(e.target.value)} placeholder="e.g. Twice a day, 8am and 6pm" className="col-span-3" />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleSubmit}>Save Changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
