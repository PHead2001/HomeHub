'use client';

import type { ReactNode } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useSessionKnown } from '@/hooks/use-session-known';

/**
 * Renders `pending` (the route skeleton) until Auth has answered, then
 * `children` (SL-11). For server-component pages; client pages call
 * `useSessionKnown()` directly.
 */
export function SessionGate({ pending, children }: { pending: ReactNode; children: ReactNode }) {
  const { currentUser } = useAuth();
  const sessionKnown = useSessionKnown();
  return <>{!currentUser && !sessionKnown ? pending : children}</>;
}
