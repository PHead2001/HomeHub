'use client';

import { useEffect, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';

export type LibraryPhoto = { name: string; imageUrl?: string };
type PhotoState = { householdId: string; photos: ReadonlyMap<string, LibraryPhoto> } | null;

/**
 * Live map of the household's Barcode Library products (name and photo) by
 * barcode (one listener), so shopping rows (`rowPhoto`) and pantry tiles
 * (`productPhotoForName`) show a product's current photo. Null while the
 * first snapshot is pending, after a failed read, or for another household.
 */
export function useLibraryPhotos(householdId: string | null): ReadonlyMap<string, LibraryPhoto> | null {
  const [state, setState] = useState<PhotoState>(null);
  useEffect(() => {
    if (!householdId) return;
    return onSnapshot(
      collection(db, 'households', householdId, 'barcode-library'),
      (snapshot) => {
        const photos = new Map<string, LibraryPhoto>();
        snapshot.docs.forEach((document) => {
          const imageUrl = document.get('imageUrl');
          const name = document.get('name');
          photos.set(document.id, { name: typeof name === 'string' ? name : '', imageUrl: typeof imageUrl === 'string' ? imageUrl : '' });
        });
        setState({ householdId, photos });
      },
      // A failed read only drops back to the stored URLs (rows hide a broken image).
      () => setState(null),
    );
  }, [householdId]);
  return state && state.householdId === householdId ? state.photos : null;
}
