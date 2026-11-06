import { Skeleton } from '@/components/ui/skeleton';
import { PageHeaderSkeleton, RouteSkeleton } from '@/components/route-skeletons';

// House Automation: header, then the same blocks the client shows while it loads.
export default function Loading() {
  return (
    <RouteSkeleton label="automation">
      <PageHeaderSkeleton titleWidth="w-72" />
      <div className="space-y-3">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </RouteSkeleton>
  );
}
