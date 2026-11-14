'use client';

import { useMemo } from 'react';
import { useDashboardScope } from '@/lib/dashboard/dashboard-scope';
import { dashboardTiles } from '@/lib/dashboard/tiles';
import { useWeatherPreference } from '@/lib/dashboard/use-weather';
import { DashboardSkeleton } from './dashboard-skeleton';

/**
 * The skeleton shown while the signed-in dashboard chunk loads: the member is known, so
 * its tile grid is this member's own descriptor list (permissions and weather opt-in),
 * the same cells the real grid then fills (HP-26b).
 */
export function DashboardLoading() {
  const { permissions } = useDashboardScope();
  const { preference } = useWeatherPreference();
  const weatherEnabled = preference.enabled && Boolean(preference.city);
  const tiles = useMemo(() => dashboardTiles({ permissions, weatherEnabled }), [permissions, weatherEnabled]);
  return <DashboardSkeleton tiles={tiles} />;
}
