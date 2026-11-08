'use client';

import { useParams } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import { petPhotoMorphName } from '@/lib/pets/care';
import { morphStyle } from '@/lib/motion';
import { cn } from '@/lib/utils';

/**
 * The pet page's photo skeleton in the route loading state. It carries the pet
 * photo's shared-element name (from the route's `petId`), so the /pets card →
 * pet hero morph (H12) lands here when the route is still loading.
 */
export function PetPhotoSkeleton({ className }: { className?: string }) {
  const params = useParams<{ petId?: string }>();
  const petId = typeof params?.petId === 'string' ? params.petId : null;
  return <Skeleton className={cn('h-80 w-full rounded-lg', className)} style={petId ? morphStyle(petPhotoMorphName(petId)) : undefined} />;
}
