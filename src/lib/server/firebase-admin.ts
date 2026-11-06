import 'server-only';

import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const projectId = process.env.GCLOUD_PROJECT
  || process.env.GOOGLE_CLOUD_PROJECT
  || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

if (process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === 'true' && !projectId?.startsWith('demo-')) {
  throw new Error('Firebase Admin emulator mode requires a demo- project ID.');
}

const adminApp = getApps()[0] || initializeApp(projectId ? { projectId } : undefined);

export const adminAuth = getAuth(adminApp);
export const adminDb = getFirestore(adminApp);

export const adminStorageBucket = () => {
  const bucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  return bucket ? getStorage(adminApp).bucket(bucket) : null;
};
