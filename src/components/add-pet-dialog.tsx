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
import {
  EMPTY_PET_FORM,
  NO_DRAFT_ERRORS,
  PetFormFields,
  hasDraftErrors,
  validatePetDraft,
  type PetDraftErrors,
  focusFirstError,
  petFieldsFromForm,
  type PetFields,
  type PetFormState,
} from "./pets/pet-form";
import { usePetPhotoDraft } from "./pets/pet-photo-draft";
import { newPetId } from "@/lib/pets/profile";

interface AddPetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names already used in the household (duplicates are rejected inline). */
  existingNames: string[];
  /**
   * Resolves true when saved, `'name-taken'` when a fresh read found the name in
   * use; other failures are reported by the caller as outcome toasts. `petId` is
   * the dialog's one id (PE-30b), so a double submit or a retry writes one pet.
   */
  onAddPet: (petId: string, fields: PetFields, photoFile: File | null) => Promise<boolean | 'name-taken'>;
}

const ID_PREFIX = "add-pet";

export function AddPetDialog({ open, onOpenChange, existingNames, onAddPet }: AddPetDialogProps) {
  const [values, setValues] = useState<PetFormState>(EMPTY_PET_FORM);
  const photo = usePetPhotoDraft(useCallback(() => false, []));
  // One id per opening (a new pet is never keyed by its name).
  const [petId, setPetId] = useState(newPetId);
  const [errors, setErrors] = useState<PetDraftErrors>(NO_DRAFT_ERRORS);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setValues(EMPTY_PET_FORM);
    photo.reset();
    setPetId(newPetId());
    setErrors(NO_DRAFT_ERRORS);
    setSubmitted(false);
  };

  const change = (patch: Partial<PetFormState>) => {
    const next = { ...values, ...patch };
    setValues(next);
    // After the first submit, errors update as the member fixes them.
    if (submitted) setErrors(validatePetDraft(next, existingNames));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSubmitted(true);
    if (photo.busy) return;
    const nextErrors = validatePetDraft(values, existingNames);
    setErrors(nextErrors);
    if (hasDraftErrors(nextErrors)) {
      focusFirstError(ID_PREFIX, nextErrors);
      return;
    }
    if (photo.error) {
      document.getElementById(`${ID_PREFIX}-photo`)?.focus();
      return;
    }
    setSaving(true);
    try {
      const saved = await onAddPet(petId, petFieldsFromForm(values), photo.choice.kind === 'replace' ? photo.choice.file : null);
      if (saved === 'name-taken') {
        const taken = { ...nextErrors, fields: { ...nextErrors.fields, name: `You already have a pet named ${values.name.trim()}.` } };
        setErrors(taken);
        focusFirstError(ID_PREFIX, taken);
      } else if (saved) {
        onOpenChange(false);
        reset();
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (saving) return;
        onOpenChange(isOpen);
        if (!isOpen) reset();
      }}
    >
      <DialogContent className="max-h-[min(90vh,calc(var(--dialog-max-h)_-_var(--keyboard-inset,0px)))] overflow-y-auto sm:max-w-[460px]">
        <form onSubmit={handleSubmit} noValidate>
          <DialogHeader>
            <DialogTitle className="font-headline">Add a new pet</DialogTitle>
            <DialogDescription>
              A name and a feeding schedule or meal times are all you need. Everything else is optional.
            </DialogDescription>
          </DialogHeader>
          <PetFormFields
            idPrefix={ID_PREFIX}
            values={values}
            errors={errors}
            onChange={change}
            onPhotoChange={(file) => void photo.pick(file)}
            photoBusy={photo.busy}
            photoError={photo.error}
          />
          <DialogFooter className="gap-2 pt-2">
            {/* PE-18d: an explicit way out besides the corner X and Escape. */}
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => {
                onOpenChange(false);
                reset();
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving || photo.busy}>
              {saving && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
              Save Pet
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
