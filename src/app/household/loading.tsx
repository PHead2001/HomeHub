import { Skeleton } from '@/components/ui/skeleton';
import { PageHeaderSkeleton, RouteSkeleton } from '@/components/route-skeletons';

// Manage Household: header, tabs, the 2×2 (phone) / 4-up stat cards and the first card.
export default function Loading() {
  return (
    <RouteSkeleton label="household">
      <div className="mx-auto max-w-6xl space-y-6">
        <PageHeaderSkeleton titleWidth="w-64" className="mb-0" />
        <div className="space-y-4">
          <Skeleton className="h-10 w-full rounded-lg" />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
            {[0, 1, 2, 3].map((key) => <Skeleton key={key} className="h-20 rounded-lg" />)}
          </div>
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
      </div>
    </RouteSkeleton>
  );
}
