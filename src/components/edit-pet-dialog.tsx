"use client"

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { hasRealPhoto, validatePetForm, type PetFormErrors } from "@/lib/pets/care";
import type { PetProfile } from "@/lib/pets/types";
import {
  EMPTY_PET_FORM,
  PetFormFields,
  focusFirstError,
  petFieldsFromForm,
  petFormFromProfile,
  type PetFields,
  type PetFormState,
} from "./pets/pet-form";

interface EditPetDialogProps {
  pet: PetProfile | null;
  /** Resolves true when saved; failures are reported by the caller as outcome toasts. */
  onUpdatePet: (fields: PetFields, photoFile: File | null, isPhotoRemoved: boolean) => Promise<boolean>;
  onOpenChange: (isOpen: boolean) => void;
}

const ID_PREFIX = "edit-pet";

export function EditPetDialog({ pet, onUpdatePet, onOpenChange }: EditPetDialogProps) {
  const [values, setValues] = useState<PetFormState>(EMPTY_PET_FORM);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [isPhotoRemoved, setIsPhotoRemoved] = useState(false);
  const [errors, setErrors] = useState<PetFormErrors>({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);

  // Reset the form on every opening (adjusting state during render, so the first
  // frame already shows the right values). Closing clears the tracked pet, so
  // reopening the same pet discards an unsaved draft and a discarded photo.
  const [formPet, setFormPet] = useState<PetProfile | null>(null);
  if (!pet && formPet) {
    setFormPet(null);
  }
  if (pet && pet !== formPet) {
    setFormPet(pet);
    setValues(petFormFromProfile(pet));
    setPhotoFile(null);
    setIsPhotoRemoved(false);
    setErrors({});
    setSubmitted(false);
  }

  const handlePhotoChange = (file: File | null) => {
    setPhotoFile(file);
    // A new file replaces the photo; null means the member removed it.
    setIsPhotoRemoved(file === null);
  };

  const change = (patch: Partial<PetFormState>) => {
    const next = { ...values, ...patch };
    setValues(next);
    if (submitted) setErrors(validatePetForm(next));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSubmitted(true);
    // The name cannot change here, so duplicate names are not re-checked.
    const nextErrors = validatePetForm(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      focusFirstError(ID_PREFIX, nextErrors);
      return;
    }
    setSaving(true);
    try {
      const saved = await onUpdatePet(petFieldsFromForm(values), photoFile, isPhotoRemoved);
      if (saved) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!pet} onOpenChange={(isOpen) => { if (!saving) onOpenChange(isOpen); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[460px]">
        <form onSubmit={handleSubmit} noValidate>
          <DialogHeader>
            <DialogTitle className="font-headline">Edit {pet?.name}</DialogTitle>
            <DialogDescription>
              Update the photo, type, feeding schedule and usual portion.
            </DialogDescription>
          </DialogHeader>
          <PetFormFields
            idPrefix={ID_PREFIX}
            values={values}
            errors={errors}
            onChange={change}
            onPhotoChange={handlePhotoChange}
            existingPhotoUrl={hasRealPhoto(pet?.photoUrl) ? pet?.photoUrl : undefined}
            nameDisabled
          />
          <DialogFooter className="pt-2">
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
