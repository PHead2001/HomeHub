import { RoomMorphFrame } from '@/components/chores/room-morph-frame';
import { ChoresSkeleton } from '@/components/chores/chores-skeleton';

// `/chores?room=<id>` gives the skeleton the room's shared-element name (H01 morph).
// The page shows the same skeleton until its listeners answer (CH-26).
export default function Loading() {
  return (
    <RoomMorphFrame>
      <ChoresSkeleton />
    </RoomMorphFrame>
  );
}
