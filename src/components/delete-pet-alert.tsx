"use client"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { buttonVariants } from "./ui/button";
import { useBackCloses } from '@/hooks/use-back-closes';

interface DeletePetAlertProps {
  isOpen: boolean;
  /** Pet name for the title; falls back to "this pet". */
  petName?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Where focus goes on close (PE-20e), when the dialog was opened from a menu. */
  onCloseAutoFocus?: (event: Event) => void;
}

export function DeletePetAlert({ isOpen, petName, onConfirm, onCancel, onCloseAutoFocus }: DeletePetAlertProps) {
  const target = petName || "this pet";
  // Android Back closes this dialog first (emulator evidence D4).
  useBackCloses(isOpen, onCancel);

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">Delete {target}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes {target} from your household. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={buttonVariants({ variant: "destructive" })}
          >
            Delete Pet
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
