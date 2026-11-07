import { Skeleton } from '@/components/ui/skeleton';
import { RouteSkeleton } from '@/components/route-skeletons';

// Offline page: centered logo, heading, two lines of text and two buttons.
export default function Loading() {
  return (
    <RouteSkeleton label="offline page" className="flex max-w-md flex-col items-center py-16 text-center">
      <div className="flex w-full flex-col items-center">
        <Skeleton className="h-14 w-14 rounded-xl" />
        <Skeleton className="mt-6 h-9 w-56" />
        <Skeleton className="mt-3 h-5 w-full" />
        <Skeleton className="mt-2 h-5 w-4/5" />
        <div className="mt-8 flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
          <Skeleton className="h-10 w-full sm:w-48" />
          <Skeleton className="h-10 w-full sm:w-28" />
        </div>
      </div>
    </RouteSkeleton>
  );
}
