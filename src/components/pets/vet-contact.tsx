'use client';

import { Phone, Stethoscope } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { hasVetContact, telHref } from '@/lib/pets/profile';
import type { PetProfile } from '@/lib/pets/types';

/**
 * The pet's vet contact on the pet page (PE-28a, D-P10): clinic, vet and a phone
 * number that calls through a `tel:` link (a 48 px target on touch screens).
 * Editors without a saved contact get "Add vet contact" (the edit dialog).
 */
export function VetContact({ pet, onEdit }: { pet: PetProfile; onEdit?: () => void }) {
  const phone = typeof pet.vetPhone === 'string' ? pet.vetPhone.trim() : '';
  const href = telHref(phone);
  return (
    <div className="flex items-start gap-3" data-testid="vet-contact">
      <Stethoscope aria-hidden className="mt-1 h-4 w-4 flex-shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-1">
        <h2 className="font-semibold">Vet</h2>
        {hasVetContact(pet) ? (
          <>
            {pet.vetClinic && <p className="break-words text-muted-foreground">{pet.vetClinic}</p>}
            {pet.vetName && <p className="break-words text-muted-foreground">{pet.vetName}</p>}
            {phone && (href ? (
              <Button asChild variant="outline" size="sm" className="mt-1">
                <a href={href} aria-label={`Call ${pet.vetClinic || pet.vetName || 'the vet'} at ${phone}`}>
                  <Phone aria-hidden className="mr-2 h-4 w-4" />
                  {phone}
                </a>
              </Button>
            ) : (
              <p className="text-muted-foreground">{phone}</p>
            ))}
          </>
        ) : (
          <>
            <p className="text-muted-foreground">No vet saved.</p>
            {onEdit && (
              <Button type="button" variant="outline" size="sm" className="mt-1" onClick={onEdit}>
                Add vet contact
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
