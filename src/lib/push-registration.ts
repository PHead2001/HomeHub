// Push registration for this device: subscribe (Profile), silent re-registration
// after sign-in, and removal on sign-out. Imports `@/lib/firebase` (Firestore,
// App Check), so shell code loads this module only for a signed-in member.
// The decisions live in `./push-tokens` (pure, unit-tested).
import { deleteToken, getToken, type Messaging } from 'firebase/messaging';
import { arrayRemove, deleteField, doc, getDoc, serverTimestamp, updateDoc, writeBatch } from 'firebase/firestore';
import { auth, db, getFirebaseMessaging } from '@/lib/firebase';
import { awaitWriteUnlessOffline, isBrowserOffline } from '@/lib/firestore-offline';
import { deviceStorage } from '@/lib/dashboard/house-snapshot';
import { SERVICE_WORKER_SCOPE, registerHomeHubServiceWorker } from '@/lib/service-worker';
import {
  PUSH_SIGN_OUT_TIMEOUT_MS,
  nextPushTokens,
  pushSignInAction,
  pushSignOutPlan,
  readPushDevice,
  settlePushSignOut,
  settleWithin,
  withoutPushToken,
  writePushDevice,
} from '@/lib/push-tokens';

/** Failures worded for people; anything else goes through friendlyError. */
export class PushSetupError extends Error {}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

const notificationPermission = (): NotificationPermission | 'unsupported' =>
  typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported';

/**
 * Gets this device's FCM token and stores it for `user`, who must be the signed-in
 * account (checked again after the token arrives, because a sign-out may have
 * happened meanwhile). Requires granted permission; never prompts.
 */
export async function registerPushOnThisDevice(user: { email: string; fcmTokens?: unknown }): Promise<void> {
  const messaging = await getFirebaseMessaging();
  if (!messaging) throw new PushSetupError('Push notifications are not supported in this browser.');

  const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
  if (!vapidKey) {
    console.error('NEXT_PUBLIC_FIREBASE_VAPID_KEY is not configured.');
    throw new PushSetupError('Push notifications are not set up for HomeHub yet.');
  }

  // Register (or reuse) the combined push + offline service worker at /api/sw.
  const registration = await registerHomeHubServiceWorker();
  const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
  if (!token) throw new PushSetupError('This device did not return a push token. Please try again.');
  if (auth.currentUser?.email !== user.email) throw new PushSetupError('You are no longer signed in.');

  // Tokens live in an owner-only document so housemates, who can read the
  // profile, never see them. Any legacy profile tokens move along, the device's
  // previous token (after an FCM refresh) is dropped, and past the rules' cap of
  // 20 the oldest tokens make room.
  const storage = deviceStorage();
  const previous = readPushDevice(storage);
  const replaced = previous && previous.email === user.email && previous.token !== token ? previous.token : null;
  const pushRef = doc(db, 'users', user.email, 'private', 'push');
  const stored = await getDoc(pushRef);
  const batch = writeBatch(db);
  batch.set(pushRef, {
    fcmTokens: nextPushTokens(withoutPushToken(stored.get('fcmTokens'), replaced), withoutPushToken(user.fcmTokens, replaced), token),
    updatedAt: serverTimestamp(),
  });
  if (user.fcmTokens) {
    batch.update(doc(db, 'users', user.email), { fcmTokens: deleteField() });
  }
  await awaitWriteUnlessOffline(batch.commit(), error => {
    console.error('Push subscription could not be saved.', describe(error));
  });
  writePushDevice(storage, token, user.email, Date.now());
}

/**
 * Revokes this device's FCM registration and ends its browser push subscription.
 * True when no push subscription is left, so the old token can no longer deliver
 * here even if FCM could not be told (FCM then reports it unregistered and the
 * push function removes it from whichever account still lists it).
 */
async function revokeDevicePush(messaging: Messaging | null): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return true;
  const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_SCOPE);
  if (!registration?.pushManager) return true;
  if (messaging) {
    // `deleteToken` uses the worker that `getToken` was given in this page load;
    // without one it would try to register the SDK's default worker file, which
    // HomeHub does not serve. Point it at HomeHub's worker rather than calling
    // `getToken`, which could go to the network.
    const service = messaging as Messaging & { swRegistration?: ServiceWorkerRegistration };
    service.swRegistration ??= registration;
    try {
      await deleteToken(messaging);
    } catch (error) {
      console.warn('The push token could not be deleted from FCM.', describe(error));
    }
  }
  const subscription = await registration.pushManager.getSubscription();
  return subscription ? subscription.unsubscribe() : true;
}

/**
 * Sign-out: removes this device's token from the signed-in account's private
 * push document and revokes the device registration. Call while still signed in.
 * Never throws and never takes longer than `PUSH_SIGN_OUT_TIMEOUT_MS`; whatever
 * could not be finished is left marked for replacement at the next sign-in.
 */
export async function unregisterPushOnThisDevice(): Promise<void> {
  const storage = deviceStorage();
  const record = readPushDevice(storage);
  if (!record) return;
  const email = auth.currentUser?.email;
  const plan = pushSignOutPlan(record, email, isBrowserOffline());
  const warn = (error: unknown) => console.warn('Push could not be fully removed from this device on sign-out.', describe(error));
  const removed = plan.deferred ? false : await settleWithin(async () => {
    const [accountDone, deviceDone] = await Promise.all([
      plan.removeFromAccount && email
        ? updateDoc(doc(db, 'users', email, 'private', 'push'), { fcmTokens: arrayRemove(record.token), updatedAt: serverTimestamp() })
            .then(() => true, (error: unknown) => { warn(error); return false; })
        : true,
      plan.revoke
        ? getFirebaseMessaging().catch(() => null).then(revokeDevicePush).catch((error: unknown) => { warn(error); return false; })
        : true,
    ]);
    return accountDone && deviceDone;
  }, PUSH_SIGN_OUT_TIMEOUT_MS, false, warn);
  settlePushSignOut(storage, record, removed);
}

let syncInFlight: { email: string; done: Promise<void> } | null = null;

/**
 * After sign-in: when browser permission is already granted but this device
 * holds no current token for the signed-in account, registers one without asking
 * (permission survives sign-out, the token does not). A token left by another
 * account or an unfinished sign-out is revoked first. Failures only warn.
 */
export function syncPushForSignedInUser(user: { email: string; fcmTokens?: unknown }): Promise<void> {
  if (syncInFlight?.email === user.email) return syncInFlight.done;
  const run = { email: user.email, done: Promise.resolve() };
  syncInFlight = run;
  run.done = (async () => {
    try {
      if (auth.currentUser?.email !== user.email || isBrowserOffline()) return;
      const action = pushSignInAction({
        permission: notificationPermission(),
        email: user.email,
        record: readPushDevice(deviceStorage()),
        now: Date.now(),
      });
      if (action === 'none') return;
      const messaging = await getFirebaseMessaging();
      if (!messaging) return;
      if (action === 'replace' && !(await revokeDevicePush(messaging))) return;
      await registerPushOnThisDevice(user);
    } catch (error) {
      console.warn('Push could not be registered for this account.', describe(error));
    } finally {
      if (syncInFlight === run) syncInFlight = null;
    }
  })();
  return run.done;
}
