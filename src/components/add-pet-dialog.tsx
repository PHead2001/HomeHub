"use client"

import { useState } from "react";
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { PlusCircle } from "lucide-react"
import type { Pet } from "@/lib/types";
import { useToast } from "@/hooks/use-toast";
import { ImageUpload } from "./image-upload";


interface AddPetDialogProps {
    onAddPet: (pet: Omit<Pet, 'id'>, photoFile: File | null) => Promise<boolean>;
}

export function AddPetDialog({ onAddPet }: AddPetDialogProps) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();

  const [name, setName] = useState('');
  const [type, setType] = useState<Pet['type']>('Dog');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [foodSchedule, setFoodSchedule] = useState('');

  const clearForm = () => {
    setName('');
    setType('Dog');
    setPhotoFile(null);
    setFoodSchedule('');
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

    const wasAdded = await onAddPet({
        name,
        type,
        photoUrl: '', // This will be replaced by the uploader
        dataAiHint: `${type.toLowerCase()}`,
        foodSchedule,
    }, photoFile);

    if (wasAdded) {
      toast({ title: "Pet Added!", description: `${name} has been added to your family.` });
      setOpen(false);
      clearForm();
    }
  };


  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
        setOpen(isOpen);
        if (!isOpen) clearForm();
    }}>
      <DialogTrigger asChild>
        <Button><PlusCircle className="mr-2" /> Add Pet</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="font-headline">Add a new pet</DialogTitle>
          <DialogDescription>
            Fill in the details for your new furry family member.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
           <div className="grid grid-cols-4 items-center gap-4">
             <Label className="text-right">
              Photo
            </Label>
            <div className="col-span-3">
                <ImageUpload onFileChange={setPhotoFile} />
            </div>
           </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="name" className="text-right">
              Name
            </Label>
            <Input id="name" value={name} onChange={e => setName(e.target.value)} placeholder="Buddy" className="col-span-3" />
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="type" className="text-right">
              Type
            </Label>
            <Select onValueChange={(value: Pet['type']) => setType(value)} defaultValue={type}>
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
          <Button onClick={handleSubmit}>Save Pet</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
