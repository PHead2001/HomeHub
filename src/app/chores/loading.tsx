import { Skeleton } from '@/components/ui/skeleton';
import { ListRowsSkeleton, PageHeaderSkeleton, RouteSkeleton } from '@/components/route-skeletons';
import { RoomMorphFrame } from '@/components/chores/room-morph-frame';

// Chore Chart: left-aligned header with actions, a filter row, then chore rows
// beside the weekly leaderboard on wide screens. `/chores?room=<id>` gives the
// skeleton the room's shared-element name (H01 morph).
export default function Loading() {
  return (
    <RoomMorphFrame>
      <RouteSkeleton label="chores">
        <PageHeaderSkeleton action titleWidth="w-48" className="mb-6" />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-3">
            <Skeleton className="h-9 w-32" />
            <ListRowsSkeleton rows={6} />
          </div>
          <Skeleton className="hidden h-64 w-full rounded-xl lg:block" />
        </div>
      </RouteSkeleton>
    </RoomMorphFrame>
  );
}
