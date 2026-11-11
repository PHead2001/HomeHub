import { PageHeaderSkeleton, RouteSkeleton, TabsSkeleton } from '@/components/route-skeletons';
import { ListCardsSkeleton } from '@/components/shopping/shopping-skeletons';

// Shopping Center: header + Barcode Library, two tabs, then the list cards. The
// page and the lists tab draw the same skeleton until data arrives (SH-25a).
export default function Loading() {
  return (
    <RouteSkeleton label="shopping">
      <PageHeaderSkeleton action titleWidth="w-64" />
      <TabsSkeleton />
      <ListCardsSkeleton className="mt-2 min-h-[24rem]" />
    </RouteSkeleton>
  );
}
