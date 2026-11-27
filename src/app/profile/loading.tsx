import { CardSkeleton, PageHeaderSkeleton, RouteSkeleton } from '@/components/route-skeletons';

// Profile: header, then two equal columns (PR-18): Personal Information and
// Notifications on the left, Appearance on the right.
export default function Loading() {
  return (
    <RouteSkeleton label="your profile">
      <PageHeaderSkeleton titleWidth="w-48" />
      <div className="mx-auto flex max-w-6xl flex-wrap gap-8">
        <div className="min-w-0 flex-[1_1_24rem] space-y-8">
          <CardSkeleton lines={6} className="h-96" />
          <CardSkeleton lines={4} className="h-72" />
        </div>
        <div className="min-w-0 flex-[1_1_24rem] space-y-8">
          <CardSkeleton lines={8} className="h-[36rem]" />
        </div>
      </div>
    </RouteSkeleton>
  );
}
