import { Skeleton } from '@/components/ui/skeleton';
import { ListRowsSkeleton, RouteSkeleton } from '@/components/route-skeletons';

// Chore Chart: centered header with filter/action buttons, then chore rows.
export default function Loading() {
  return (
    <RouteSkeleton label="chores">
      <div className="mb-6 flex flex-col items-center text-center md:mb-8">
        <div className="mb-4 flex flex-col items-center gap-2">
          <Skeleton className="h-7 w-36 md:h-9 md:w-48" />
          <Skeleton className="h-4 w-56 md:h-5 md:w-72" />
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-24 md:h-11 md:w-36" />
          ))}
        </div>
      </div>
      <ListRowsSkeleton rows={6} />
    </RouteSkeleton>
  );
}
