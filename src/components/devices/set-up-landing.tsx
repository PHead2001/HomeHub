'use client';

import { useEffect, useRef, useState } from 'react';
import { signOut } from 'firebase/auth';
import { MonitorSmartphone } from 'lucide-react';
import { auth } from '@/lib/firebase-app';
import type { Principal } from '@/lib/devices/principal';
import { deviceHeartbeatAction } from '@/app/household/device-actions';
import { browserPushClearDeps, clearPushState } from '@/lib/devices/push-clear';
import { readDeviceSettings } from '@/lib/devices/settings';
import { forgetHouseholdOnDevice } from '@/lib/auth/household-scope';

// The minimal screen a registered wall tablet shows until the tablet shell lands
// (docs/modules/devices/README.md, "Principal switch"). It keeps the device's own
// record in view (name, room), sends the heartbeat (truthful last seen and version),
// retries clearing leftover push state, and notices removal from the server: then it
// clears this browser's tablet session and returns to the setup screen.

type TabletPrincipal = Exclude<Principal, { kind: 'personal' }>;

/** One-shot note for the setup screen after a removal (read once, then cleared). */
export const DEVICE_ENDED_KEY = 'homehub.device-ended';
const HEARTBEAT_EVERY_MS = 5 * 60 * 1000;
const BUILD_ID = process.env.NEXT_PUBLIC_HOMEHUB_BUILD_ID || 'unknown';

const endSession = async (reason: 'removed' | 'repaired') => {
  try {
    window.sessionStorage.setItem(DEVICE_ENDED_KEY, reason);
  } catch {
    // Storage blocked: the setup screen shows without the note.
  }
  forgetHouseholdOnDevice(null);
  try {
    const { clearLocalFirestoreCache } = await import('@/lib/firebase');
    await clearLocalFirestoreCache();
  } catch (error) {
    console.warn('The tablet cache could not be cleared.', error instanceof Error ? error.message : String(error));
  }
  await clearPushState(browserPushClearDeps()).catch(() => undefined);
  try {
    await signOut(auth);
  } finally {
    // A full load: Firestore was terminated above and cannot be reused in this page.
    window.location.replace(new URL('/setup', window.location.origin).href);
  }
};

export default function DeviceSetUpLanding({ principal }: { principal: TabletPrincipal }) {
  const [label, setLabel] = useState<{ name: string; room: string } | null>(null);
  const ending = useRef(false);
  // Unresolved claims (offline restore): nothing is read or sent until AuthProvider has them.
  const { deviceId } = principal;
  const householdId = principal.kind === 'device' ? principal.householdId : '';
  const generation = principal.kind === 'device' ? principal.generation : 0;

  const end = (reason: 'removed' | 'repaired') => {
    if (ending.current) return;
    ending.current = true;
    void endSession(reason);
  };

  // A tablet never holds a push subscription: retried at every start until it succeeds.
  useEffect(() => {
    void clearPushState(browserPushClearDeps()).then(result => {
      if (!result.ok) console.warn('Leftover push state could not be fully cleared yet.', result.errors.join('; '));
    });
  }, []);

  // The tablet's own record, from the server: removal, a re-pair elsewhere, or a missing
  // record ends this session. Cached snapshots never decide.
  useEffect(() => {
    if (!householdId) return;
    let stop: (() => void) | null = null;
    let stopped = false;
    void Promise.all([import('@/lib/firebase'), import('firebase/firestore')]).then(([{ db }, { doc, onSnapshot }]) => {
      if (stopped) return;
      stop = onSnapshot(
        doc(db, 'households', householdId, 'devices', deviceId),
        { includeMetadataChanges: true },
        snapshot => {
          if (snapshot.metadata.fromCache) return;
          const data = snapshot.data();
          if (!snapshot.exists() || !data) return end('removed');
          if (data.status !== 'active') return end('removed');
          if (data.generation !== generation) return end('repaired');
          const settings = readDeviceSettings(data);
          setLabel({ name: settings.name, room: settings.room });
        },
        error => {
          if ((error as { code?: string }).code === 'permission-denied') end('removed');
        },
      );
    });
    return () => {
      stopped = true;
      stop?.();
    };
  }, [deviceId, generation, householdId]);

  // Heartbeat: at start, when the screen becomes visible, on reconnect, and every 5 minutes while visible.
  useEffect(() => {
    if (!householdId) return;
    const beat = async () => {
      if (document.visibilityState !== 'visible' || !auth.currentUser) return;
      try {
        const result = await deviceHeartbeatAction({ idToken: await auth.currentUser.getIdToken(), householdId, appVersion: BUILD_ID });
        if (!result.ok && (result.code === 'device_revoked' || result.code === 'household_deleting' || result.code === 'unauthenticated')) end('removed');
      } catch {
        // Offline or unreachable: the next beat tries again.
      }
    };
    void beat();
    const timer = window.setInterval(beat, HEARTBEAT_EVERY_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void beat(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', beat);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', beat);
    };
  }, [householdId]);

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <section className="max-w-md space-y-4 text-center" aria-labelledby="device-landing-title">
        <MonitorSmartphone aria-hidden className="mx-auto h-12 w-12 text-primary" />
        <h1 id="device-landing-title" className="font-headline text-3xl">This tablet is set up</h1>
        {householdId ? (
          <p className="text-lg text-muted-foreground" aria-live="polite">
            {label ? `${label.name} · ${label.room}` : 'Connecting to your household…'}
          </p>
        ) : (
          <p className="text-lg text-muted-foreground">HomeHub can&apos;t be reached right now. This screen tries again when the connection returns.</p>
        )}
        <p className="text-sm text-muted-foreground">
          The wall-tablet screen is on its way. Owners and admins can rename this tablet or remove it from Household, Devices.
        </p>
      </section>
    </main>
  );
}
