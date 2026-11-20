import { Skeleton } from '@/components/ui/skeleton';
import { PageHeaderSkeleton } from '@/components/route-skeletons';
import { PetPhotoSkeleton } from './pet-photo-skeleton';

/** The pet card grid (the same classes as the list). */
export const PETS_GRID = 'grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4';

function PetCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border bg-card shadow-raised" aria-hidden>
      <Skeleton className="aspect-[4/3] w-full rounded-none" />
      <div className="space-y-3 p-4">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-4 w-1/4" />
        <div className="flex items-center gap-3">
          <Skeleton className="h-12 w-12 rounded-full" />
          <Skeleton className="h-4 flex-1" />
        </div>
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}

/** The card grid placeholder: the same cards from the route skeleton to the list (PE-21g). */
export function PetsGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className={PETS_GRID} aria-hidden>
      {Array.from({ length: count }, (_, index) => <PetCardSkeleton key={index} />)}
    </div>
  );
}

/**
 * `/pets` while loading (PE-21g): one skeleton from the route to the content.
 * The route `loading.tsx`, the page while Auth answers, the Suspense fallback
 * and the list while pets load all render this same header and grid, so the
 * page never steps through different placeholders.
 */
export function PetsListSkeletonBody() {
  return (
    <>
      <PageHeaderSkeleton titleWidth="w-44" action />
      <PetsGridSkeleton />
    </>
  );
}

/** The pet page while loading: back button, photo card (the morph target) and info, then the tabs panel. */
export function PetDetailSkeletonBody() {
  return (
    <>
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
    </>
  );
}
