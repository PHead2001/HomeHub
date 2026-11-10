// Credentials for the scripts in this folder.
//
// - Default: Application Default Credentials (`gcloud auth application-default
//   login`, or GOOGLE_APPLICATION_CREDENTIALS), like
//   scripts/deploy/verify-live-rules.mjs.
// - `--firebase-tools-login`: the account you signed in with `firebase login`.
//   firebase-tools is loaded from `--firebase-tools-from <dir or package.json>`,
//   else HOMEHUB_FIREBASE_TOOLS_FROM, else this checkout (it is a dev
//   dependency). Access tokens are fetched on demand and never printed.
import { createRequire } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationDefault } from 'firebase-admin/app';

const CLOUD_PLATFORM = 'https://www.googleapis.com/auth/cloud-platform';

const requireFrom = location => {
  const base = location
    ? resolve(location)
    : resolve(fileURLToPath(new URL('../../package.json', import.meta.url)));
  const anchor = existsSync(base) && statSync(base).isDirectory() ? join(base, 'package.json') : base;
  return createRequire(anchor);
};

function firebaseToolsCredential(location) {
  let auth;
  try {
    auth = requireFrom(location)('firebase-tools/lib/auth');
  } catch {
    throw new Error('firebase-tools was not found. Pass --firebase-tools-from <dir> or set HOMEHUB_FIREBASE_TOOLS_FROM.');
  }
  const account = auth.getGlobalDefaultAccount();
  const refreshToken = account?.tokens?.refresh_token;
  if (!refreshToken) throw new Error('No firebase-tools login found. Run `firebase login` first.');
  let cached = null;
  return {
    async getAccessToken() {
      if (cached && cached.expiresAt - Date.now() > 60_000) {
        return { access_token: cached.accessToken, expires_in: Math.floor((cached.expiresAt - Date.now()) / 1000) };
      }
      const token = await auth.getAccessToken(refreshToken, [CLOUD_PLATFORM]);
      if (!token?.access_token) throw new Error('firebase-tools did not return an access token.');
      // firebase-tools returns expires_at (ms); some versions also expires_in (s).
      const fromExpiresAt = (Number(token.expires_at) - Date.now()) / 1000;
      const expiresIn = Number(token.expires_in) > 0
        ? Number(token.expires_in)
        : fromExpiresAt > 60 ? Math.floor(fromExpiresAt) : 3000;
      cached = { accessToken: token.access_token, expiresAt: Date.now() + expiresIn * 1000 };
      return { access_token: token.access_token, expires_in: expiresIn };
    },
  };
}

/**
 * A Firestore client for the parsed options, and a label to print.
 *
 * firebase-admin's Firestore only accepts a service-account or Application
 * Default credential, so the firebase-tools login cannot go through
 * initializeApp(). That path builds @google-cloud/firestore (the copy
 * firebase-admin itself uses, so FieldValue and FieldPath from
 * 'firebase-admin/firestore' work with it) on an OAuth client whose refresh
 * handler asks firebase-tools for a token when one is needed.
 * @param {{ projectId: string, auth: 'adc' | 'firebase-tools', firebaseToolsFrom: string | null }} options
 */
export async function opsFirestore(options) {
  const { projectId } = options;
  if (options.auth === 'firebase-tools') {
    const source = firebaseToolsCredential(options.firebaseToolsFrom);
    const local = requireFrom(null);
    const firestorePath = local.resolve('@google-cloud/firestore');
    const { Firestore } = local(firestorePath);
    const { OAuth2Client } = createRequire(firestorePath)('google-auth-library');
    const authClient = firebaseToolsAuthClient(source, OAuth2Client);
    return { db: new Firestore({ projectId, authClient }), label: 'firebase-tools login' };
  }
  const { getFirestore } = await import('firebase-admin/firestore');
  return { db: getFirestore(await adcApp(projectId)), label: 'Application Default Credentials' };
}

const adcApp = async projectId => {
  const { getApps, initializeApp } = await import('firebase-admin/app');
  return getApps()[0] ?? initializeApp({ credential: applicationDefault(), projectId });
};

// An OAuth client whose refresh handler asks firebase-tools for a token.
const firebaseToolsAuthClient = (source, OAuth2Client) => {
  const authClient = new OAuth2Client();
  authClient.refreshHandler = async () => {
    const token = await source.getAccessToken();
    return { access_token: token.access_token, expiry_date: Date.now() + token.expires_in * 1000 };
  };
  return authClient;
};

/**
 * A Cloud Storage client for the parsed options (same credentials as
 * opsFirestore). Returns a function that opens a bucket by name.
 * @param {{ projectId: string, auth: 'adc' | 'firebase-tools', firebaseToolsFrom: string | null }} options
 * @returns {Promise<(name: string) => import('@google-cloud/storage').Bucket>}
 */
export async function opsStorage(options) {
  const { projectId } = options;
  if (options.auth === 'firebase-tools') {
    const source = firebaseToolsCredential(options.firebaseToolsFrom);
    const local = requireFrom(null);
    const storagePath = local.resolve('@google-cloud/storage');
    const { Storage } = local(storagePath);
    const { OAuth2Client } = createRequire(storagePath)('google-auth-library');
    const storage = new Storage({ projectId, authClient: firebaseToolsAuthClient(source, OAuth2Client) });
    return name => storage.bucket(name);
  }
  const { getStorage } = await import('firebase-admin/storage');
  const storage = getStorage(await adcApp(projectId));
  return name => storage.bucket(name);
}
