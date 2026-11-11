'use client';

import { useEffect, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';

type PhotoState = { householdId: string; photos: ReadonlyMap<string, { imageUrl?: string }> } | null;

/**
 * Live map of the household's Barcode Library photos by barcode (one listener),
 * so shopping rows show a product's current photo (`rowPhoto`). Null while the
 * first snapshot is pending, after a failed read, or for another household.
 */
export function useLibraryPhotos(householdId: string | null): ReadonlyMap<string, { imageUrl?: string }> | null {
  const [state, setState] = useState<PhotoState>(null);
  useEffect(() => {
    if (!householdId) return;
    return onSnapshot(
      collection(db, 'households', householdId, 'barcode-library'),
      (snapshot) => {
        const photos = new Map<string, { imageUrl?: string }>();
        snapshot.docs.forEach((document) => {
          const imageUrl = document.get('imageUrl');
          photos.set(document.id, { imageUrl: typeof imageUrl === 'string' ? imageUrl : '' });
        });
        setState({ householdId, photos });
      },
      // A failed read only drops back to the stored URLs (rows hide a broken image).
      () => setState(null),
    );
  }, [householdId]);
  return state && state.householdId === householdId ? state.photos : null;
}
