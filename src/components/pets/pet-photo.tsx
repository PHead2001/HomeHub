'use client';

import * as React from 'react';
import Image from 'next/image';
import { cn } from '@/lib/utils';
import { hasRealPhoto, PET_PHOTO_FOCUS } from '@/lib/pets/care';
import { SpeciesAvatar } from './species-avatar';

export type PetPhotoProps = {
  name: string;
  type?: string | null;
  hint?: string | null;
  photoUrl?: string | null;
  sizes: string;
  priority?: boolean;
  /** Classes for the frame (size, rounding). The frame is `relative overflow-hidden`. */
  className?: string;
  blinkOffset?: number;
};

/**
 * A pet photo with a face-safe cover crop (focal point above center) through
 * `next/image`, or the illustrated species avatar when there is no photo, the
 * photo is the legacy placeholder, or it fails to load (D17).
 */
export function PetPhoto({ name, type, hint, photoUrl, sizes, priority, className, blinkOffset }: PetPhotoProps) {
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null);
  const showPhoto = hasRealPhoto(photoUrl) && failedUrl !== photoUrl;

  return (
    <div className={cn('relative overflow-hidden bg-muted/40', className)}>
      {showPhoto ? (
        <Image
          src={photoUrl}
          alt={`Photo of ${name}`}
          fill
          sizes={sizes}
          priority={priority}
          className="object-cover"
          style={{ objectPosition: PET_PHOTO_FOCUS }}
          onError={() => setFailedUrl(photoUrl)}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-primary/5">
          <SpeciesAvatar type={type} hint={hint} name={name} blinkOffset={blinkOffset} className="h-[78%] max-h-40 w-auto" />
        </div>
      )}
    </div>
  );
}
