import { Skeleton } from '@/components/ui/skeleton';
import { PageHeaderSkeleton, RouteSkeleton } from '@/components/route-skeletons';

// Calendar: header with view switch, the overdue rail, then the week grid.
export default function Loading() {
  return (
    <RouteSkeleton label="calendar">
      <PageHeaderSkeleton action titleWidth="w-44" className="mb-6" />
      <Skeleton className="mb-4 h-10 w-full max-w-md" />
      <Skeleton className="h-[28rem] w-full rounded-xl" />
    </RouteSkeleton>
  );
}
