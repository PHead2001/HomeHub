import { Suspense } from 'react';
import { HouseholdManagementClient } from '@/components/household-management-client';
import { SessionGate } from '@/components/shell/session-gate';
import Loading from './loading';

export default function HouseholdPage() {
  return (
    // SL-11: the route skeleton, not the sign-in prompt, until Auth has answered.
    <SessionGate pending={<Loading />}>
      <div className="container mx-auto px-4 py-8">
        {/* The client reads ?tab= so notification links open the right tab. */}
        <Suspense>
          <HouseholdManagementClient />
        </Suspense>
      </div>
    </SessionGate>
  );
}
