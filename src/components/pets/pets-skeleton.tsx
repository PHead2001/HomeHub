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

/** The board card's placeholder: band, 80 px avatar, name and status, Feed (PE-9). */
function BoardCardSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border bg-card shadow-raised" aria-hidden>
      <Skeleton className="h-11 w-full rounded-none" />
      <div className="flex flex-1 gap-4 p-4">
        <Skeleton className="h-20 w-20 rounded-xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-7 w-3/4" />
        </div>
      </div>
      <Skeleton className="mx-4 mb-4 h-11" />
    </div>
  );
}

/** The phone row's placeholder: 64 px avatar, name and status, Feed (PE-13a). */
function RowCardSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-3 shadow-raised" aria-hidden>
      <Skeleton className="h-16 w-16 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
      </div>
      <Skeleton className="h-12 w-24" />
    </div>
  );
}

/**
 * The card placeholder: the same cards from the route skeleton to the list
 * (PE-21g), in the shape of the view this screen gets, chosen by CSS (so the
 * server-rendered route skeleton already has it): phone rows under 640 px, the
 * board on wide landscape screens, the grid otherwise.
 */
export function PetsGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <>
      <div className="flex flex-col gap-3 sm:hidden" aria-hidden data-testid="pets-skeleton-rows">
        {Array.from({ length: count }, (_, index) => <RowCardSkeleton key={index} />)}
      </div>
      {/* `[@media(min-width:1024px)_and_(orientation:landscape)]` is the board's `BOARD_QUERY` (src/lib/pets/board.ts), written out for Tailwind. */}
      <div className={`${PETS_GRID} max-sm:hidden [@media(min-width:1024px)_and_(orientation:landscape)]:hidden`} aria-hidden data-testid="pets-skeleton-grid">
        {Array.from({ length: count }, (_, index) => <PetCardSkeleton key={index} />)}
      </div>
      <div className="hidden grid-cols-2 gap-4 [@media(min-width:1024px)_and_(orientation:landscape)]:grid" aria-hidden data-testid="pets-skeleton-board">
        {Array.from({ length: count }, (_, index) => <BoardCardSkeleton key={index} />)}
      </div>
    </>
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
