import { CardSkeleton, PageHeaderSkeleton, RouteSkeleton, TabsSkeleton } from '@/components/route-skeletons';

// Shopping Center: header + Barcode Library, two tabs, then list cards.
export default function Loading() {
  return (
    <RouteSkeleton label="shopping">
      <PageHeaderSkeleton action titleWidth="w-64" />
      <TabsSkeleton />
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <CardSkeleton key={i} className="h-40" />
        ))}
      </div>
    </RouteSkeleton>
  );
}
