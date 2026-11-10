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
 * What sign-out's cleanup does about push on this device. The token is removed
 * from the account only when a token is remembered and that account is the one
 * signing out. The device registration is revoked in every case, also without a
 * record: a subscription can exist without one (a device subscribed before the
 * record existed, or a registration that sign-out interrupted). Offline, nothing
 * can reach the server, so the work is skipped and left for the next sign-in
 * (`deferred`).
 */
export type PushSignOutPlan = { removeFromAccount: boolean; revoke: boolean; deferred: boolean };
export function pushSignOutPlan(record: PushDeviceRecord | null, email: string | null | undefined, offline: boolean): PushSignOutPlan {
  if (offline) return { removeFromAccount: false, revoke: false, deferred: true };
  return { removeFromAccount: Boolean(record) && Boolean(email) && record?.email === email, revoke: true, deferred: false };
}

/** Stands in for the token when a cleanup is unfinished and no token is remembered. */
export const PUSH_UNKNOWN_TOKEN = 'unknown';

/**
 * Marks this device's push cleanup as unfinished: the remembered token loses its
 * account, or, with no token remembered, a placeholder is stored. Either way the
 * next sign-in revokes the device registration before registering.
 */
export function markPushSignOutUnfinished(storage: DeviceStorage | null): void {
  const record = readPushDevice(storage);
  if (record) writePushDevice(storage, record.token, '', record.at);
  else writePushDevice(storage, PUSH_UNKNOWN_TOKEN, '', 0);
}

/**
 * Sign-out gate for push registrations. A registration takes a pass when it
 * starts and asks `allows(pass)` after every step that takes time; once sign-out
 * has begun, no pass taken earlier is ever valid again (also after `end`), and
 * none is handed out until `end`. Registrations are tracked so sign-out can wait
 * for them (`drain`). No Firebase here: the auth provider imports this statically.
 */
export function createPushSignOutGate() {
  let epoch = 0;
  let signingOut = false;
  const pending = new Set<Promise<unknown>>();
  return {
    /** A pass for a registration starting now, or null while sign-out is running. */
    pass: (): number | null => (signingOut ? null : epoch),
    allows: (pass: number | null): boolean => pass !== null && !signingOut && pass === epoch,
    /** Sign-out started: every pass handed out so far is void. */
    begin(): void {
      signingOut = true;
      epoch += 1;
    },
    /** Sign-out is over (signed out in place, or it failed): registrations may start again. */
    end(): void {
      signingOut = false;
    },
    track<T>(work: Promise<T>): Promise<T> {
      pending.add(work);
      const done = () => { pending.delete(work); };
      work.then(done, done);
      return work;
    },
    busy: (): boolean => pending.size > 0,
    /** Resolves when every registration running now has finished or failed. */
    drain: (): Promise<void> => Promise.allSettled([...pending]).then(() => undefined),
  };
}
export type PushSignOutGate = ReturnType<typeof createPushSignOutGate>;
export const pushSignOutGate = createPushSignOutGate();

/**
 * What a registration does after a step, given whether its pass is still valid:
 * - `continue`: no sign-out began;
 * - `stop`: sign-out began before a token was requested: nothing to clean up;
 * - `discard`: a token was obtained but not stored: revoke the device registration;
 * - `undo`: the token was already written to the account: remove it from the
 *   account and revoke the device registration.
 */
export type PushRegistrationStage = 'start' | 'token' | 'written';
export type PushRegistrationStep = 'continue' | 'stop' | 'discard' | 'undo';
export function pushRegistrationStep(stage: PushRegistrationStage, allowed: boolean): PushRegistrationStep {
  if (allowed) return 'continue';
  return stage === 'start' ? 'stop' : stage === 'token' ? 'discard' : 'undo';
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

/**
 * Sign-out's push cleanup, as one time budget. The caller has already called
 * `gate.begin()`. Nothing is loaded when this device has no remembered token, no
 * registration in flight and no push subscription (`hasSubscription`). Otherwise
 * `cleanup` runs (it loads the Firebase module, waits for registrations in flight
 * and removes the registration; true when fully removed). Loading counts toward
 * the budget. Never rejects; when the cleanup fails or is not done after `ms`,
 * sign-out carries on and the device is marked so the next sign-in finishes it.
 */
export type PushSignOutResult = 'nothing' | 'removed' | 'unfinished';
export async function runPushSignOut(input: {
  storage: DeviceStorage | null;
  hasSubscription: () => Promise<boolean>;
  cleanup: () => Promise<boolean>;
  gate?: Pick<PushSignOutGate, 'busy'>;
  ms?: number;
  onError?: (error: unknown) => void;
}): Promise<PushSignOutResult> {
  const { storage, hasSubscription, cleanup, gate = pushSignOutGate, ms = PUSH_SIGN_OUT_TIMEOUT_MS, onError } = input;
  const result = await settleWithin<PushSignOutResult>(async () => {
    if (!readPushDevice(storage) && !gate.busy() && !(await hasSubscription())) return 'nothing';
    return (await cleanup()) ? 'removed' : 'unfinished';
  }, ms, 'unfinished', onError);
  if (result === 'unfinished') markPushSignOutUnfinished(storage);
  return result;
}
