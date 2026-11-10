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
  doc,
  getDocFromCache,
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
export type LocalPersistence = "durable" | "memory" | "unknown";

/**
 * Whether writes this tab queues survive a reload (SH-4a). `durable` is set only
 * once the persistent IndexedDB cache has actually started (see
 * `confirmPersistentCache`); `memory` when this build or runtime uses the memory
 * cache; `unknown` until then, or when it cannot be told (for example a browser
 * without `indexedDB.databases()`, or a cache Firestore silently replaced with
 * memory). Only `durable` lets the UI say "Saved on this device, will sync".
 * A live binding: read it at the time of the write, never copy it at import.
 */
export let localPersistence: LocalPersistence = "unknown";

/** Function form of {@link localPersistence}, for code that takes it as a dependency. */
export const getLocalPersistence = (): LocalPersistence => localPersistence;

let persistentCacheRequested = false;

const createFirestore = (): Firestore => {
  // Emulator runs keep the memory cache: the E2E suite pins the browser clock, and
  // the persistent cache rejects server timestamps that look like they are in the
  // future, logging errors on every snapshot. Production devices have real clocks.
  if (typeof window === "undefined" || firebaseEmulatorMode
      || process.env.NEXT_PUBLIC_FIRESTORE_MEMORY_CACHE === "true") {
    localPersistence = "memory";
    return getFirestore(app);
  }
  try {
    const firestore = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
    persistentCacheRequested = true;
    return firestore;
  } catch {
    // Already initialized (development hot reload) or the cache cannot be created:
    // which cache the existing instance uses is not known here.
    return getFirestore(app);
  }
};

export const db = createFirestore();

/**
 * Asking for the persistent cache is not proof it started: Firestore falls back to
 * memory (with a console warning) when IndexedDB cannot be opened, for example in
 * some private modes or when storage is blocked. A cache read starts the client;
 * afterwards the cache's IndexedDB database (`firestore/[DEFAULT]/<project>/main`)
 * must exist for `localPersistence` to become `durable`.
 */
const confirmPersistentCache = async () => {
  if (!persistentCacheRequested || typeof indexedDB === "undefined") return;
  // The probe document never exists; the read only makes the client start.
  await getDocFromCache(doc(db, "__homehub", "cache-probe")).catch(() => undefined);
  const listDatabases = (indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> }).databases;
  if (typeof listDatabases !== "function") return;
  const databases = await listDatabases.call(indexedDB).catch(() => null);
  if (!databases) return;
  const projectId = firebaseConfig.projectId;
  const started = databases.some(({ name }) => typeof name === "string"
    && name.startsWith("firestore/") && name.endsWith("/main")
    && (!projectId || name.includes(`/${projectId}/`)));
  localPersistence = started ? "durable" : "memory";
};

if (typeof window !== "undefined") void confirmPersistentCache();
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
