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
  clearPushDevice,
  nextPushTokens,
  pushRegistrationStep,
  pushSignInAction,
  pushSignOutGate,
  pushSignOutPlan,
  readPushDevice,
  withoutPushToken,
  writePushDevice,
} from '@/lib/push-tokens';

/** Failures worded for people; anything else goes through friendlyError. */
export class PushSetupError extends Error {}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

const notificationPermission = (): NotificationPermission | 'unsupported' =>
  typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported';

const SIGNING_OUT = 'You are signing out.';

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

const removeTokenFromAccount = (email: string, token: string): Promise<boolean> =>
  updateDoc(doc(db, 'users', email, 'private', 'push'), { fcmTokens: arrayRemove(token), updatedAt: serverTimestamp() })
    .then(() => true, (error: unknown) => {
      console.warn('The push token could not be removed from the account.', describe(error));
      return false;
    });

const revokeQuietly = (messaging: Messaging | null): Promise<boolean> =>
  revokeDevicePush(messaging).catch((error: unknown) => {
    console.warn('The push registration could not be revoked on this device.', describe(error));
    return false;
  });

async function register(user: { email: string; fcmTokens?: unknown }): Promise<void> {
  // Sign-out voids this pass; every step that takes time is followed by a check.
  const pass = pushSignOutGate.pass();
  const step = (stage: 'start' | 'token' | 'written') => pushRegistrationStep(stage, pushSignOutGate.allows(pass));
  if (step('start') === 'stop') throw new PushSetupError(SIGNING_OUT);

  const messaging = await getFirebaseMessaging();
  if (!messaging) throw new PushSetupError('Push notifications are not supported in this browser.');

  const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
  if (!vapidKey) {
    console.error('NEXT_PUBLIC_FIREBASE_VAPID_KEY is not configured.');
    throw new PushSetupError('Push notifications are not set up for HomeHub yet.');
  }

  // Register (or reuse) the combined push + offline service worker at /api/sw.
  const registration = await registerHomeHubServiceWorker();
  if (step('start') === 'stop') throw new PushSetupError(SIGNING_OUT);
  const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
  if (!token) throw new PushSetupError('This device did not return a push token. Please try again.');

  const storage = deviceStorage();
  // Sign-out began while the token was on its way: nothing was stored for it, so
  // only the device registration has to go. A token this device already
  // remembers stays remembered for sign-out's own cleanup.
  const discard = async () => {
    const revoked = await revokeQuietly(messaging);
    if (!revoked && !readPushDevice(storage)) writePushDevice(storage, token, '', Date.now());
    throw new PushSetupError(SIGNING_OUT);
  };
  if (step('token') === 'discard') await discard();
  if (auth.currentUser?.email !== user.email) throw new PushSetupError('You are no longer signed in.');

  // Tokens live in an owner-only document so housemates, who can read the
  // profile, never see them. Any legacy profile tokens move along, the device's
  // previous token (after an FCM refresh) is dropped, and past the rules' cap of
  // 20 the oldest tokens make room.
  const previous = readPushDevice(storage);
  const replaced = previous && previous.email === user.email && previous.token !== token ? previous.token : null;
  const pushRef = doc(db, 'users', user.email, 'private', 'push');
  const stored = await getDoc(pushRef);
  if (step('token') === 'discard') await discard();
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

  if (step('written') === 'undo') {
    // Sign-out began during the write: take the token out of the account again
    // (possible only while still signed in) and revoke it on the device. If
    // either fails, the token is remembered without an account, so the next
    // sign-in replaces it.
    const [accountDone, deviceDone] = await Promise.all([removeTokenFromAccount(user.email, token), revokeQuietly(messaging)]);
    if (accountDone && deviceDone) clearPushDevice(storage);
    else writePushDevice(storage, token, '', Date.now());
    throw new PushSetupError(SIGNING_OUT);
  }
  writePushDevice(storage, token, user.email, Date.now());
}

/**
 * Gets this device's FCM token and stores it for `user`, who must be the signed-in
 * account. Requires granted permission; never prompts. If sign-out begins while
 * this runs, nothing is kept: the token is not stored, or is removed again, and
 * the device registration is revoked. Sign-out waits for it (within its budget).
 */
export function registerPushOnThisDevice(user: { email: string; fcmTokens?: unknown }): Promise<void> {
  return pushSignOutGate.track(register(user));
}

/**
 * Sign-out's cleanup, run through `runPushSignOut` (which bounds it and marks
 * what is unfinished) while still signed in. Waits for registrations in flight,
 * removes this device's remembered token from the signed-in account's private
 * push document and revokes the device registration, also when no token is
 * remembered but a push subscription exists. True when nothing is left.
 */
export async function unregisterPushOnThisDevice(): Promise<boolean> {
  await pushSignOutGate.drain();
  const storage = deviceStorage();
  const record = readPushDevice(storage);
  const email = auth.currentUser?.email;
  const plan = pushSignOutPlan(record, email, isBrowserOffline());
  if (plan.deferred) return false;
  const [accountDone, deviceDone] = await Promise.all([
    plan.removeFromAccount && record && email ? removeTokenFromAccount(email, record.token) : true,
    plan.revoke ? getFirebaseMessaging().catch(() => null).then(revokeQuietly) : true,
  ]);
  const removed = accountDone && deviceDone;
  if (removed) clearPushDevice(storage);
  return removed;
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
  run.done = pushSignOutGate.track((async () => {
    try {
      const pass = pushSignOutGate.pass();
      if (pass === null || auth.currentUser?.email !== user.email || isBrowserOffline()) return;
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
      if (!pushSignOutGate.allows(pass)) return;
      await register(user);
    } catch (error) {
      console.warn('Push could not be registered for this account.', describe(error));
    } finally {
      if (syncInFlight === run) syncInFlight = null;
    }
  })());
  return run.done;
}
