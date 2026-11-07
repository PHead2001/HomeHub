/**
 * The service worker's push-link check, kept here as a pure function so it can
 * be unit tested. `route.ts` embeds its source (`safePushLink.toString()`) in
 * the worker script, so it must stay self-contained: no imports, no helpers
 * from outside its own body, and plain JavaScript once types are stripped.
 *
 * A link opens only as an in-app path on this origin. Anything else becomes
 * `/`. It mirrors the server's `safeDeepLink` and goes further, because this is
 * the last check before `clients.openWindow`:
 * - it must start with exactly one `/` (no `//host`, no `/\host`);
 * - no control characters or whitespace other than a plain space, since URL
 *   parsing drops tabs and newlines (`/\t/evil.com` would become `//evil.com`);
 * - no backslashes and no `..` or `.` path segments, raw or percent-encoded;
 * - it must still resolve to the same origin.
 */
export const safePushLink = (link: unknown): string => {
  if (typeof link !== 'string') return '/';
  const trimmed = link.trim();
  if (trimmed.length === 0 || trimmed.length > 300) return '/';
  if (!/^\/(?![/\\])/.test(trimmed)) return '/';
  if (/[\u0000-\u001f\u007f\\]/.test(trimmed)) return '/';
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(trimmed.split(/[?#]/)[0]);
  } catch {
    return '/';
  }
  if (/[\u0000-\u001f\u007f\\]/.test(decodedPath)) return '/';
  if (decodedPath.split('/').some(segment => segment === '..' || segment === '.')) return '/';
  if (decodedPath.startsWith('//')) return '/';
  try {
    const base = 'https://homehub.invalid';
    const resolved = new URL(trimmed, base);
    if (resolved.origin !== base) return '/';
  } catch {
    return '/';
  }
  return trimmed;
};
