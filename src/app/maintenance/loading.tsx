import { CardSkeleton, PageHeaderSkeleton, RouteSkeleton, TabsSkeleton } from '@/components/route-skeletons';

// Maintenance Center: header + Add Log, five tabs, then the overview summary cards.
export default function Loading() {
  return (
    <RouteSkeleton label="maintenance">
      <div className="space-y-6">
        <PageHeaderSkeleton action titleWidth="w-72" className="mb-0" />
        <TabsSkeleton className="h-[5.25rem] md:h-10" />
        <div className="grid gap-4 pt-4 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <CardSkeleton key={i} lines={1} className="h-32" />
          ))}
        </div>
      </div>
    </RouteSkeleton>
  );
}
