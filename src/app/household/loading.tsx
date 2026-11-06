import { Skeleton } from '@/components/ui/skeleton';
import { PageHeaderSkeleton, RouteSkeleton } from '@/components/route-skeletons';

// Manage Household: header + Refresh, then the loading card the page shows first.
export default function Loading() {
  return (
    <RouteSkeleton label="household">
      <div className="mx-auto max-w-6xl space-y-6">
        <PageHeaderSkeleton action titleWidth="w-64" className="mb-0" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    </RouteSkeleton>
  );
}
