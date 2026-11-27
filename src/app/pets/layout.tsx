import type { ReactNode } from 'react';
import { PetsCareProvider } from '@/components/pets/care-store';
import { sectionMetadata } from '@/lib/shell/page-titles';

// SL-13: "Pets - HomeHub" on /pets and every pet page.
export const metadata = sectionMetadata('pets');

// The household's Pets care store (PE-21a) spans `/pets` and every pet page, so a
// pet's live data is subscribed once and reused when a card opens its page.
export default function PetsLayout({ children }: { children: ReactNode }) {
  return <PetsCareProvider>{children}</PetsCareProvider>;
}
