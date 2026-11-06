import { Skeleton } from '@/components/ui/skeleton';
import { CardSkeleton, PageHeaderSkeleton, RouteSkeleton } from '@/components/route-skeletons';

// Dashboard: header, AI Overview band, then the module card carousel.
export default function Loading() {
  return (
    <RouteSkeleton label="your dashboard">
      <PageHeaderSkeleton titleWidth="w-60" />
      <div className="mb-8 flex flex-col gap-4 border-y py-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-5 w-96 max-w-full" />
        </div>
        <Skeleton className="h-10 w-full sm:w-48" />
      </div>
      <Skeleton className="mb-4 h-7 w-44" />
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <CardSkeleton className="h-64" />
        <CardSkeleton className="hidden h-64 md:block" />
        <CardSkeleton className="hidden h-64 lg:block" />
      </div>
    </RouteSkeleton>
  );
}
