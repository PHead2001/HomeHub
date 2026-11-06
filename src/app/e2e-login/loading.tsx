import { Skeleton } from '@/components/ui/skeleton';
import { RouteSkeleton } from '@/components/route-skeletons';

// Emulator-only sign-in route: centered status block.
export default function Loading() {
  return (
    <RouteSkeleton label="sign-in" className="flex min-h-[60vh] items-center justify-center">
      <div className="flex max-w-md flex-col items-center gap-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-40" />
      </div>
    </RouteSkeleton>
  );
}
