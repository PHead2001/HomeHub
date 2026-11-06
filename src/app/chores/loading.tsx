import { Skeleton } from '@/components/ui/skeleton';
import { ListRowsSkeleton, PageHeaderSkeleton, RouteSkeleton } from '@/components/route-skeletons';

// Chore Chart: left-aligned header with actions, a filter row, then chore rows
// beside the weekly leaderboard on wide screens.
export default function Loading() {
  return (
    <RouteSkeleton label="chores">
      <PageHeaderSkeleton action titleWidth="w-48" className="mb-6" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-3">
          <Skeleton className="h-9 w-32" />
          <ListRowsSkeleton rows={6} />
        </div>
        <Skeleton className="hidden h-64 w-full rounded-xl lg:block" />
      </div>
    </RouteSkeleton>
  );
}
