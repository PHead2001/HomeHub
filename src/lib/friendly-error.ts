/**
 * Plain-language error messages. Raw Firebase / network error text never reaches
 * users: pass any caught error through `friendlyError()` before showing it.
 *
 *   } catch (error) {
 *     toastError(error, 'Could not save the chore');     // from '@/hooks/use-toast'
 *   }
 *
 * Field problems (empty name, bad date) are not errors for this helper: show them
 * inline next to the field with `FieldError` / `FormMessage`. Toasts are only for
 * outcomes (saved, deleted, could not reach the server).
 */

export type FriendlyErrorKind =
  | 'permission-denied'
  | 'unavailable'
  | 'deadline-exceeded'
  | 'not-found'
  | 'resource-exhausted'
  | 'unauthenticated'
  | 'offline'
  | 'unknown';

export const FRIENDLY_ERROR_MESSAGES: Record<FriendlyErrorKind, string> = {
  'permission-denied': "You don't have permission to do that. Ask a household admin if you think you should.",
  unavailable: "We couldn't reach HomeHub. Check your connection and try again.",
  'deadline-exceeded': 'That took too long. Please try again.',
  'not-found': "We couldn't find that. It may have been moved or deleted.",
  'resource-exhausted': 'Too many requests right now. Wait a moment and try again.',
  unauthenticated: 'Your session has ended. Please sign in again.',
  offline: "You're offline. Reconnect and try again.",
  unknown: 'Something went wrong. Please try again.',
};

/** Short toast titles for each kind, for callers that have no title of their own. */
export const FRIENDLY_ERROR_TITLES: Record<FriendlyErrorKind, string> = {
  'permission-denied': 'Not allowed',
  unavailable: "Couldn't connect",
  'deadline-exceeded': 'Timed out',
  'not-found': 'Not found',
  'resource-exhausted': 'Slow down',
  unauthenticated: 'Signed out',
  offline: "You're offline",
  unknown: 'Something went wrong',
};

/**
 * Error codes (Firestore, Functions, Storage, Auth; with or without the
 * `service/` prefix) mapped to a kind. Anything not listed is `unknown`.
 */
const CODE_KINDS: Record<string, FriendlyErrorKind> = {
  'permission-denied': 'permission-denied',
  unauthorized: 'permission-denied', // storage/unauthorized
  'admin-restricted-operation': 'permission-denied',
  'operation-not-allowed': 'permission-denied',

  unavailable: 'unavailable',
  'network-request-failed': 'unavailable',
  'retry-limit-exceeded': 'unavailable',

  'deadline-exceeded': 'deadline-exceeded',
  timeout: 'deadline-exceeded',

  'not-found': 'not-found',
  'object-not-found': 'not-found',
  'bucket-not-found': 'not-found',
  'user-not-found': 'not-found',

  'resource-exhausted': 'resource-exhausted',
  'quota-exceeded': 'resource-exhausted',
  'too-many-requests': 'resource-exhausted',

  unauthenticated: 'unauthenticated',
  'user-token-expired': 'unauthenticated',
  'requires-recent-login': 'unauthenticated',
  'invalid-user-token': 'unauthenticated',
  'user-disabled': 'unauthenticated',
};

/** Kinds that may really be "the device is offline". */
const NETWORK_KINDS = new Set<FriendlyErrorKind>(['unavailable', 'deadline-exceeded', 'unknown']);

export type FriendlyErrorOptions = {
  /** Override the online check (defaults to `navigator.onLine` where it exists). */
  online?: boolean;
};

function readString(value: unknown, key: string): string | undefined {
  if (value && typeof value === 'object' && key in value) {
    const field = (value as Record<string, unknown>)[key];
    return typeof field === 'string' ? field : undefined;
  }
  return undefined;
}

function isOnline(options: FriendlyErrorOptions): boolean {
  if (typeof options.online === 'boolean') return options.online;
  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') return navigator.onLine;
  return true;
}

/** Classifies any thrown value (FirebaseError, FirestorePermissionError, fetch TypeError, string…). */
export function friendlyErrorKind(error: unknown, options: FriendlyErrorOptions = {}): FriendlyErrorKind {
  const kind = classify(error);
  if (NETWORK_KINDS.has(kind) && !isOnline(options)) return 'offline';
  return kind;
}

function classify(error: unknown): FriendlyErrorKind {
  if (error == null) return 'unknown';

  const name = readString(error, 'name');
  if (name === 'FirestorePermissionError') return 'permission-denied';

  const code = readString(error, 'code');
  if (code) {
    const bare = code.toLowerCase().split('/').pop() ?? '';
    if (bare in CODE_KINDS) return CODE_KINDS[bare];
  }

  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number') {
    if (status === 401) return 'unauthenticated';
    if (status === 403) return 'permission-denied';
    if (status === 404) return 'not-found';
    if (status === 408 || status === 504) return 'deadline-exceeded';
    if (status === 429) return 'resource-exhausted';
    if (status >= 500) return 'unavailable';
  }

  if (name === 'AbortError' || name === 'TimeoutError') return 'deadline-exceeded';

  const message = (typeof error === 'string' ? error : readString(error, 'message') ?? '').toLowerCase();
  if (!message) return 'unknown';
  if (/missing or insufficient permissions|permission[- ]denied/.test(message)) return 'permission-denied';
  if (/failed to fetch|networkerror|network request failed|load failed|client is offline|err_internet_disconnected/.test(message)) {
    return 'unavailable';
  }
  if (/deadline[- ]exceeded|timed? ?out/.test(message)) return 'deadline-exceeded';
  if (/quota|resource[- ]exhausted|too many requests/.test(message)) return 'resource-exhausted';
  if (/unauthenticated|not signed in|token (has )?expired/.test(message)) return 'unauthenticated';
  return 'unknown';
}

/** Plain-language message for any thrown value. Never returns raw error text. */
export function friendlyError(error: unknown, options: FriendlyErrorOptions = {}): string {
  return FRIENDLY_ERROR_MESSAGES[friendlyErrorKind(error, options)];
}
