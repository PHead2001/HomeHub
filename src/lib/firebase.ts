// src/lib/firebase.ts
// Data access: Firestore, Storage and Messaging, with App Check started first.
// The app and Auth live in `./firebase-app` (all that signed-out pages load); this
// module re-exports them so existing imports keep working. Shell code that runs
// for signed-out visitors (AuthProvider, the root layout) must import this module
// only dynamically, once a user is known.
import {
  connectFirestoreEmulator,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  terminate,
  clearIndexedDbPersistence,
  waitForPendingWrites,
  type Firestore,
} from "firebase/firestore";
import { getMessaging, isSupported } from "firebase/messaging";
import { connectStorageEmulator, getStorage } from "firebase/storage";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { app, auth, firebaseConfig, firebaseEmulatorMode } from "./firebase-app";

export { auth, firebaseConfig, firebaseEmulatorMode };

type AppCheckState = typeof globalThis & {
  FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean;
  __homeHubAppCheckStarted?: boolean;
};

// App Check: the browser proves it is the real HomeHub web app (reCAPTCHA Enterprise,
// key limited to HomeHub's domains) before Firestore, Storage and Auth accept its
// requests once enforcement is on. It starts before those services are created so
// their first requests already carry a token. Browser only; never against the
// emulators. Local development against the real project registers a debug token
// instead, because localhost is not an allowed domain for the key.
const appCheckSiteKey = process.env.NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY;
if (typeof window !== "undefined" && !firebaseEmulatorMode && appCheckSiteKey) {
  const appCheckState = globalThis as AppCheckState;
  if (!appCheckState.__homeHubAppCheckStarted) {
    const debugToken = process.env.NEXT_PUBLIC_APP_CHECK_DEBUG_TOKEN;
    if (debugToken) appCheckState.FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken;
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
    appCheckState.__homeHubAppCheckStarted = true;
  }
}

// In the browser Firestore keeps a persistent IndexedDB cache shared by every
// open tab, so shopping lists (and other already-loaded data) open offline and
// queued writes such as ticked items survive reloads and sync on reconnect.
// Server code (route handlers, server actions) keeps the default memory cache.
// NEXT_PUBLIC_FIRESTORE_MEMORY_CACHE=true opts a build out of persistence.
const createFirestore = (): Firestore => {
  // Emulator runs keep the memory cache: the E2E suite pins the browser clock, and
  // the persistent cache rejects server timestamps that look like they are in the
  // future, logging errors on every snapshot. Production devices have real clocks.
  if (typeof window === "undefined" || firebaseEmulatorMode
      || process.env.NEXT_PUBLIC_FIRESTORE_MEMORY_CACHE === "true") {
    return getFirestore(app);
  }
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch {
    // Already initialized (development hot reload) or the cache cannot be created.
    return getFirestore(app);
  }
};

export const db = createFirestore();
export const storage = getStorage(app);

/**
 * Sign-out cleanup: the persistent cache belongs to the browser profile, not the
 * person, so cached household data must not outlive the session on a shared device.
 * Waits briefly for queued writes (e.g. offline ticks) to reach the server, then
 * terminates Firestore and deletes its IndexedDB cache. Returns true once Firestore
 * has been terminated: it cannot be used again, so the caller must reload the page
 * even when deleting the cache failed (for example another HomeHub tab still has it
 * open; that tab's next sign-out clears it).
 */
export const clearLocalFirestoreCache = async (): Promise<boolean> => {
  if (typeof window === "undefined") return false;
  try {
    await Promise.race([
      waitForPendingWrites(db),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]);
    await terminate(db);
  } catch (error) {
    console.warn("Firestore could not be stopped on sign-out.", error);
    return false;
  }
  try {
    await clearIndexedDbPersistence(db);
  } catch (error) {
    console.warn("The offline cache could not be cleared on sign-out.", error);
  }
  return true;
};

type EmulatorConnectionState = typeof globalThis & {
  __homeHubFirebaseEmulatorsConnected?: boolean;
};

const parseEmulatorHost = (value: string, fallbackPort: number) => {
  const normalized = value.replace(/^https?:\/\//, "");
  const separatorIndex = normalized.lastIndexOf(":");

  if (separatorIndex === -1) {
    return { host: normalized, port: fallbackPort };
  }

  const host = normalized.slice(0, separatorIndex);
  const port = Number(normalized.slice(separatorIndex + 1));
  return {
    host,
    port: Number.isInteger(port) ? port : fallbackPort,
  };
};

if (firebaseEmulatorMode) {
  // The demo- project check and the Auth emulator connection are in ./firebase-app.
  const emulatorState = globalThis as EmulatorConnectionState;
  if (!emulatorState.__homeHubFirebaseEmulatorsConnected) {
    const firestoreHost = process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST
      || process.env.FIRESTORE_EMULATOR_HOST
      || "127.0.0.1:8080";
    const firestore = parseEmulatorHost(firestoreHost, 8080);
    const storageHost = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST
      || process.env.FIREBASE_STORAGE_EMULATOR_HOST
      || "127.0.0.1:9199";
    const storageEmulator = parseEmulatorHost(storageHost, 9199);

    connectFirestoreEmulator(db, firestore.host, firestore.port);
    connectStorageEmulator(storage, storageEmulator.host, storageEmulator.port);
    emulatorState.__homeHubFirebaseEmulatorsConnected = true;
  }
}

export const getFirebaseMessaging = async () => {
  if (typeof window !== "undefined" && await isSupported()) {
    return getMessaging(app);
  }
  return null;
};
