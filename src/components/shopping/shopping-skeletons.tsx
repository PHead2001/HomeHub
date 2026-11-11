import { CardSkeleton, TabsSkeleton } from '@/components/route-skeletons';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/*
 * One skeleton from the route to the content (SH-25a): `loading.tsx`, the page
 * while the household loads and the lists tab before its first snapshot all draw
 * these, in the same grid as the list cards, so nothing shifts as each takes over.
 */

/** The overview's "Create New List" row and list cards (same grid and height as `ListCard`). */
export function ListCardsSkeleton({ className }: { className?: string }) {
  return (
    <div className={className}>
      <div className="mb-4 flex justify-end">
        <Skeleton className="h-10 w-40" />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <CardSkeleton key={index} className="h-48" />
        ))}
      </div>
    </div>
  );
}

/** Tabs and list cards, as the Shopping Center draws them. */
export function ShoppingCenterSkeleton({ label = 'Loading shopping lists', className }: { label?: string; className?: string }) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className={cn('w-full', className)}>
      <TabsSkeleton />
      <ListCardsSkeleton className="mt-2 min-h-[24rem]" />
    </div>
  );
}
