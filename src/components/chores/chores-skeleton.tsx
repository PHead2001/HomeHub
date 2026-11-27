import { Skeleton } from '@/components/ui/skeleton';
import { ListRowsSkeleton, PageHeaderSkeleton, RouteSkeleton } from '@/components/route-skeletons';

/**
 * The one Chores skeleton (CH-26): the route's loading state and the page while its
 * listeners answer both render it, so one skeleton shows until the page is ready
 * instead of two different ones in turn. Left-aligned header with actions, a filter
 * row, then chore rows beside the weekly leaderboard on wide screens. `inPage` drops
 * the route padding the page container already has.
 */
export function ChoresSkeleton({ inPage = false }: { inPage?: boolean }) {
  return (
    <RouteSkeleton label="chores" className={inPage ? 'px-0 py-0' : undefined}>
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
