'use client';

import { useCallback, useRef, useState } from 'react';
import { downscaleErrorCopy, downscaleImage } from '@/lib/images/downscale';
import { PET_PHOTO_MAX_BYTES } from '@/lib/pets/profile';

/** What the dialog will do with the photo on save. */
export type PetPhotoChoice = { kind: 'keep' } | { kind: 'replace'; file: File } | { kind: 'remove' };

/**
 * The add/edit dialogs' photo draft (PE-21e): a picked photo is shrunk at once
 * with the shared helper (`downscaleImage`, longer edge 1024 px, at most 5 MB,
 * the barcode library's limits and inline copy), so a photo that still does not
 * fit is reported under the field before anything is saved. A newer pick wins
 * over a slower earlier one.
 */
export function usePetPhotoDraft(hasStoredPhoto: () => boolean) {
  const [choice, setChoice] = useState<PetPhotoChoice>({ kind: 'keep' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickRef = useRef(0);

  const pick = useCallback(async (file: File | null) => {
    const current = ++pickRef.current;
    setError(null);
    if (!file) {
      setBusy(false);
      setChoice(hasStoredPhoto() ? { kind: 'remove' } : { kind: 'keep' });
      return;
    }
    setBusy(true);
    const result = await downscaleImage(file, { maxBytes: PET_PHOTO_MAX_BYTES });
    if (current !== pickRef.current) return;
    setBusy(false);
    if (result.ok) {
      setChoice({ kind: 'replace', file: result.file });
    } else {
      setChoice({ kind: 'keep' });
      setError(downscaleErrorCopy(result.reason, PET_PHOTO_MAX_BYTES));
    }
  }, [hasStoredPhoto]);

  const reset = useCallback(() => {
    pickRef.current += 1;
    setChoice({ kind: 'keep' });
    setBusy(false);
    setError(null);
  }, []);

  return { choice, busy, error, pick, reset };
}
