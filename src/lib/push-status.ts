/**
 * What Profile's push card can offer on this device (NO-5, NO-17). Pure: the
 * caller reads the browser and storage.
 */

/** An iPhone or iPad, including iPadOS reporting itself as a Mac. */
export function isIOSDevice(input: { userAgent: string; platform?: string; maxTouchPoints?: number }): boolean {
  if (/iPad|iPhone|iPod/.test(input.userAgent)) return true;
  return input.platform === 'MacIntel' && (input.maxTouchPoints ?? 0) > 1;
}

export type PushSupport = 'supported' | 'ios-install' | 'unsupported';

/**
 * Push needs the Notification API, a service worker and the Push API. Safari on
 * iPhone and iPad offers them only to a web app added to the Home Screen and
 * opened from there, so a browser tab gets instructions instead of a dead end.
 */
export function pushSupport(input: {
  hasNotification: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  isIOS: boolean;
  standalone: boolean;
}): PushSupport {
  if (input.hasNotification && input.hasServiceWorker && input.hasPushManager) return 'supported';
  return input.isIOS && !input.standalone ? 'ios-install' : 'unsupported';
}

/**
 * - `ios-install`: add HomeHub to the Home Screen first;
 * - `unsupported`: this browser cannot receive pushes;
 * - `denied`: blocked in the browser's settings;
 * - `ask`: not asked yet (explain, then ask);
 * - `off`: turned off on this device by the member (permission stays granted);
 * - `checking`: permission granted, registration not checked yet;
 * - `registered`: this device's token is stored for the account;
 * - `reconnect`: permission granted but the account does not hold this device's token.
 */
export type PushCardState = 'ios-install' | 'unsupported' | 'denied' | 'ask' | 'off' | 'checking' | 'registered' | 'reconnect';

export function pushCardState(input: {
  support: PushSupport;
  permission: NotificationPermission | 'unsupported';
  optedOut: boolean;
  registered: boolean | null;
}): PushCardState {
  if (input.support !== 'supported') return input.support;
  if (input.permission === 'denied') return 'denied';
  if (input.permission !== 'granted') return 'ask';
  if (input.optedOut) return 'off';
  if (input.registered === null) return 'checking';
  return input.registered ? 'registered' : 'reconnect';
}

/**
 * NO-5: whether this device's remembered token is missing from the account's
 * stored list (removed by the server after FCM reported it invalid, or never
 * written), so it must be registered again.
 */
export function pushTokenMissing(storedTokens: unknown, token: string | null | undefined): boolean {
  if (!token) return true;
  return !(Array.isArray(storedTokens) && storedTokens.includes(token));
}
