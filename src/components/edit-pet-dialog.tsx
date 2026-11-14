"use client"

import { useCallback, useState } from "react";
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
import { hasRealPhoto } from "@/lib/pets/care";
import { readMealPlan } from "@/lib/pets/meal-plan";
import type { PetProfile } from "@/lib/pets/types";
import { usePetPhotoDraft, type PetPhotoChoice } from "./pets/pet-photo-draft";
import {
  EMPTY_PET_FORM,
  NO_DRAFT_ERRORS,
  PetFormFields,
  hasDraftErrors,
  validatePetDraft,
  type PetDraftErrors,
  focusFirstError,
  petFieldsFromForm,
  petFormFromProfile,
  type PetFields,
  type PetFormState,
} from "./pets/pet-form";

interface EditPetDialogProps {
  pet: PetProfile | null;
  /** The other pets' names (a rename is checked against them, case-insensitive, PE-30c). */
  otherNames?: string[];
  /**
   * Resolves true when saved, `'name-taken'` when a fresh read found the name in
   * use (shown under the field); other failures are reported by the caller as toasts.
   */
  onUpdatePet: (fields: PetFields, photo: PetPhotoChoice) => Promise<boolean | 'name-taken'>;
  onOpenChange: (isOpen: boolean) => void;
  /** Where focus goes on close (PE-20e): the pet's actions button when opened from its menu. */
  onCloseAutoFocus?: (event: Event) => void;
}

const ID_PREFIX = "edit-pet";

const NO_NAMES: string[] = [];

export function EditPetDialog({ pet, otherNames = NO_NAMES, onUpdatePet, onOpenChange, onCloseAutoFocus }: EditPetDialogProps) {
  const [values, setValues] = useState<PetFormState>(EMPTY_PET_FORM);
  const storedPhoto = pet?.photoUrl;
  const photo = usePetPhotoDraft(useCallback(() => hasRealPhoto(storedPhoto), [storedPhoto]));
  const [errors, setErrors] = useState<PetDraftErrors>(NO_DRAFT_ERRORS);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);

  // Reset the form on every opening (adjusting state during render, so the first
  // frame already shows the right values). Closing clears the tracked pet, so
  // reopening the same pet discards an unsaved draft and a discarded photo.
  const [formPet, setFormPet] = useState<PetProfile | null>(null);
  // Stored values: unchanged ones are exempt from rules added after the pet was
  // created (e.g. a legacy name over 40 characters cannot block a photo change).
  const [original, setOriginal] = useState<PetFormState>(EMPTY_PET_FORM);
  if (!pet && formPet) {
    setFormPet(null);
  }
  if (pet && pet !== formPet) {
    setFormPet(pet);
    const stored = petFormFromProfile(pet);
    setValues(stored);
    setOriginal(stored);
    photo.reset();
    setErrors(NO_DRAFT_ERRORS);
    setSubmitted(false);
  }

  const change = (patch: Partial<PetFormState>) => {
    const next = { ...values, ...patch };
    setValues(next);
    if (submitted) setErrors(validatePetDraft(next, otherNames, original, Boolean(pet && readMealPlan(pet))));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSubmitted(true);
    if (photo.busy) return;
    // A renamed pet is checked against the other pets' names (PE-30c).
    const nextErrors = validatePetDraft(values, otherNames, original, Boolean(pet && readMealPlan(pet)));
    setErrors(nextErrors);
    if (hasDraftErrors(nextErrors)) {
      focusFirstError(ID_PREFIX, nextErrors);
      return;
    }
    if (photo.error) {
      // The rejected photo is still shown: point at it instead of saving without it.
      document.getElementById(`${ID_PREFIX}-photo`)?.focus();
      return;
    }
    setSaving(true);
    try {
      // An unchanged type keeps the stored photo hint (legacy species art, PE-8a).
      const saved = await onUpdatePet(petFieldsFromForm(values, pet), photo.choice);
      if (saved === 'name-taken') {
        const taken = { ...nextErrors, fields: { ...nextErrors.fields, name: `You already have a pet named ${values.name.trim()}.` } };
        setErrors(taken);
        focusFirstError(ID_PREFIX, taken);
      } else if (saved) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!pet} onOpenChange={(isOpen) => { if (!saving) onOpenChange(isOpen); }}>
      <DialogContent
        className="max-h-[min(90vh,calc(var(--dialog-max-h)_-_var(--keyboard-inset,0px)))] overflow-y-auto sm:max-w-[460px]"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <form onSubmit={handleSubmit} noValidate>
          <DialogHeader>
            <DialogTitle className="font-headline break-words">Edit {pet?.name}</DialogTitle>
            <DialogDescription>
              Rename, or update the photo, type, feeding schedule, meal times and vet.
            </DialogDescription>
          </DialogHeader>
          <PetFormFields
            idPrefix={ID_PREFIX}
            values={values}
            errors={errors}
            onChange={change}
            onPhotoChange={(file) => void photo.pick(file)}
            existingPhotoUrl={hasRealPhoto(pet?.photoUrl) ? pet?.photoUrl : undefined}
            photoBusy={photo.busy}
            photoError={photo.error}
            pet={pet}
          />
          <DialogFooter className="gap-2 pt-2">
            <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || photo.busy}>
              {saving && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
