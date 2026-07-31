// src/lib/firebase.ts
import { initializeApp, getApps, getApp, type FirebaseOptions } from "firebase/app";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { getMessaging, isSupported } from "firebase/messaging";
import { connectStorageEmulator, getStorage } from "firebase/storage";

export const firebaseConfig: FirebaseOptions = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID
};

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);

export const firebaseEmulatorMode = process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === "true";

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
  if (!firebaseConfig.projectId?.startsWith("demo-")) {
    throw new Error("Firebase emulator mode requires a demo- project ID.");
  }

  const emulatorState = globalThis as EmulatorConnectionState;
  if (!emulatorState.__homeHubFirebaseEmulatorsConnected) {
    const authHost = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST
      || process.env.FIREBASE_AUTH_EMULATOR_HOST
      || "127.0.0.1:9099";
    const firestoreHost = process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST
      || process.env.FIRESTORE_EMULATOR_HOST
      || "127.0.0.1:8080";
    const firestore = parseEmulatorHost(firestoreHost, 8080);
    const storageHost = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST
      || process.env.FIREBASE_STORAGE_EMULATOR_HOST
      || "127.0.0.1:9199";
    const storageEmulator = parseEmulatorHost(storageHost, 9199);

    connectAuthEmulator(auth, `http://${authHost.replace(/^https?:\/\//, "")}`, {
      disableWarnings: true,
    });
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
