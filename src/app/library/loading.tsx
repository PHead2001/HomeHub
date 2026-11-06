import { Skeleton } from '@/components/ui/skeleton';
import { RouteSkeleton } from '@/components/route-skeletons';

// Barcode Library: header with Back to Shopping, then the photo-first product grid.
export default function Loading() {
  return (
    <RouteSkeleton label="barcode library">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-5 w-72 max-w-full" />
        </div>
        <Skeleton className="h-10 w-full shrink-0 sm:w-44" />
      </div>
      <div className="rounded-xl border bg-card p-4 shadow-raised sm:p-6">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div className="space-y-2">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-4 w-48" />
          </div>
          <Skeleton className="h-10 w-28" />
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="aspect-[3/4] w-full rounded-xl" />
          ))}
        </div>
      </div>
    </RouteSkeleton>
  );
}
