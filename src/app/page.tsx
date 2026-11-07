'use client';

import dynamic from 'next/dynamic';
import { DashboardSkeleton } from '@/components/dashboard/dashboard-skeleton';
import { Landing } from '@/components/dashboard/landing';
import { useAuth } from '@/hooks/use-auth';

// The dashboard (Firestore listeners, the house, tiles, AI Overview) is its own
// chunk, so the signed-out landing page stays light (H03: Lighthouse >= 90 on mobile).
const Dashboard = dynamic(() => import('@/components/dashboard/dashboard').then((mod) => mod.Dashboard), {
  ssr: false,
  loading: () => <DashboardSkeleton />,
});

export default function Home() {
  const { currentUser, loading } = useAuth();

  if (loading) return <DashboardSkeleton />;
  // Signed-out visitors get the landing page (H03), never an empty dashboard.
  if (!currentUser) return <Landing />;
  return <Dashboard />;
}
