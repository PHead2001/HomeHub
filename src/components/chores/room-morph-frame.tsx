'use client';

import { Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { morphStyle } from '@/lib/motion';
import { ALL_ROOMS, parseChoresRoom, roomSharedId } from '@/lib/chores/url-state';

function Frame({ children }: { children: ReactNode }) {
  const room = parseChoresRoom(useSearchParams());
  return <div style={morphStyle(room !== ALL_ROOMS ? roomSharedId(room) : null)}>{children}</div>;
}

/**
 * Gives the Chores route skeleton the same `room-<roomId>` shared-element name as
 * the loaded page, so a living-house → Chores morph (H01) lands on the skeleton
 * when the route is still loading. Without search params it renders as is.
 */
export function RoomMorphFrame({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<div>{children}</div>}>
      <Frame>{children}</Frame>
    </Suspense>
  );
}
