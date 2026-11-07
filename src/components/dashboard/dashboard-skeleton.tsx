import { Skeleton } from '@/components/ui/skeleton';
import { RouteSkeleton } from '@/components/route-skeletons';

/** Dashboard loading layout: header, living house, brief line, then the tile grid. */
export function DashboardSkeleton() {
  return (
    <RouteSkeleton label="your dashboard" className="py-6 md:py-8">
      <div className="mb-4 space-y-2">
        <Skeleton className="h-9 w-60" />
        <Skeleton className="h-5 w-72 max-w-full" />
      </div>
      <Skeleton className="mb-6 h-72 w-full rounded-2xl" />
      <Skeleton className="mb-6 h-7 w-3/4 max-w-xl" />
      <Skeleton className="mb-3 h-7 w-44" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton className="min-h-[8.5rem] rounded-xl sm:col-span-2 lg:row-span-2" />
        <Skeleton className="min-h-[8.5rem] rounded-xl sm:col-span-2" />
        <Skeleton className="hidden min-h-[8.5rem] rounded-xl sm:block" />
        <Skeleton className="hidden min-h-[8.5rem] rounded-xl sm:block" />
      </div>
    </RouteSkeleton>
  );
}
