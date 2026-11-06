import { Suspense } from 'react';
import { HouseholdManagementClient } from '@/components/household-management-client';

export default function HouseholdPage() {
  return (
    <div className="container mx-auto px-4 py-8">
      {/* The client reads ?tab= so notification links open the right tab. */}
      <Suspense>
        <HouseholdManagementClient />
      </Suspense>
    </div>
  );
}
