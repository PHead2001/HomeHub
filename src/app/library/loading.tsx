import { Skeleton } from '@/components/ui/skeleton';
import { RouteSkeleton } from '@/components/route-skeletons';

// Barcode Library: header with Back to Shopping, then the product table.
export default function Loading() {
  return (
    <RouteSkeleton label="barcode library">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-5 w-72 max-w-full" />
        </div>
        <Skeleton className="h-10 w-44 shrink-0" />
      </div>
      <div className="rounded-lg border bg-card p-4 shadow-raised">
        <Skeleton className="mb-4 h-10 w-full" />
        <div className="space-y-3">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    </RouteSkeleton>
  );
}
