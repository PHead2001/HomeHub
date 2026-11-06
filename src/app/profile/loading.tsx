import { CardSkeleton, PageHeaderSkeleton, RouteSkeleton } from '@/components/route-skeletons';

// Profile: header, then Personal Information (two columns) beside the settings column.
export default function Loading() {
  return (
    <RouteSkeleton label="your profile">
      <PageHeaderSkeleton titleWidth="w-48" />
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-8 md:grid-cols-3">
        <div className="space-y-8 md:col-span-2">
          <CardSkeleton lines={6} className="h-96" />
        </div>
        <div className="space-y-8 md:col-span-1">
          <CardSkeleton lines={5} className="h-96" />
          <CardSkeleton lines={3} className="h-56" />
        </div>
      </div>
    </RouteSkeleton>
  );
}
