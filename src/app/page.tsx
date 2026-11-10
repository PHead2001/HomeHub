'use client';

import dynamic from 'next/dynamic';
import { DashboardSkeleton } from '@/components/dashboard/dashboard-skeleton';
import { DashboardLoading } from '@/components/dashboard/dashboard-loading';
import { Landing } from '@/components/dashboard/landing';
import { useEffect } from 'react';
import { SESSION_GATE_SCRIPT, SESSION_HINT_KEY } from '@/lib/dashboard/session-hint';
import { useAuth } from '@/hooks/use-auth';
import styles from '@/components/dashboard/dashboard.module.css';

const loadDashboard = () => import('@/components/dashboard/dashboard');

// The dashboard (Firestore listeners, the house, tiles, AI Overview) is its own
// chunk, so the signed-out landing page stays light (H03: Lighthouse >= 90 on mobile).
const Dashboard = dynamic(() => loadDashboard().then((mod) => mod.Dashboard), {
  ssr: false,
  // The member is known by now: the skeleton draws their own tiles (HP-26b).
  loading: () => <DashboardLoading />,
});

export default function Home() {
  const { currentUser, loading } = useAuth();

  // A device where someone was signed in starts fetching the dashboard chunk while Auth
  // restores the session, so it's ready the moment the user is known (H01). Without the
  // hint (signed-out visitors) nothing extra loads (H03).
  useEffect(() => {
    try {
      if (window.localStorage.getItem(SESSION_HINT_KEY) === '1') void loadDashboard();
    } catch {
      // Storage blocked: the chunk loads when the dashboard renders.
    }
  }, []);

  if (!loading && currentUser) return <Dashboard />;

  // While Firebase Auth restores the session (seconds on a slow phone), the server
  // HTML already holds both the landing page and the dashboard skeleton. A tiny
  // inline script picks one before first paint from a device hint
  // (`homehub.session`, see session-hint.ts): visitors who were signed in on this
  // device see the skeleton, everyone else sees the landing page at once, so its
  // hero is never held back by auth (H03 LCP). Signed-out visitors keep the same
  // Landing element after auth resolves, so nothing remounts or shifts.
  return (
    <>
      {loading && <script id="homehub-session-gate" dangerouslySetInnerHTML={{ __html: SESSION_GATE_SCRIPT }} />}
      {loading && (
        <div className={styles.gateSkeleton}>
          <DashboardSkeleton />
        </div>
      )}
      <div className={loading ? styles.gateLanding : undefined}>
        <Landing />
      </div>
    </>
  );
}
