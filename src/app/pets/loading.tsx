import { Skeleton } from '@/components/ui/skeleton';
import { PageHeaderSkeleton, RouteSkeleton } from '@/components/route-skeletons';

// Your Pets: header, then the pet card grid.
export default function Loading() {
  return (
    <RouteSkeleton label="pets">
      <PageHeaderSkeleton titleWidth="w-44" />
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="overflow-hidden rounded-lg border bg-card shadow-raised">
            <Skeleton className="h-48 w-full rounded-none" />
            <div className="space-y-2 p-4">
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-4 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    </RouteSkeleton>
  );
}
