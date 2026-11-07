import { Skeleton } from '@/components/ui/skeleton';
import { CardSkeleton, RouteSkeleton } from '@/components/route-skeletons';

// Share target: heading, one-line description, then the confirm card.
export default function Loading() {
  return (
    <RouteSkeleton label="share" className="max-w-xl py-8">
      <div className="space-y-2">
        <Skeleton className="h-9 w-72 max-w-full" />
        <Skeleton className="h-5 w-80 max-w-full" />
      </div>
      <div className="mt-6">
        <CardSkeleton lines={3} />
      </div>
    </RouteSkeleton>
  );
}
