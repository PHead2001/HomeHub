import { RouteSkeleton } from '@/components/route-skeletons';
import { MaintenanceSkeleton } from '@/components/maintenance/maintenance-skeleton';

// Maintenance Center: the same skeleton the page shows on its first load (header + Add Log,
// five tabs, the overview summary cards), so a cold load never swaps layouts (MA-25a).
export default function Loading() {
  return (
    <RouteSkeleton label="maintenance">
      <MaintenanceSkeleton />
    </RouteSkeleton>
  );
}
