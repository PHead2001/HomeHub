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

interface AddPetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names already used in the household (duplicates are rejected inline). */
  existingNames: string[];
  /** Resolves true when saved; failures are reported by the caller as outcome toasts. */
  onAddPet: (fields: PetFields, photoFile: File | null) => Promise<boolean>;
}

const ID_PREFIX = "add-pet";

export function AddPetDialog({ open, onOpenChange, existingNames, onAddPet }: AddPetDialogProps) {
  const [values, setValues] = useState<PetFormState>(EMPTY_PET_FORM);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<PetDraftErrors>(NO_DRAFT_ERRORS);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setValues(EMPTY_PET_FORM);
    setPhotoFile(null);
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
    const nextErrors = validatePetDraft(values, existingNames);
    setErrors(nextErrors);
    if (hasDraftErrors(nextErrors)) {
      focusFirstError(ID_PREFIX, nextErrors);
      return;
    }
    setSaving(true);
    try {
      const saved = await onAddPet(petFieldsFromForm(values), photoFile);
      if (saved) {
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
            onPhotoChange={setPhotoFile}
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
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
              Save Pet
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
