/** Matches the Firestore rule for users/{email}/private/push. */
export const MAX_PUSH_TOKENS = 20;

const tokenList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((token): token is string => typeof token === 'string' && token.length > 0) : [];

/**
 * The token list to store after this device subscribes. Stored tokens are kept
 * in the order they were added (oldest first); legacy profile tokens follow,
 * then this device's token goes last. Duplicates are removed (a re-subscribing
 * device moves to the end), and when the list would exceed the rules' cap the
 * oldest tokens are dropped, so subscribing never fails on the cap.
 */
export function nextPushTokens(
  storedTokens: unknown,
  legacyTokens: unknown,
  deviceToken: string,
  max: number = MAX_PUSH_TOKENS,
): string[] {
  const others = [...new Set([...tokenList(storedTokens), ...tokenList(legacyTokens)])]
    .filter(token => token !== deviceToken);
  const tokens = deviceToken ? [...others, deviceToken] : others;
  return tokens.slice(Math.max(0, tokens.length - Math.max(1, max)));
}

/** A stored token list without one token (the device's previous token after a refresh). */
export const withoutPushToken = (tokens: unknown, token: string | null | undefined): string[] =>
  tokenList(tokens).filter(stored => stored !== token);

/**
 * This device's push registration, remembered on the device
 * (`localStorage["homehub.push-device"]`) so sign-out can remove the token from
 * the account without asking FCM for it. `email` is the account whose private
 * push document holds `token`; an empty `email` means a sign-out could not finish
 * removing the registration, so the token must be replaced before anyone uses
 * push on this device again. `at` is when the token was last confirmed with FCM.
 */
export const PUSH_DEVICE_KEY = 'homehub.push-device';
export type PushDeviceRecord = { v: 1; token: string; email: string; at: number };
type DeviceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** FCM refreshes web tokens weekly; a record older than this is confirmed again. */
export const PUSH_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** Sign-out waits at most this long for the push registration to be removed. */
export const PUSH_SIGN_OUT_TIMEOUT_MS = 2000;

export function readPushDevice(storage: DeviceStorage | null): PushDeviceRecord | null {
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(PUSH_DEVICE_KEY) ?? 'null') as PushDeviceRecord | null;
    if (!parsed || parsed.v !== 1 || typeof parsed.token !== 'string' || !parsed.token || typeof parsed.email !== 'string') return null;
    return { v: 1, token: parsed.token, email: parsed.email, at: typeof parsed.at === 'number' ? parsed.at : 0 };
  } catch {
    return null;
  }
}

export function writePushDevice(storage: DeviceStorage | null, token: string, email: string, at: number): void {
  if (!storage || !token) return;
  try {
    const record: PushDeviceRecord = { v: 1, token, email, at };
    storage.setItem(PUSH_DEVICE_KEY, JSON.stringify(record));
  } catch {
    // Storage full or blocked: the next sign-in registers this device again.
  }
}

export function clearPushDevice(storage: DeviceStorage | null): void {
  try {
    storage?.removeItem(PUSH_DEVICE_KEY);
  } catch {
    // Storage blocked: nothing was saved either.
  }
}

/**
 * What a signed-in session does about push on this device, without asking:
 * - `none`: permission is not granted (never prompt silently), nobody is signed
 *   in, or this account already holds this device's recently confirmed token;
 * - `register`: permission is granted and no token is remembered (after a
 *   sign-out, or a device subscribed before the record existed), or the
 *   account's token is due its weekly confirmation;
 * - `replace`: the remembered token belongs to another account or to an
 *   unfinished sign-out; it is revoked first so the new account gets a token the
 *   previous account never held.
 */
export type PushSignInAction = 'none' | 'register' | 'replace';
export function pushSignInAction(input: {
  permission: NotificationPermission | 'unsupported';
  email: string | null | undefined;
  record: PushDeviceRecord | null;
  now: number;
}): PushSignInAction {
  const { permission, email, record, now } = input;
  if (permission !== 'granted' || !email) return 'none';
  if (!record) return 'register';
  if (record.email !== email) return 'replace';
  return now - record.at >= PUSH_REFRESH_MS ? 'register' : 'none';
}

/**
 * What sign-out does about push on this device. Nothing when no token is
 * remembered (never subscribed, unsupported browser, already removed). The token
 * is removed from the account only when that account is the one signing out; the
 * device registration is revoked whenever a token is remembered. Offline, nothing
 * can reach the server, so the work is skipped and the token is left for
 * replacement at the next sign-in (`deferred`).
 */
export type PushSignOutPlan = { removeFromAccount: boolean; revoke: boolean; deferred: boolean };
export function pushSignOutPlan(record: PushDeviceRecord | null, email: string | null | undefined, offline: boolean): PushSignOutPlan {
  if (!record) return { removeFromAccount: false, revoke: false, deferred: false };
  if (offline) return { removeFromAccount: false, revoke: false, deferred: true };
  return { removeFromAccount: Boolean(email) && record.email === email, revoke: true, deferred: false };
}

/**
 * The device record after a sign-out attempt: gone when the registration was
 * fully removed, otherwise kept without an account so the next sign-in replaces
 * the token instead of trusting it.
 */
export function settlePushSignOut(storage: DeviceStorage | null, record: PushDeviceRecord, removed: boolean): void {
  if (removed) clearPushDevice(storage);
  else writePushDevice(storage, record.token, '', record.at);
}

/**
 * Waits for `work` at most `ms`. Never rejects: resolves to the work's value, or
 * to `fallback` when it fails (reported through `onError`) or takes too long.
 */
export function settleWithin<T>(work: () => Promise<T>, ms: number, fallback: T, onError?: (error: unknown) => void): Promise<T> {
  return new Promise<T>(resolve => {
    const timer = setTimeout(() => {
      onError?.(new Error(`Timed out after ${ms} ms.`));
      resolve(fallback);
    }, ms);
    const finish = (value: T) => {
      clearTimeout(timer);
      resolve(value);
    };
    let running: Promise<T>;
    try {
      running = work();
    } catch (error) {
      onError?.(error);
      finish(fallback);
      return;
    }
    running.then(finish, (error: unknown) => {
      onError?.(error);
      finish(fallback);
    });
  });
}
