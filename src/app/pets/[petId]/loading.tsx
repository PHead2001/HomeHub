import { Skeleton } from '@/components/ui/skeleton';
import { RouteSkeleton } from '@/components/route-skeletons';
import { PetPhotoSkeleton } from '@/components/pets/pet-photo-skeleton';

// Pet detail: back button, photo card and info card, then the tabs panel.
export default function Loading() {
  return (
    <RouteSkeleton label="pet details">
      <Skeleton className="mb-4 h-10 w-44" />
      <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
        <div className="space-y-6 md:col-span-1">
          <PetPhotoSkeleton />
          <Skeleton className="h-32 w-full rounded-lg" />
        </div>
        <div className="space-y-4 md:col-span-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-80 w-full rounded-lg" />
        </div>
      </div>
    </RouteSkeleton>
  );
}
