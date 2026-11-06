import { Skeleton } from '@/components/ui/skeleton';
import { ListRowsSkeleton, RouteSkeleton } from '@/components/route-skeletons';

// Notification Center: header, filter chips, then notification rows.
export default function Loading() {
  return (
    <RouteSkeleton label="notifications" className="py-6 md:py-8">
      <div className="mb-6 space-y-2">
        <Skeleton className="h-8 w-64 md:h-9 md:w-72" />
        <Skeleton className="h-5 w-64" />
      </div>
      <div className="mb-5 flex gap-2 overflow-hidden pb-2">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-24 shrink-0" />
        ))}
      </div>
      <ListRowsSkeleton rows={5} className="[&>*]:h-24" />
    </RouteSkeleton>
  );
}
