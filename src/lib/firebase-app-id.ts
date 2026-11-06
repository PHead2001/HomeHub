/**
 * Firebase web app IDs have the form `1:<project number>:web:<hash>`. The value
 * configured on App Hosting was missing the leading `1:`; Firestore and Auth
 * tolerate that, but App Check rejects it ("Invalid App ID"), so every token
 * exchange failed. Restore the prefix when it is missing.
 */
export const normalizeFirebaseAppId = (value: string | undefined) =>
  value && /^\d+:web:[0-9a-f]+$/i.test(value) ? `1:${value}` : value;
