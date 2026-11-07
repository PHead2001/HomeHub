// src/lib/firebase-app.ts
// The Firebase app and Auth only. This is all the root layout (AuthProvider)
// loads up front, so signed-out pages never download Firestore, Storage,
// Messaging or App Check. Data access lives in `@/lib/firebase`, which starts App
// Check before creating Firestore and Storage; import it (dynamically from
// shell code) only where data is read or written.
// Guarded by eslint `no-restricted-imports`: this file, auth-context.tsx and
// layout.tsx must not import Firestore, Storage, Messaging or `@/lib/firebase`.
import { initializeApp, getApps, getApp, type FirebaseOptions } from "firebase/app";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { normalizeFirebaseAppId } from "./firebase-app-id";

export const firebaseConfig: FirebaseOptions = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: normalizeFirebaseAppId(process.env.NEXT_PUBLIC_FIREBASE_APP_ID),
};

export const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export const firebaseEmulatorMode = process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === "true";

export const auth = getAuth(app);

type AuthEmulatorState = typeof globalThis & { __homeHubAuthEmulatorConnected?: boolean };

if (firebaseEmulatorMode) {
  if (!firebaseConfig.projectId?.startsWith("demo-")) {
    throw new Error("Firebase emulator mode requires a demo- project ID.");
  }
  const state = globalThis as AuthEmulatorState;
  if (!state.__homeHubAuthEmulatorConnected) {
    const authHost = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST
      || process.env.FIREBASE_AUTH_EMULATOR_HOST
      || "127.0.0.1:9099";
    connectAuthEmulator(auth, `http://${authHost.replace(/^https?:\/\//, "")}`, { disableWarnings: true });
    state.__homeHubAuthEmulatorConnected = true;
  }
}
