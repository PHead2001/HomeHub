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

interface DeletePetAlertProps {
  isOpen: boolean;
  /** Pet name for the title; falls back to "this pet". */
  petName?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeletePetAlert({ isOpen, petName, onConfirm, onCancel }: DeletePetAlertProps) {
  const target = petName || "this pet";
  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {target}?</AlertDialogTitle>
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
